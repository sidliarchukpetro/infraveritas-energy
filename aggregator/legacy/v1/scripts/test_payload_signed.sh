#!/bin/bash
SIGNATURE=$(node -e "
const {ethers} = require('ethers');
const wallet = new ethers.Wallet('0x6bbaa833c4dc9845739d0057ce8d743477798b46a605f816951b08685f858463');
const msg = 'infraveritas:42:1:1777700000';
wallet.signMessage(msg).then(sig => console.log(sig));
")

echo "{\"deviceId\":42,\"sessionId\":1,\"epochStartTs\":1777700000,\"minTotalEnergy\":100,\"signature\":\"$SIGNATURE\",\"readings\":[$( for i in $(seq 1 49); do echo -n "{\"voltage_mv\":5500,\"current_ma\":250,\"timestamp_ms\":1777700000000},"; done; echo "{\"voltage_mv\":5500,\"current_ma\":250,\"timestamp_ms\":1777700049000}" )]}"
