#!/usr/bin/env node
/*
Minimal orchestrator to move exact sats between wallets with a separate fee-paying wallet.

Usage:
  node send_exact_cpfp.js \
    --fee-wallet-id=ID \
    --parent-wallet-id=ID \
    --destination-address=ADDRESS \
    --amount-sats=5000 \
    --fee-rate=1000 \
    [--prebuild-only]

The fee-wallet pays all transaction fees via CPFP.
Token: .env (ACCESS_TOKEN="v2x...") or .ACCESS_TOKEN_OVERRIDE
Passphrase: .bitgo-pass (chmod 600)
*/

const fs   = require('fs');
const path = require('path');
const BitGo = require('bitgo');
const argv = require('minimist')(process.argv.slice(2));

function readToken() {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/ACCESS_TOKEN="([^"]+)"/);
    if (m) return m[1];
  }
  const p = path.resolve('.ACCESS_TOKEN_OVERRIDE');
  if (!fs.existsSync(p)) throw new Error('No .env or .ACCESS_TOKEN_OVERRIDE found in cwd');
  return fs.readFileSync(p, 'utf8').trim();
}

function readPass() {
  const p = path.resolve('.bitgo-pass');
  if (!fs.existsSync(p)) throw new Error('.bitgo-pass not found in cwd');
  return fs.readFileSync(p, 'utf8').trim();
}

async function signAndSubmit(wallet, txPrebuild, walletPassphrase, isCustody) {
  if (isCustody) {
    const signed = await wallet.signBfdTransaction({ txPrebuild, walletPassphrase });
    return wallet.submitTransaction({ halfSigned: signed });
  }
  const signed = await wallet.signTransaction({ txPrebuild, walletPassphrase });
  return wallet.submitTransaction({ halfSigned: signed });
}

function isCustodyWallet(wallet) {
  try {
    const w = wallet.get();
    return !!(w.signBfdTransaction || !w.hardwareKeyFingerprint);
  } catch {
    return false;
  }
}

async function sendExactWithCPFP(opts) {
  const token  = readToken();
  const bitgo  = new BitGo.BitGo({ env: 'prod', accessToken: token });
  const coin   = bitgo.coin('btc');

  const sendWallet = await coin.wallets().get({ id: opts.parentWalletId });
  const feeWallet  = await coin.wallets().get({ id: opts.feeWalletId });

  const sendIsCustody = isCustodyWallet(sendWallet);
  const feeIsCustody  = isCustodyWallet(feeWallet);

  console.log(`Sender:    ${opts.parentWalletId} [${sendIsCustody ? 'custody' : 'self-custody'}]`);
  console.log(`Fee payer: ${opts.feeWalletId} [${feeIsCustody ? 'custody' : 'self-custody'}]`);
  console.log(`Dest:      ${opts.destinationAddress}`);
  console.log(`Amount:    ${opts.amountSats} sats  Fee rate: ${opts.feeRate} sat/kB`);

  const destAddr = opts.destinationAddress;

  // --- Simple case: sender == fee wallet ---
  if (opts.parentWalletId === opts.feeWalletId) {
    console.log('\nSender is fee wallet — direct transfer.');
    const preBuild = await sendWallet.prebuildTransaction({
      recipients: [{ address: destAddr, amount: String(opts.amountSats) }],
      feeRate: opts.feeRate
    });
    fs.writeFileSync('prebuild_transfer.json', JSON.stringify(preBuild, null, 2));
    console.log(`Prebuild OK. Fee: ${preBuild.fee} sats`);

    if (opts.prebuildOnly) {
      console.log('prebuild-only — inspect prebuild_transfer.json');
      return { status: 'prebuild-only' };
    }

    const pass   = readPass();
    const result = await signAndSubmit(sendWallet, preBuild, pass, sendIsCustody);
    console.log('✓ Sent:', result.txid || result.hash);
    return { txid: result.txid || result.hash };
  }

  // --- Complex case: separate sender and fee wallet ---
  console.log('\nChecking sender balance...');
  const totalAvail   = sendWallet.balance() || 0;
  // Dust threshold minimum funding amount to cover fees
  const fundingAmount = Math.max(1000, Math.ceil(opts.feeRate * 0.25));
  const needed       = opts.amountSats + fundingAmount;

  console.log(`Sender balance: ${totalAvail} sats`);
  console.log(`Needed: ${opts.amountSats} + ~${fundingAmount} fee buffer = ${needed} sats`);

  if (totalAvail < needed) {
    console.log('\nSender needs funding from fee wallet.');

    if (opts.prebuildOnly) {
      console.log('prebuild-only — would fund sender then transfer.');
      console.log(`  Step 0: Fee wallet → Sender: ${fundingAmount} sats`);
      console.log(`  Step 1: Sender → Dest: ${opts.amountSats} sats`);
      console.log(`  Step 2: Fee wallet CPFP bump`);
      return { status: 'prebuild-only', note: 'sender needs funding first' };
    }

    const pass = readPass();

    // Step 0: fund sender
    const senderAddrObj = await sendWallet.createAddress({ chain: 0 });
    const senderAddr    = senderAddrObj.address;
    console.log(`\nStep 0: Funding sender at ${senderAddr} with ${fundingAmount} sats...`);

    const fundPrebuild = await feeWallet.prebuildTransaction({
      recipients: [{ address: senderAddr, amount: String(fundingAmount) }],
      feeRate: opts.feeRate
    });
    console.log(`Fund prebuild OK. Fee: ${fundPrebuild.fee} sats`);

    const fundSend = await signAndSubmit(feeWallet, fundPrebuild, pass, feeIsCustody);
    const fundTxid = fundSend.txid || fundSend.hash;
    console.log(`Funding tx: ${fundTxid}`);
    console.log('Waiting for BitGo to index funding tx (up to 60s)...');

    let funded = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
      console.log(`  Check ${i + 1}/20...`);
      const unspents = await sendWallet.unspents();
      const nowTotal = (unspents.unspents || []).reduce((s, u) => s + u.value, 0);
      console.log(`  Sender balance now: ${nowTotal} sats`);
      if (nowTotal >= needed) { funded = true; break; }
    }

    if (!funded) {
      throw new Error('Sender not yet funded after 60s. Wait and retry.');
    }
  }

  // Step 1: sender → destination
  console.log('\nStep 1: Sender → destination...');
  const parentPrebuild = await sendWallet.prebuildTransaction({
    recipients: [{ address: destAddr, amount: String(opts.amountSats) }],
    feeRate: opts.feeRate
  });
  fs.writeFileSync('prebuild_parent.json', JSON.stringify(parentPrebuild, null, 2));
  console.log(`Parent prebuild OK. Fee: ${parentPrebuild.fee} sats`);

  if (opts.prebuildOnly) {
    console.log('prebuild-only — inspect prebuild_parent.json');
    return { status: 'prebuild-only' };
  }

  const pass       = readPass();
  const parentSend = await signAndSubmit(sendWallet, parentPrebuild, pass, sendIsCustody);
  const parentTxid = parentSend.txid || parentSend.hash;
  console.log(`✓ Parent tx: ${parentTxid}`);
  console.log(`  Exact ${opts.amountSats} sats transferred to destination.`);

  // Step 2: CPFP bump (best-effort, non-fatal)
  let cpfpTxid = null;
  try {
    console.log('\nStep 2: CPFP bump from fee wallet...');
    const feeAddrObj   = await feeWallet.createAddress({ chain: 0 });
    const cpfpPrebuild = await feeWallet.prebuildTransaction({
      recipients: [{ address: feeAddrObj.address, amount: '1000' }],
      feeRate: opts.feeRate * 2
    });
    fs.writeFileSync('prebuild_cpfp.json', JSON.stringify(cpfpPrebuild, null, 2));
    console.log(`CPFP prebuild OK. Fee: ${cpfpPrebuild.fee} sats`);

    const cpfpSend = await signAndSubmit(feeWallet, cpfpPrebuild, pass, feeIsCustody);
    cpfpTxid = cpfpSend.txid || cpfpSend.hash;
    console.log(`✓ CPFP tx: ${cpfpTxid}`);
  } catch (e) {
    console.log(`⚠ CPFP skipped: ${e.message}`);
    console.log('  Parent tx is already broadcast and will confirm at its own rate.');
  }

  return { parentTxid, cpfpTxid };
}

(async () => {
  const opts = {
    feeWalletId:          argv['fee-wallet-id'],
    parentWalletId:       argv['parent-wallet-id'],
    destinationAddress:   argv['destination-address'],
    amountSats:           Number(argv['amount-sats'])  || 5000,
    feeRate:              Number(argv['fee-rate'])     || 2000,
    prebuildOnly:         !!argv['prebuild-only']
  };

  if (!opts.feeWalletId || !opts.parentWalletId || !opts.destinationAddress) {
    console.error('Usage: node send_exact_cpfp.js --fee-wallet-id=ID --parent-wallet-id=ID --destination-address=ADDR --amount-sats=N --fee-rate=N [--prebuild-only]');
    process.exit(1);
  }

  try {
    const result = await sendExactWithCPFP(opts);
    console.log('\nALL DONE. Result:', JSON.stringify(result));
  } catch (e) {
    console.error('ERROR:', e && e.message);
    if (e && e.result) console.error(JSON.stringify(e.result, null, 2));
    process.exit(1);
  }
})();
