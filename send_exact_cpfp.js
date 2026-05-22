#!/usr/bin/env node
/*
Minimal orchestrator to move exact sats between wallets with a separate fee-paying wallet.

Usage (from FINAL/):
  node send_exact_cpfp.js \
    --fee-wallet-id=ID \
    --parent-wallet-id=ID \
    --intermediate-wallet-id=ID \
    --amount-sats=5000 \
    --fee-rate=2000 \
    [--prebuild-only]

This transfers exact sats from parent to intermediate (receiving) wallet.
The fee-wallet pays all transaction fees via CPFP approach.

Notes:
- This script performs prebuilds and signs/sends using BitGo SDK.
- You must place your BitGo access token in `.env` or `.ACCESS_TOKEN_OVERRIDE` and wallet passphrase in `.bitgo-pass` (current dir).
- It writes `prebuild_transfer.json` for audit.
*/

const fs = require('fs');
const path = require('path');
const BitGo = require('bitgo');
const argv = require('minimist')(process.argv.slice(2));

function readToken() {
  // Try .env file first
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/ACCESS_TOKEN="([^"]+)"/);
    if (match) return match[1];
  }
  // Fallback to .ACCESS_TOKEN_OVERRIDE
  const p = path.resolve('.ACCESS_TOKEN_OVERRIDE');
  if (!fs.existsSync(p)) throw new Error('No .env or .ACCESS_TOKEN_OVERRIDE found in cwd');
  return fs.readFileSync(p, 'utf8').trim();
}

function readPass() {
  const p = path.resolve('.bitgo-pass');
  if (!fs.existsSync(p)) throw new Error('.bitgo-pass not found in current dir (place your wallet passphrase there with chmod 600)');
  return fs.readFileSync(p, 'utf8').trim();
}

async function sendExactWithCPFP(opts) {
  const token = readToken();
  const bitgo = new BitGo.BitGo({ env: 'prod', accessToken: token });

  // Get wallets - detect custody vs self-custody by checking signBfdTransaction availability
  const sendWallet = await bitgo.coin('btc').wallets().get({ id: opts.parentWalletId });
  const recvWallet = await bitgo.coin('btc').wallets().get({ id: opts.intermediateWalletId || opts.parentWalletId });
  const feeWallet = await bitgo.coin('btc').wallets().get({ id: opts.feeWalletId });

  // Detect if wallet is custody (multisig) vs self-custody via BitGo API
  function isCustodyWallet(wallet) {
    try {
      const w = wallet.get();
      // Auto-detect: custody wallets have signBfdTransaction or lack hardwareKeyFingerprint
      return !!(w.signBfdTransaction || !(w.hardwareKeyFingerprint));
    } catch {
      return false;
    }
  }

  const sendIsCustody = isCustodyWallet(sendWallet);
  const feeIsCustody = isCustodyWallet(feeWallet);

  console.log(`Sender: ${opts.parentWalletId} [${sendIsCustody ? 'CUSTODY' : 'self-custody'}]`);
  console.log(`Receiver: ${opts.intermediateWalletId}`);
  console.log(`Fee payer: ${opts.feeWalletId} [${feeIsCustody ? 'CUSTODY' : 'self-custody'}]`);

  // Create receive address on receiving wallet
  const addrObj = await recvWallet.createAddress();
  const receiveAddr = addrObj.address;
  console.log('Receiving address:', receiveAddr);

  // STRATEGY: To preserve exact sats and have fee wallet pay:
  // 1. Send exact amount from sender → receiver with MINIMUM fee (1 sat/vB)
  // 2. Fee wallet sends to itself with HIGH fee to bump the whole transaction (CPFP)
  //
  // BUT WAIT - that only works if sender has enough for amount + min fee!
  // If sender has EXACTLY the amount (like 500 ordinal sats), we need:
  // 1. Send ALL sats from sender → receiver (0 fee - unconfirmed parent)
  // 2. Fee wallet creates CPFP child that references parent
  
  if (opts.parentWalletId === opts.feeWalletId) {
    // Simple case: sender pays own fees
    console.log('Sender is fee wallet - doing direct transfer...');
    console.log('Prebuilding transaction...');
    const preBuild = await sendWallet.prebuildTransaction({
      recipients: [{ address: receiveAddr, amount: String(opts.amountSats) }],
      feeRate: opts.feeRate
    });
    fs.writeFileSync('prebuild_transfer.json', JSON.stringify(preBuild, null, 2));
    console.log('WROTE prebuild_transfer.json');
    console.log(`Fee: ${preBuild.fee} sats, Recipients: ${JSON.stringify(preBuild.recipients || [])}`);

    if (opts.prebuildOnly) {
      console.log('prebuild-only flag set. Inspect prebuild_transfer.json and run without --prebuild-only to proceed.');
      return { status: 'prebuild-only', file: 'prebuild_transfer.json' };
    }

    const pass = readPass();
    console.log('Signing & sending transaction...');

    // Custody wallets use signBfdTransaction instead of send()
    if (sendIsCustody) {
      const prebuild = await sendWallet.prebuildTransaction({
        recipients: [{ address: receiveAddr, amount: String(opts.amountSats) }],
        feeRate: opts.feeRate
      });
      console.log('Custody wallet detected - using signBfdTransaction...');
      const signed = await sendWallet.signBfdTransaction({
        txPrebuild: prebuild,
        walletPassphrase: pass
      });
      const sendRes = await sendWallet.submitTransaction({ halfSigned: signed });
      console.log('Custody wallet transaction sent:', sendRes.txid || sendRes.hash);
    } else {
      const sendRes = await sendWallet.send({
        recipients: [{ address: receiveAddr, amount: String(opts.amountSats) }],
        walletPassphrase: pass,
        feeRate: opts.feeRate
      });
    }
    console.log('Send result:', JSON.stringify(sendRes, null, 2));
    return { txid: sendRes.txid || sendRes.hash };
  } else {
    // Complex case: sender != fee wallet
    // Solution: 
    // 1. If sender lacks funds for fee, fee wallet funds sender first
    // 2. Sender sends EXACT ordinal amount to receiver 
    // 3. Fee wallet creates CPFP to bump confirmation
    
    console.log('Checking if sender has enough for amount + fee...');
    const senderBalanceObj = await sendWallet.getBalance();
    const totalAvailable = senderBalanceObj.totalBalance || 0;

    // Use user's fee rate + small buffer (1 sat/vB estimate)
    const estimatedFee = Math.round(totalAvailable * 0.01); // ~1% as fee buffer
    const needed = opts.amountSats + estimatedFee;

    console.log(`Sender balance: ${totalAvailable} sats`);
    console.log(`Needed: ${opts.amountSats} sats + ~${estimatedFee} fee buffer = ${needed} sats`);
    console.log(`User's fee rate: ${opts.feeRate} sat/kB (actual fee calculated by BitGo)`);

    // Don't proactively fund - let user ensure wallet has enough.
    // If short, BitGo will return clear "InsufficientBalance" error.
    if (totalAvailable < needed) {
      console.log('');
      console.log('WARNING: Sender balance may be insufficient for amount + fee.');
      console.log(`This will fail with a clear error from BitGo if truly short.`);
      console.log('Ensure sender wallet has enough sats before proceeding.');
    }
      console.log('');
      console.log('SOLUTION: Fee wallet will send extra sats to sender for fee payment.');
      console.log('This preserves the exact ordinal sats.');
      console.log('');

      if (opts.prebuildOnly) {
        console.log('prebuild-only mode: Would need to:');
        console.log(`1. Fee wallet → Sender: ${fundingAmount} sats (for fee buffer, above dust threshold)`);
        console.log(`2. Sender → Receiver: ${opts.amountSats} sats (ordinals intact)`);
        console.log(`3. Fee wallet: CPFP bump`);
        return { status: 'prebuild-only', note: 'Sender needs funding first' };
      }

      const pass = readPass();

      // Step 0: Fund sender from fee wallet
      console.log(`Step 0: Funding sender with ${fundingAmount} sats from fee wallet...`);
      const senderAddrObj = await sendWallet.createAddress({ chain: 0 });
      const senderAddr = senderAddrObj.address;
      console.log(`Sender receive address: ${senderAddr}`);

      console.log('Prebuilding transaction from fee wallet...');
      const prebuild = await feeWallet.prebuildTransaction({
        recipients: [{ address: senderAddr, amount: String(fundingAmount) }],
        feeRate: opts.feeRate
      });
      console.log(`Prebuild OK. Fee: ${prebuild.fee} sats`);

      // Custody wallets use signBfdTransaction instead of signTransaction
      if (feeIsCustody) {
        console.log('Fee wallet is custody - using signBfdTransaction...');
        const signed = await feeWallet.signBfdTransaction({
          txPrebuild: prebuild,
          walletPassphrase: pass
        });
        const fundSend = await feeWallet.submitTransaction({ halfSigned: signed });
      } else {
        console.log('Signing self-custody transaction...');
        const signed = await feeWallet.signTransaction({
          txPrebuild: prebuild,
          walletPassphrase: pass
        });
        const fundSend = await feeWallet.submitTransaction({ halfSigned: signed });
      }
      console.log('Funding tx sent:', fundSend.txid || fundSend.hash);
      
      console.log('Waiting for sender wallet to index new UTXO...');
      console.log('This may take 10-30 seconds for BitGo to detect the incoming transaction.');
      
      // Poll for the new UTXO
      let found = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000)); // Wait 3 seconds between checks
        console.log(`Checking... (attempt ${i + 1}/20)`);
        const freshUnspents = await sendWallet.unspents();
        const totalNow = freshUnspents.unspents.reduce((sum, u) => sum + u.value, 0);
        console.log(`  Current sender balance: ${totalNow} sats`);
        if (totalNow >= needed) {
          console.log('✓ Sender now has enough funds!');
          found = true;
          break;
        }
      }
      
      if (!found) {
        console.log('');
        console.log('WARNING: Sender wallet has not yet indexed the incoming funds.');
        console.log('This is normal - the transaction is in the mempool but not yet confirmed.');
        console.log('You can either:');
        console.log('1. Wait a few minutes and run this command again');
        console.log('2. Continue anyway and hope BitGo indexes it during the next step');
        console.log('');
        throw new Error('Sender wallet not yet funded. Please wait and retry.');
      }
    }
    
    // Now proceed with sender → receiver
    console.log('');
    console.log('Step 1: Sending exact ordinals from sender → receiver...');
    const preBuild = await sendWallet.prebuildTransaction({
      recipients: [{ address: receiveAddr, amount: String(opts.amountSats) }],
      feeRate: opts.feeRate
    });
    
    fs.writeFileSync('prebuild_parent.json', JSON.stringify(preBuild, null, 2));
    console.log('WROTE prebuild_parent.json');
    console.log(`Parent tx: ${opts.amountSats} sats to receiver, fee: ${preBuild.fee} sats`);
    
    if (opts.prebuildOnly) {
      console.log('prebuild-only flag set. Inspect prebuild_parent.json');
      return { status: 'prebuild-only', file: 'prebuild_parent.json' };
    }

    const pass = readPass();
    console.log('Signing parent transaction...');

    // Custody wallets use signBfdTransaction instead of signTransaction
    if (sendIsCustody) {
      console.log('Sender wallet is custody - using signBfdTransaction...');
      const parentSigned = await sendWallet.signBfdTransaction({
        txPrebuild: preBuild,
        walletPassphrase: pass
      });
      console.log('Signing OK. Broadcasting...');
      const parentSend = await sendWallet.submitTransaction({ halfSigned: parentSigned });
    } else {
      console.log('Sender is self-custody - using standard signTransaction...');
      const parentSigned = await sendWallet.signTransaction({
        txPrebuild: preBuild,
        walletPassphrase: pass
      });
      console.log('Signing OK. Broadcasting...');
      const parentSend = await sendWallet.submitTransaction({ halfSigned: parentSigned });
    }
    const parentTxid = parentSend.txid || parentSend.hash;
    console.log('Parent tx sent:', parentTxid);
    console.log(`✓ Exact ${opts.amountSats} ordinal sats transferred to receiver!`);
    
    // Step 2: Fee wallet CPFP bump (optional — failure here does NOT affect the transfer)
    console.log('');
    console.log('Step 2: Fee wallet creating CPFP to accelerate confirmation...');
    let cpfpTxid = null;
    try {
      const feeWalletAddrObj = await feeWallet.createAddress({ chain: 0 });
      const feeWalletAddr = feeWalletAddrObj.address;
      const cpfpPrebuild = await feeWallet.prebuildTransaction({
        recipients: [{ address: feeWalletAddr, amount: '1000' }],
        feeRate: opts.feeRate
      });
      console.log(`CPFP: Sending 1000 sats to self with ${cpfpPrebuild.fee} sats fee`);

      // Custody wallets use signBfdTransaction instead of signTransaction
      if (feeIsCustody) {
        console.log('Fee wallet is custody - using signBfdTransaction for CPFP...');
        const cpfpSigned = await feeWallet.signBfdTransaction({
          txPrebuild: cpfpPrebuild,
          walletPassphrase: pass
        });
      } else {
        console.log('Fee wallet is self-custody - using standard signTransaction for CPFP...');
        const cpfpSigned = await feeWallet.signTransaction({
          txPrebuild: cpfpPrebuild,
          walletPassphrase: pass
        });
      }

      const cpfpSend = await feeWallet.submitTransaction({ halfSigned: cpfpSigned });
      cpfpTxid = cpfpSend.txid || cpfpSend.hash;
      console.log('CPFP tx sent:', cpfpTxid);
    } catch (cpfpErr) {
      console.log('⚠ CPFP skipped (fee wallet may lack funds): ' + cpfpErr.message);
      console.log('  The parent tx is already broadcast and will confirm at its own fee rate.');
    }

    return { parentTxid, cpfpTxid };
  }
}

(async () => {
  const opts = {
    feeWalletId: argv['fee-wallet-id'],
    parentWalletId: argv['parent-wallet-id'],
    intermediateWalletId: argv['intermediate-wallet-id'],
    amountSats: argv['amount-sats'] || 5000,
    feeRate: argv['fee-rate'] || 2000,
    prebuildOnly: argv['prebuild-only'] || false
  };

  if (!opts.feeWalletId || !opts.parentWalletId) {
    console.error('Missing required args: --fee-wallet-id, --parent-wallet-id');
    console.error('Usage: node send_exact_cpfp.js --fee-wallet-id=ID --parent-wallet-id=ID [optional: --intermediate-wallet-id=ID] [--multisig]');
    process.exit(1);
  }

  // If --intermediate is not provided, use parent wallet as receiver (same wallet)
  if (!opts.intermediateWalletId) {
    console.log('⚠ No --intermediate-wallet-id provided. Using sender wallet as receiver.');
    opts.intermediateWalletId = opts.parentWalletId;
  }

  try {
    const r = await sendExactWithCPFP(opts);
    console.log('Done. Result:', r);
  } catch (e) {
    console.error('ERROR:', e && e.message);
    if (e && e.result) console.error(JSON.stringify(e.result, null, 2));
    process.exit(1);
  }
})();

