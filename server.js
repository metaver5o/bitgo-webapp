#!/usr/bin/env node
const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const PASS_FILE   = path.resolve('./.bitgo-pass');
const TOKEN_FILE  = path.resolve('.ACCESS_TOKEN_OVERRIDE');
const ENV_FILE    = path.resolve('.env');
const CACHE_FILE  = path.resolve('.wallets-cache.json');

app.use(cors());
app.use(bodyParser.json());

app.get('/', (req, res) => res.sendFile(path.resolve('index.html')));

app.get('/api/token', (req, res) => {
  if (fs.existsSync(TOKEN_FILE)) {
    try { return res.json({ token: fs.readFileSync(TOKEN_FILE, 'utf8').trim() }); } catch (_) {}
  }
  res.status(404).json({ error: 'No token found.' });
});

app.post('/api/token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token field required.' });
  fs.writeFileSync(TOKEN_FILE, token.trim(), { mode: 0o600 });
  fs.writeFileSync(ENV_FILE, `ACCESS_TOKEN="${token.trim()}"\n`, { mode: 0o600 });
  res.json({ success: true });
});

app.post('/api/wallets', (req, res) => {
  if (fs.existsSync(CACHE_FILE)) {
    try { return res.json({ wallets: JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) }); } catch (_) {}
  }
  res.json({ wallets: [] });
});

app.post('/api/wallets/refresh', (req, res) => {
  const child = spawn('node', ['list_wallets.js', '--update'], { cwd: path.resolve('.') });
  let out = '';
  child.stdout.on('data', d => { out += d.toString(); });
  child.on('close', () => {
    const wallets = [];
    const blocks = out.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      const idLine  = lines.find(l => l.startsWith('ID:'));
      const label   = lines.find(l => !l.startsWith('ID:') && l.length > 0);
      if (idLine && label) {
        wallets.push({ label, id: idLine.replace('ID:', '').trim() });
      }
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(wallets, null, 2));
    res.json({ wallets });
  });
});

app.post('/api/transfer', (req, res) => {
  const { feeWalletId, parentWalletId, destinationAddress, amountSats, feeRate, passphrase, prebuildOnly } = req.body;

  try {
    fs.writeFileSync(PASS_FILE, passphrase || 'prebuild_bypass', { mode: 0o600 });
  } catch (e) {
    return res.status(500).json({ error: `Could not isolate secure path mapping: ${e.message}` });
  }

  const args = [
    'send_exact_cpfp.js',
    `--fee-wallet-id=${feeWalletId}`,
    `--parent-wallet-id=${parentWalletId}`,
    `--destination-address=${destinationAddress}`,
    `--amount-sats=${amountSats}`,
    `--fee-rate=${feeRate}`
  ];
  if (prebuildOnly) args.push('--prebuild-only');

  const child = spawn('node', args, { cwd: path.resolve('.') });
  let output = '';
  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => { output += d.toString(); });

  child.on('close', (code) => {
    try { fs.unlinkSync(PASS_FILE); } catch (_) {}
    res.json({ output, success: code === 0 });
  });
});

// Ensure it explicitly binds to 0.0.0.0, NOT just port
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Unified Engine Backend Operational Layer Running`);
  console.log(`  -> Listening on all interfaces (0.0.0.0:${PORT})\n`);
});