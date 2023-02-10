#!/bin/bash
. .env

if [ $1 == "--wick" ]
then
    yarn wick
elif [ $1 == "--wash" ]
then
    yarn wash
fi

