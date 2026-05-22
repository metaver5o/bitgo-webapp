#!/usr/bin/env node
/*
List all BitGo wallets and optionally update wallets.txt

Usage:
  node list_wallets.js              # Just list wallets
  node list_wallets.js --update     # Update wallets.txt with all wallets
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
  throw new Error('No .env file found or ACCESS_TOKEN not set');
}

(async () => {
  const token = readToken();
  const bitgo = new BitGo.BitGo({ env: 'prod', accessToken: token });
  
  console.log('Fetching all Bitcoin wallets...\n');
  
  const coin = bitgo.coin('btc');
  const walletsResult = await coin.wallets().list();
  const wallets = walletsResult.wallets;
  
  console.log(`Found ${wallets.length} wallet(s):\n`);
  
  const entries = [];
  
  for (const wallet of wallets) {
    const id = wallet.id();
    const label = wallet.label() || 'unnamed';
    
    // Get balance
    const balance = wallet.balance();
    const balanceSats = balance || 0;
    
    console.log(`  ${label}`);
    console.log(`    ID: ${id}`);
    console.log(`    Balance: ${balanceSats} sats`);
    console.log('');
    
    entries.push({ label, id, balance: balanceSats });
  }
  
  if (argv.update) {
    console.log('Updating wallets.txt...');
    
    // Format: label id
    const lines = entries.map(e => `${e.label} ${e.id}`).join('\n');
    fs.writeFileSync('wallets.txt', lines + '\n');
    
    console.log('✓ wallets.txt updated with all wallets');
  } else {
    console.log('To update wallets.txt, run: node list_wallets.js --update');
  }
})().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
