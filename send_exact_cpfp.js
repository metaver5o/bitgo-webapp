#!/usr/bin/env node
/*
  Deterministic Multisig Isolation Orchestrator
  Forces sequential tracking to pin explicit inputs alongside external fees.
*/

const fs = require('fs');
const path = require('path');
const BitGo = require('bitgo');
const argv = require('minimist')(process.argv.slice(2));

function readToken() {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/ACCESS_TOKEN="([^"]+)"/);
    if (match) return match[1];
  }
  const p = path.resolve('.ACCESS_TOKEN_OVERRIDE');
  if (!fs.existsSync(p)) throw new Error('No .env or .ACCESS_TOKEN_OVERRIDE found in cwd');
  return fs.readFileSync(p, 'utf8').trim();
}

function readPass() {
  const p = path.resolve('.bitgo-pass');
  if (!fs.existsSync(p)) throw new Error('.bitgo-pass configuration file missing');
  return fs.readFileSync(p, 'utf8').trim();
}

async function sendExactWithDeterministicIsolation(opts) {
  const token = readToken();
  const bitgo = new BitGo.BitGo({ env: 'prod', accessToken: token });

  const sendWallet = await bitgo.coin('btc').wallets().get({ id: opts.parentWalletId });
  const feeWallet = await bitgo.coin('btc').wallets().get({ id: opts.feeWalletId });

  function isCustodyWallet(wallet) {
    try {
      const w = wallet.get();
      return !!(w.signBfdTransaction || !(w.hardwareKeyFingerprint));
    } catch {
      return false;
    }
  }

  const sendIsCustody = isCustodyWallet(sendWallet);
  const feeIsCustody = isCustodyWallet(feeWallet);

  console.log(`Sender Wallet: ${opts.parentWalletId} [${sendIsCustody ? 'CUSTODY-MULTISIG' : 'self-custody'}]`);
  console.log(`Gas Wallet: ${opts.feeWalletId} [${feeIsCustody ? 'CUSTODY-MULTISIG' : 'self-custody'}]`);
  console.log(`Destination Out: ${opts.destinationAddress}`);

  // Base Logic: Exact Asset Match Isolation
  const freshUnspents = await sendWallet.unspents();
  const targetValue = parseInt(opts.amountSats);
  const ordinalUtxo = freshUnspents.unspents.find(u => u.value === targetValue);

  if (!ordinalUtxo) {
    throw new Error(`CRITICAL FIFO FAULT: No UTXO found matching exact ordinal size of ${targetValue} sats.`);
  }
  console.log(`✓ Pinned target Ordinal UTXO: ${ordinalUtxo.txid}:${ordinalUtxo.vout}`);

  // Case A: Sender pays for its own fees directly
  if (opts.parentWalletId === opts.feeWalletId) {
    console.log('Direct Transfer Pipeline Triggered (Sender == Funder)...');
    
    const prebuildOpts = {
      unspents: [`${ordinalUtxo.txid}:${ordinalUtxo.vout}`],
      recipients: [{ address: opts.destinationAddress, amount: String(targetValue) }],
      feeRate: opts.feeRate,
      noSplitOutputs: true
    };

    const preBuild = await sendWallet.prebuildTransaction(prebuildOpts);
    fs.writeFileSync('prebuild_transfer.json', JSON.stringify(preBuild, null, 2));
    console.log('WROTE prebuild_transfer.json');

    if (opts.prebuildOnly) return { status: 'prebuild-only' };

    const pass = readPass();
    let sendRes;
    if (sendIsCustody) {
      const signed = await sendWallet.signBfdTransaction({ txPrebuild: preBuild, walletPassphrase: pass });
      sendRes = await sendWallet.submitTransaction({ halfSigned: signed });
    } else {
      const signed = await sendWallet.signTransaction({ txPrebuild: preBuild, walletPassphrase: pass });
      sendRes = await sendWallet.submitTransaction({ halfSigned: signed });
    }
    
    console.log(`Parent tx: ${sendRes.txid || sendRes.hash}`);
    return { parentTxid: sendRes.txid || sendRes.hash };
  }

  // Case B: External Multi-Sig Fee Segregation Chamber (Sender !== Funder)
  console.log('\n--- ENTERING ISOLATION CHAMBER PIPELINE ---');
  
  // Calculate appropriate gas threshold buffer (Assume absolute ceiling size of 75,000 sats)
  const fundingAmount = 75000; 
  console.log(`Step 0: Provisioning safe external gas buffer UTXO (${fundingAmount} sats)...`);
  
  const senderAddrObj = await sendWallet.createAddress({ chain: 0 });
  const senderGasLandingAddr = senderAddrObj.address;
  console.log(`Temporary Gas Landing Address: ${senderGasLandingAddr}`);

  const fundPrebuild = await feeWallet.prebuildTransaction({
    recipients: [{ address: senderGasLandingAddr, amount: String(fundingAmount) }],
    feeRate: opts.feeRate
  });

  if (opts.prebuildOnly) {
    fs.writeFileSync('prebuild_parent.json', JSON.stringify(fundPrebuild, null, 2));
    console.log('[PREBUILD ONLY] Stage 0 payload calculated inside prebuild_parent.json');
    return { status: 'prebuild-only' };
  }

  const pass = readPass();
  let fundSend;
  if (feeIsCustody) {
    const signed = await feeWallet.signBfdTransaction({ txPrebuild: fundPrebuild, walletPassphrase: pass });
    fundSend = await feeWallet.submitTransaction({ halfSigned: signed });
  } else {
    const signed = await feeWallet.signTransaction({ txPrebuild: fundPrebuild, walletPassphrase: pass });
    fundSend = await feeWallet.submitTransaction({ halfSigned: signed });
  }

  const fundTxid = fundSend.txid || fundSend.hash;
  console.log(`Fee buffer tx: ${fundTxid}`);
  console.log('Awaiting BitGo Node synchronization index (mempool tracking)...');

  let gasUtxo = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    console.log(`Syncing mempool index... (Poll ${i + 1}/30)`);
    try {
      const checkUnspents = await sendWallet.unspents();
      gasUtxo = checkUnspents.unspents.find(u => u.txid === fundTxid);
      if (gasUtxo) {
        console.log(`✓ Isolation Chamber Verified. Gas Input Pinned: ${gasUtxo.txid}:${gasUtxo.vout}`);
        break;
      }
    } catch (err) {
      console.log(`[Warning] Poll check failed: ${err.message}`);
    }
  }

  if (!gasUtxo) {
    throw new Error('Pipeline Execution Timeout: BitGo cluster index did not return the gas UTXO in time.');
  }

  console.log('\nStep 1: Enforcing Multi-Input Bound Asset Protection...');
  
  // Re-fetch to guarantee state freshness
  const absoluteFreshUnspents = await sendWallet.unspents();
  const currentOrdinalLock = absoluteFreshUnspents.unspents.find(u => u.value === targetValue);
  const currentGasLock = absoluteFreshUnspents.unspents.find(u => u.txid === fundTxid);

  if (!currentOrdinalLock || !currentGasLock) {
    throw new Error("State Drift Error: Failed to secure simultaneous handles on atomic inputs.");
  }

  // Construct explicit Multi-Input schema forcing FIFO constraints down to the nodes
  const multisigPrebuild = await sendWallet.prebuildTransaction({
    unspents: [
      `${currentOrdinalLock.txid}:${currentOrdinalLock.vout}`, // Input 0: Core Asset Range
      `${currentGasLock.txid}:${currentGasLock.vout}`         // Input 1: Dedicated Fee Payer
    ],
    recipients: [
      { 
        address: opts.destinationAddress, 
        amount: String(targetValue) // Enforce exact matching size to preserve FIFO ranges
      }
    ],
    feeRate: opts.feeRate,
    noSplitOutputs: true // Hard-lock out structural optimization slices
  });

  fs.writeFileSync('prebuild_cpfp.json', JSON.stringify(multisigPrebuild, null, 2));

  console.log('Signing atomic multi-input array via local wallet container...');
  let transferSend;
  if (sendIsCustody) {
    const signed = await sendWallet.signBfdTransaction({ txPrebuild: multisigPrebuild, walletPassphrase: pass });
    transferSend = await sendWallet.submitTransaction({ halfSigned: signed });
  } else {
    const signed = await sendWallet.signTransaction({ txPrebuild: multisigPrebuild, walletPassphrase: pass });
    transferSend = await sendWallet.submitTransaction({ halfSigned: signed });
  }

  const finalTxid = transferSend.txid || transferSend.hash;
  console.log(`Parent tx: ${finalTxid}`);
  console.log('✓ ALL DONE');

  return { fundTxid, finalTxid };
}

(async () => {
  const opts = {
    feeWalletId: argv['fee-wallet-id'],
    parentWalletId: argv['parent-wallet-id'],
    destinationAddress: argv['destination-address'],
    amountSats: argv['amount-sats'] || 5000,
    feeRate: argv['fee-rate'] || 1000,
    prebuildOnly: argv['prebuild-only'] || false
  };

  if (!opts.feeWalletId || !opts.parentWalletId || !opts.destinationAddress) {
    console.error('Usage Error: Missing parameters.');
    process.exit(1);
  }

  try {
    const r = await sendExactWithDeterministicIsolation(opts);
    console.log('Done. Result:', r);
  } catch (e) {
    console.error('ERROR:', e && e.message);
    process.exit(1);
  }
})();
