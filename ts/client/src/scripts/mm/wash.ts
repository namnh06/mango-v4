import { AnchorProvider, BN, Wallet } from '@project-serum/anchor';
import {
  Cluster,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import Binance from 'binance-api-node';
import fs from 'fs';
import { Kraken } from 'node-kraken-api';
import path from 'path';
import { Group } from '../../accounts/group';
import { HealthType, MangoAccount } from '../../accounts/mangoAccount';
import {
  BookSide,
  PerpMarket,
  PerpMarketIndex,
  PerpOrderSide,
  PerpOrderType,
} from '../../accounts/perp';
import { MangoClient } from '../../client';
import { MANGO_V4_ID } from '../../constants';
import { toUiDecimalsForQuote } from '../../utils';
import { sendTransaction } from '../../utils/rpc';
import {
  makeCheckAndSetSequenceNumberIx,
  makeInitSequenceEnforcerAccountIx,
  seqEnforcerProgramIds,
} from './sequence-enforcer-util';
import {
  getUnixTs,
  percentageVolatility,
} from './utils';
import * as dotenv from 'dotenv';
dotenv.config()

// Future
// * use async nodejs logging
// * merge gMa calls
// * take out spammers
// * batch ixs across various markets
// * only refresh part of the group which market maker is interested in

// Env vars
const CLUSTER: Cluster =
  (process.env.CLUSTER_OVERRIDE as Cluster) || 'mainnet-beta';
const CLUSTER_URL =
  process.env.CLUSTER_URL_OVERRIDE || process.env.MB_CLUSTER_URL;
const USER_KEYPAIR =
  process.env.USER_KEYPAIR_OVERRIDE || process.env.MB_PAYER_KEYPAIR;
const MANGO_ACCOUNT_PK = process.env.MANGO_ACCOUNT_PK || '';

// Load configuration
const paramsFileName = process.env.WASH_PARAMS || 'wash.json';
const params = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, `./params/${paramsFileName}`),
    'utf-8',
  ),
);

const control = { isRunning: true, interval: params.interval };

// State which is passed around
type State = {
  mangoAccount: MangoAccount;
  lastMangoAccountUpdate: number;
  marketContexts: Map<PerpMarketIndex, MarketContext>;
};
type MarketContext = {
  params: any;
  perpMarket: PerpMarket;
  bids: BookSide;
  asks: BookSide;
  lastBookUpdate: number;

  krakenBid: number | undefined;
  krakenAsk: number | undefined;

  // binanceBid: number | undefined;
  // binanceAsk: number | undefined;

  sequenceAccount: PublicKey;
  sequenceAccountBump: number;

  sentBidPrice: number;
  sentAskPrice: number;
  lastOrderUpdate: number;
};

const binanceClient = Binance();
const krakenClient = new Kraken();

function getPerpMarketAssetsToTradeOn(group: Group) {
  const allMangoGroupPerpMarketAssets = Array.from(
    group.perpMarketsMapByName.keys(),
  ).map((marketName) => marketName.replace('-PERP', ''));
  return Object.keys(params.assets).filter((asset) =>
    allMangoGroupPerpMarketAssets.includes(asset),
  );
}

// Refresh group, mango account and perp markets
async function refreshState(
  client: MangoClient,
  group: Group,
  mangoAccount: MangoAccount,
  marketContexts: Map<PerpMarketIndex, MarketContext>,
): Promise<State> {
  const ts = Date.now() / 1000;

  const result = await Promise.all([
    group.reloadAll(client),
    mangoAccount.reload(client),
    ...Array.from(marketContexts.values()).map(
      (mc) =>
        krakenClient.depth({
          pair: mc.params.krakenCode,
        }),
      // binanceClient.book({
      //   symbol: mc.perpMarket.name.replace('-PERP', 'USDT'),
      // }),
    ),
  ]);

  Array.from(marketContexts.values()).map(async (mc, i) => {
    const perpMarket = mc.perpMarket;
    mc.perpMarket = group.getPerpMarketByMarketIndex(
      perpMarket.perpMarketIndex,
    );
    mc.bids = await perpMarket.loadBids(client, true);
    mc.asks = await perpMarket.loadAsks(client, true);
    mc.lastBookUpdate = ts;

    mc.krakenAsk = parseFloat(
      (result[i + 2] as any)[mc.params.krakenCode].asks[0][0],
    );
    mc.krakenBid = parseFloat(
      (result[i + 2] as any)[mc.params.krakenCode].bids[0][0],
    );
  });

  return {
    mangoAccount,
    lastMangoAccountUpdate: ts,
    marketContexts,
  };
}

// Initialiaze sequence enforcer accounts
async function initSequenceEnforcerAccounts(
  client: MangoClient,
  marketContexts: MarketContext[],
) {
  const seqAccIxs = marketContexts.map((mc) =>
    makeInitSequenceEnforcerAccountIx(
      mc.sequenceAccount,
      (client.program.provider as AnchorProvider).wallet.publicKey,
      mc.sequenceAccountBump,
      mc.perpMarket.name,
      CLUSTER,
    ),
  );
  while (true) {
    try {
      const sig = await sendTransaction(
        client.program.provider as AnchorProvider,
        seqAccIxs,
        [],
      );
      console.log(
        `Sequence enforcer accounts created, sig https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER == 'devnet' ? 'devnet' : ''
        }`,
      );
    } catch (e) {
      console.log('Failed to initialize sequence enforcer accounts!');
      console.log(e);
      continue;
    }
    break;
  }
}

// Main driver for the market maker
async function fullWash() {
  // Load client
  const options = AnchorProvider.defaultOptions();
  const connection = new Connection(CLUSTER_URL!, options);
  const user = Keypair.fromSecretKey(
    Buffer.from(
      JSON.parse(
        process.env.KEYPAIR || fs.readFileSync(USER_KEYPAIR!, 'utf-8'),
      ),
    ),
  );
  const userWallet = new Wallet(user);

  const userProvider = new AnchorProvider(connection, userWallet, options);
  const client = await MangoClient.connect(
    userProvider,
    CLUSTER,
    MANGO_V4_ID[CLUSTER],
    {
      idsSource: 'get-program-accounts',
    },
  );

  // Load mango account
  let mangoAccount = await client.getMangoAccount(
    new PublicKey(MANGO_ACCOUNT_PK),
  );
  console.log(
    `MangoAccount ${mangoAccount.publicKey} for user ${user.publicKey} ${mangoAccount.isDelegate(client) ? 'via delegate ' + user.publicKey : ''
    }`,
  );
  await mangoAccount.reload(client);

  // Load group
  const group = await client.getGroup(mangoAccount.group);
  await group.reloadAll(client);

  // Build and maintain an aggregate context object per market
  const marketContexts: Map<PerpMarketIndex, MarketContext> = new Map();
  for (const perpMarketAsset of getPerpMarketAssetsToTradeOn(group)) {
    const perpMarket = group.getPerpMarketByName(perpMarketAsset + '-PERP');
    const [sequenceAccount, sequenceAccountBump] =
      await PublicKey.findProgramAddress(
        [
          Buffer.from(perpMarket.name, 'utf-8'),
          (
            client.program.provider as AnchorProvider
          ).wallet.publicKey.toBytes(),
        ],
        seqEnforcerProgramIds[CLUSTER],
      );
    marketContexts.set(perpMarket.perpMarketIndex, {
      params: params.assets[perpMarketAsset].perp,
      perpMarket: perpMarket,
      bids: await perpMarket.loadBids(client),
      asks: await perpMarket.loadAsks(client),
      lastBookUpdate: 0,

      sequenceAccount,
      sequenceAccountBump,

      sentBidPrice: 0,
      sentAskPrice: 0,
      lastOrderUpdate: 0,

      krakenBid: undefined,
      krakenAsk: undefined,
    });
  }

  // Init sequence enforcer accounts
  await initSequenceEnforcerAccounts(
    client,
    Array.from(marketContexts.values()),
  );

  // Load state first time
  console.log(`Loading state first time`);
  let state = await refreshState(client, group, mangoAccount, marketContexts);

  // Add handler for e.g. CTRL+C
  process.on('SIGINT', function () {
    console.log('Caught keyboard interrupt.');
    control.isRunning = false;
  });

  // Loop indefinitely
  while (control.isRunning) {
    try {
      console.log(`\nRefreshing state`);
      refreshState(client, group, mangoAccount, marketContexts).then(
        (result) => (state = result),
      );

      mangoAccount = state.mangoAccount;

      // Calculate pf level values
      let pfQuoteValue: number | undefined = 0;
      for (const mc of Array.from(marketContexts.values())) {
        const pos = mangoAccount.perpPositionExistsForMarket(mc.perpMarket)
          ? mangoAccount.getPerpPositionUi(group, mc.perpMarket.perpMarketIndex)
          : 0;
        const mid = (mc.krakenBid! + mc.krakenAsk!) / 2;
        if (mid) {
          pfQuoteValue += pos * mid;
        } else {
          pfQuoteValue = undefined;
          console.log(
            `Breaking pfQuoteValue computation, since mid is undefined for ${mc.perpMarket.name}!`,
          );
          break;
        }
      }

      // Don't proceed if we don't have pfQuoteValue yet
      if (pfQuoteValue === undefined) {
        console.log(
          `Continuing control loop, since pfQuoteValue is undefined!`,
        );
        continue;
      }

      // Update all orders on all markets
      for (const mc of Array.from(marketContexts.values())) {
        const ixs = await makeMarketUpdateInstructions(
          client,
          group,
          mangoAccount,
          mc,
        );
        if (ixs.length === 0) {
          continue;
        }

        const sig = await sendTransaction(
          client.program.provider as AnchorProvider,
          ixs,
          group.addressLookupTablesList,
        );
        console.log(
          `Orders for market updated, sig https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER == 'devnet' ? 'devnet' : ''
          }`,
        );
      }
    } catch (e) {
      console.log(e);
    } finally {
      console.log(
        `${new Date().toUTCString()} sleeping for ${control.interval / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, control.interval));
    }
  }
}

async function makeMarketUpdateInstructions(
  client: MangoClient,
  group: Group,
  mangoAccount: MangoAccount,
  mc: MarketContext,
): Promise<TransactionInstruction[]> {
  const perpMarketIndex = mc.perpMarket.perpMarketIndex;
  const perpMarket = mc.perpMarket;
  const perpMarketName: string = mc.perpMarket.name;
  let message: string = `--- ${perpMarketName} ---`;

  const aggBid = mc.krakenBid;
  const aggAsk = mc.krakenAsk;
  if (aggBid === undefined || aggAsk === undefined) {
    console.log(`No Aggregate Book for ${mc.perpMarket.name}!`);
    return [];
  }
  const fairValue: number = (aggBid + aggAsk) / 2;
  message += `\nfairValue: ${fairValue}`;

  const basePos = mangoAccount.perpPositionExistsForMarket(mc.perpMarket)
    ? mangoAccount.getPerpPositionUi(group, perpMarketIndex, true)
    : 0;

  if (basePos !== 0) {
    const bids = mc.bids;
    const asks = mc.asks;

    // Start building the transaction
    const instructions: TransactionInstruction[] = [
      makeCheckAndSetSequenceNumberIx(
        mc.sequenceAccount,
        (client.program.provider as AnchorProvider).wallet.publicKey,
        Date.now(),
        CLUSTER,
      ),
    ];

    instructions.push(
      await client.healthRegionBeginIx(group, mangoAccount, [], [perpMarket]),
    );

    const charge: number = (mc.params.charge || 0.002);
    if (charge >= 0.01) {
      console.warn(`DO NOTHING DUE TO CHARGE >= 1%`);
      return [];
    }

    // base > 0 => positive => need sell
    if (basePos > 0) {
      const bidAcceptablePrice = fairValue * (1 - charge);
      // 100 * (1 - 0.002) = 99.8
      const modelBidPrice = perpMarket.uiPriceToLots(bidAcceptablePrice);
      const takerSize: number = basePos;
      const nativeBidSize = perpMarket.uiBaseToLots(takerSize);


      const placeAskIx = await client.perpPlaceOrderIx(
        group,
        mangoAccount,
        perpMarketIndex,
        PerpOrderSide.ask,
        perpMarket.priceLotsToUi(modelBidPrice),
        perpMarket.baseLotsToUi(nativeBidSize),
        undefined,
        Date.now(),
        PerpOrderType.immediateOrCancel,
        true,
      );

      message += `\nSelling ...`;
      message += `\nWash Trade - IOC selling for size: ${takerSize}, at price: ${bidAcceptablePrice} `;

      console.log(message);
      instructions.push(placeAskIx);
    } else if (basePos < 0) {
      const askAcceptablePrice = fairValue * (1 + charge);
      const modelAskPrice = perpMarket.uiPriceToLots(askAcceptablePrice);
      const takerSize: number = Math.abs(basePos);
      const nativeAskSize = perpMarket.uiBaseToLots(takerSize);


      const placeBidIx = await client.perpPlaceOrderIx(
        group,
        mangoAccount,
        perpMarketIndex,
        PerpOrderSide.bid,
        perpMarket.priceLotsToUi(modelAskPrice),
        perpMarket.baseLotsToUi(nativeAskSize),
        undefined,
        Date.now(),
        PerpOrderType.immediateOrCancel,
        true,
      );

      message += `\nBuying ...`;
      message += `\nWash Trade - IOC buying for size: ${takerSize}, at price: ${askAcceptablePrice}`;

      instructions.push(placeBidIx);
    }
    console.log(message);
    return instructions;
  } else {
    console.log(`Wash - Do nothing`);
    return [];
  }
}

function startWash() {
  try {
    if (control.isRunning) {
      fullWash()
        .catch((error) => console.log(error))
        .finally(startWash);
    }
  } catch (error) {
    console.log(error);
  }
}

startWash();
