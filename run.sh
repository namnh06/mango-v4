#!/bin/bash
. .env

if [ $1 == "--mm" ]
then
    yarn market-maker
fi
