use crate::state::MangoAccountRefMut;
use crate::{
    error::*,
    state::{orderbook::bookside::*, EventQueue, PerpMarket},
};
use anchor_lang::prelude::*;
use bytemuck::cast;
use fixed::types::I80F48;
use std::cell::RefMut;

use super::*;

/// Drop at most this many expired orders from a BookSide when trying to match orders.
/// This exists as a guard against excessive compute use.
const DROP_EXPIRED_ORDER_LIMIT: usize = 5;

pub struct Orderbook<'a> {
    pub bids: RefMut<'a, BookSide>,
    pub asks: RefMut<'a, BookSide>,
}

impl<'a> Orderbook<'a> {
    pub fn init(&mut self) {
        self.bids.nodes.order_tree_type = OrderTreeType::Bids.into();
        self.asks.nodes.order_tree_type = OrderTreeType::Asks.into();
    }

    pub fn bookside_mut(&mut self, side: Side) -> &mut BookSide {
        match side {
            Side::Bid => &mut self.bids,
            Side::Ask => &mut self.asks,
        }
    }

    pub fn bookside(&self, side: Side) -> &BookSide {
        match side {
            Side::Bid => &self.bids,
            Side::Ask => &self.asks,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new_order(
        &mut self,
        order: Order,
        perp_market: &mut PerpMarket,
        event_queue: &mut EventQueue,
        oracle_price: I80F48,
        mango_account: &mut MangoAccountRefMut,
        mango_account_pk: &Pubkey,
        now_ts: u64,
        mut limit: u8,
    ) -> std::result::Result<Option<u128>, Error> {
        let side = order.side;
        let other_side = side.invert_side();
        let market = perp_market;
        let oracle_price_lots = market.native_price_to_lot(oracle_price);
        let post_only = order.is_post_only();
        let mut post_target = order.post_target();
        let (price_lots, price_data) = order.price(now_ts, oracle_price_lots, self)?;

        // generate new order id
        let order_id = market.gen_order_id(side, price_data);

        // IOC orders have a fee penalty applied regardless of match
        if order.needs_penalty_fee() {
            apply_penalty(market, mango_account)?;
        }

        let perp_position = mango_account.perp_position_mut(market.perp_market_index)?;

        // Iterate through book and match against this new order.
        //
        // Any changes to matching orders on the other side of the book are collected in
        // matched_changes/matched_deletes and then applied after this loop.
        let mut remaining_base_lots = order.max_base_lots;
        let mut remaining_quote_lots = order.max_quote_lots;
        let mut matched_order_changes: Vec<(BookSideOrderHandle, i64)> = vec![];
        let mut matched_order_deletes: Vec<(BookSideOrderTree, u128)> = vec![];
        let mut number_of_dropped_expired_orders = 0;
        let opposing_bookside = self.bookside_mut(other_side);
        for best_opposing in opposing_bookside.iter_all_including_invalid(now_ts, oracle_price_lots)
        {
            if remaining_base_lots == 0 || remaining_quote_lots == 0 {
                break;
            }

            if !best_opposing.is_valid() {
                // Remove the order from the book unless we've done that enough
                if number_of_dropped_expired_orders < DROP_EXPIRED_ORDER_LIMIT {
                    number_of_dropped_expired_orders += 1;
                    let event = OutEvent::new(
                        other_side,
                        best_opposing.node.owner_slot,
                        now_ts,
                        event_queue.header.seq_num,
                        best_opposing.node.owner,
                        best_opposing.node.quantity,
                    );
                    event_queue.push_back(cast(event)).unwrap();
                    matched_order_deletes
                        .push((best_opposing.handle.order_tree, best_opposing.node.key));
                }
                continue;
            }

            let best_opposing_price = best_opposing.price_lots;

            if !side.is_price_within_limit(best_opposing_price, price_lots) {
                break;
            } else if post_only {
                msg!("Order could not be placed due to PostOnly");
                post_target = None;
                break; // return silently to not fail other instructions in tx
            } else if limit == 0 {
                msg!("Order matching limit reached");
                post_target = None;
                break;
            }

            let max_match_by_quote = remaining_quote_lots / best_opposing_price;
            let match_base_lots = remaining_base_lots
                .min(best_opposing.node.quantity)
                .min(max_match_by_quote);

            let match_quote_lots = match_base_lots * best_opposing_price;
            remaining_base_lots -= match_base_lots;
            remaining_quote_lots -= match_quote_lots;
            assert!(remaining_quote_lots >= 0);

            let new_best_opposing_quantity = best_opposing.node.quantity - match_base_lots;
            let maker_out = new_best_opposing_quantity == 0;
            if maker_out {
                matched_order_deletes
                    .push((best_opposing.handle.order_tree, best_opposing.node.key));
            } else {
                matched_order_changes.push((best_opposing.handle, new_best_opposing_quantity));
            }

            let fill = FillEvent::new(
                side,
                maker_out,
                best_opposing.node.owner_slot,
                now_ts,
                event_queue.header.seq_num,
                best_opposing.node.owner,
                best_opposing.node.client_order_id,
                market.maker_fee,
                best_opposing.node.timestamp,
                *mango_account_pk,
                order.client_order_id,
                market.taker_fee,
                best_opposing_price,
                match_base_lots,
            );
            event_queue.push_back(cast(fill)).unwrap();
            limit -= 1;
        }
        let total_quote_lots_taken = order.max_quote_lots - remaining_quote_lots;
        let total_base_lots_taken = order.max_base_lots - remaining_base_lots;
        assert!(total_quote_lots_taken >= 0);
        assert!(total_base_lots_taken >= 0);

        // Record the taker trade in the account already, even though it will only be
        // realized when the fill event gets executed
        if total_quote_lots_taken > 0 || total_base_lots_taken > 0 {
            perp_position.add_taker_trade(side, total_base_lots_taken, total_quote_lots_taken);
            apply_fees(market, mango_account, total_quote_lots_taken)?;
        }

        // Apply changes to matched asks (handles invalidate on delete!)
        for (handle, new_quantity) in matched_order_changes {
            opposing_bookside
                .node_mut(handle.node)
                .unwrap()
                .as_leaf_mut()
                .unwrap()
                .quantity = new_quantity;
        }
        for (component, key) in matched_order_deletes {
            let _removed_leaf = opposing_bookside.remove_by_key(component, key).unwrap();
        }

        //
        // Place remainder on the book if requested
        //

        // If there are still quantity unmatched, place on the book
        let book_base_quantity = remaining_base_lots.min(remaining_quote_lots / price_lots);
        if book_base_quantity <= 0 {
            post_target = None;
        }
        if post_target.is_some() {
            // price limit check computed lazily to save CU on average
            let native_price = market.lot_to_native_price(price_lots);
            if !market.inside_price_limit(side, native_price, oracle_price) {
                msg!("Posting on book disallowed due to price limits, order price {:?}, oracle price {:?}", native_price, oracle_price);
                post_target = None;
            }
        }
        if let Some(order_tree_target) = post_target {
            let bookside = self.bookside_mut(side);

            // Drop an expired order if possible
            if let Some(expired_order) = bookside.remove_one_expired(order_tree_target, now_ts) {
                let event = OutEvent::new(
                    side,
                    expired_order.owner_slot,
                    now_ts,
                    event_queue.header.seq_num,
                    expired_order.owner,
                    expired_order.quantity,
                );
                event_queue.push_back(cast(event)).unwrap();
            }

            if bookside.is_full() {
                // If this bid is higher than lowest bid, boot that bid and insert this one
                let (worst_order, worst_price) =
                    bookside.remove_worst(now_ts, oracle_price_lots).unwrap();
                // MangoErrorCode::OutOfSpace
                require!(
                    side.is_price_better(price_lots, worst_price),
                    MangoError::SomeError
                );
                let event = OutEvent::new(
                    side,
                    worst_order.owner_slot,
                    now_ts,
                    event_queue.header.seq_num,
                    worst_order.owner,
                    worst_order.quantity,
                );
                event_queue.push_back(cast(event)).unwrap();
            }

            let owner_slot = mango_account.perp_next_order_slot()?;
            let new_order = LeafNode::new(
                owner_slot as u8,
                order_id,
                *mango_account_pk,
                book_base_quantity,
                now_ts,
                PostOrderType::Limit, // TODO: Support order types? needed?
                order.time_in_force,
                order.peg_limit(),
                order.client_order_id,
            );
            let _result = bookside.insert_leaf(order_tree_target, &new_order)?;

            // TODO OPT remove if PlacePerpOrder needs more compute
            msg!(
                "{} on book order_id={} quantity={} price={}",
                match side {
                    Side::Bid => "bid",
                    Side::Ask => "ask",
                },
                order_id,
                book_base_quantity,
                price_lots
            );

            mango_account.add_perp_order(
                market.perp_market_index,
                side,
                order_tree_target,
                &new_order,
                order.client_order_id,
            )?;
        }

        if post_target.is_some() {
            Ok(Some(order_id))
        } else {
            Ok(None)
        }
    }

    /// Cancels up to `limit` orders that are listed on the mango account for the given perp market.
    /// Optionally filters by `side_to_cancel_option`.
    /// The orders are removed from the book and from the mango account open order list.
    pub fn cancel_all_orders(
        &mut self,
        mango_account: &mut MangoAccountRefMut,
        perp_market: &mut PerpMarket,
        mut limit: u8,
        side_to_cancel_option: Option<Side>,
    ) -> Result<()> {
        for i in 0..mango_account.header.perp_oo_count() {
            let oo = mango_account.perp_order_by_raw_index(i);
            if !oo.is_active_for_market(perp_market.perp_market_index) {
                continue;
            }

            let order_side_and_tree = oo.side_and_tree();
            if let Some(side_to_cancel) = side_to_cancel_option {
                if side_to_cancel != order_side_and_tree.side() {
                    continue;
                }
            }

            let order_id = oo.id;

            let cancel_result =
                self.cancel_order(mango_account, order_id, order_side_and_tree, None);
            if cancel_result.is_anchor_error_with_code(MangoError::PerpOrderIdNotFound.into()) {
                // It's possible for the order to be filled or expired already.
                // There will be an event on the queue, the perp order slot is freed once
                // it is processed.
                msg!(
                    "order {} was not found on orderbook, expired or filled already",
                    order_id
                );
            } else {
                cancel_result?;
            }

            limit -= 1;
            if limit == 0 {
                break;
            }
        }

        Ok(())
    }

    /// Cancels an order on a side, removing it from the book and the mango account orders list
    pub fn cancel_order(
        &mut self,
        mango_account: &mut MangoAccountRefMut,
        order_id: u128,
        side_and_tree: SideAndOrderTree,
        expected_owner: Option<Pubkey>,
    ) -> Result<LeafNode> {
        let side = side_and_tree.side();
        let book_component = side_and_tree.order_tree();
        let leaf_node = self.bookside_mut(side).
        remove_by_key(book_component, order_id).ok_or_else(|| {
            // possibly already filled or expired?
            error_msg_typed!(MangoError::PerpOrderIdNotFound, "no perp order with id {order_id}, side {side:?}, component {book_component:?} found on the orderbook")
        })?;
        if let Some(owner) = expected_owner {
            require_keys_eq!(leaf_node.owner, owner);
        }
        mango_account.remove_perp_order(leaf_node.owner_slot as usize, leaf_node.quantity)?;
        Ok(leaf_node)
    }
}

/// Apply taker fees to the taker account and update the markets' fees_accrued for
/// both the maker and taker fees.
fn apply_fees(
    market: &mut PerpMarket,
    account: &mut MangoAccountRefMut,
    quote_lots: i64,
) -> Result<()> {
    let quote_native = I80F48::from_num(market.quote_lot_size * quote_lots);

    // The maker fees apply to the maker's account only when the fill event is consumed.
    let maker_fees = quote_native * market.maker_fee;

    let taker_fees = quote_native * market.taker_fee;

    // taker fees should never be negative
    require_gte!(taker_fees, 0);

    // Part of the taker fees that go to the dao, instead of paying for maker rebates
    let taker_dao_fees = (taker_fees + maker_fees.min(I80F48::ZERO)).max(I80F48::ZERO);
    account
        .fixed
        .accrue_buyback_fees(taker_dao_fees.floor().to_num::<u64>());

    let perp_position = account.perp_position_mut(market.perp_market_index)?;
    perp_position.record_trading_fee(taker_fees);
    perp_position.taker_volume += taker_fees.to_num::<u64>();

    // Accrue maker fees immediately: they can be negative and applying them later
    // risks that fees_accrued is settled to 0 before they apply. It going negative
    // breaks assumptions.
    market.fees_accrued += taker_fees + maker_fees;

    Ok(())
}

/// Applies a fixed penalty fee to the account, and update the market's fees_accrued
fn apply_penalty(market: &mut PerpMarket, account: &mut MangoAccountRefMut) -> Result<()> {
    let fee_penalty = I80F48::from_num(market.fee_penalty);
    account
        .fixed
        .accrue_buyback_fees(fee_penalty.floor().to_num::<u64>());

    let perp_position = account.perp_position_mut(market.perp_market_index)?;
    perp_position.record_trading_fee(fee_penalty);
    market.fees_accrued += fee_penalty;
    Ok(())
}
