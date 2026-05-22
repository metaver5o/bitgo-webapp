#!/usr/bin/env node
/*
  Local server for BitGo Ordinal Transfer UI
  Run: node server.js  →  http://localhost:3000
*/

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');

const app  = express();
const PORT = 3000;
const PASS_FILE   = path.resolve('./.bitgo-pass');
const TOKEN_FILE  = path.resolve('.ACCESS_TOKEN_OVERRIDE');
const ENV_FILE    = path.resolve('.env');
const CACHE_FILE  = path.resolve('.wallets-cache.json'); // stores label+id+balance

// Initialize app with saved token on startup
function loadTokenOnStartup() {
  let loadedToken = '';
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      loadedToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    } catch (_) {}
  } else if (fs.existsSync(ENV_FILE)) {
    const match = fs.readFileSync(ENV_FILE, 'utf8').match(/ACCESS_TOKEN="([^"]*)"/);
    if (match) loadedToken = match[1];
  }

  if (loadedToken && !process.env.TEST_MODE) {
    console.log(`[startup] Token loaded: ${loadedToken.slice(0,4)}...${loadedToken.slice(-2)}`);
  }
}
loadTokenOnStartup();

app.use(cors());
app.use(bodyParser.json());

app.get('/', (req, res) => res.sendFile(path.resolve('index.html')));

// Helper: write token to both files so all scripts find it
function writeToken(token) {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token.trim(), { mode: 0o600 });
    fs.writeFileSync(ENV_FILE, `ACCESS_TOKEN="${token.trim()}"\n`, { mode: 0o600 });
  } catch (e) {
    // If .env fails (might be read-only), just write TOKEN_FILE
    try {
      fs.writeFileSync(TOKEN_FILE, token.trim(), { mode: 0o600 });
    } catch (_) {
      throw new Error('Cannot write token file. Check folder is writable.');
    }
  }
}

// Helper: sync TOKEN_FILE → ENV_FILE if needed
function ensureEnvFile() {
  if (!fs.existsSync(ENV_FILE) && fs.existsSync(TOKEN_FILE)) {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    fs.writeFileSync(ENV_FILE, `ACCESS_TOKEN="${token}"\n`, { mode: 0o600 });
  }
}

// Helper: parse list_wallets.js stdout into [{label, id, balance}]
function parseWalletOutput(stdout) {
  const wallets = [];
  // list_wallets.js prints blocks like:
  //   walletname
  //     ID: <id>
  //     Balance: <sats> sats
  const blocks = stdout.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const idLine  = lines.find(l => l.startsWith('ID:'));
    const balLine = lines.find(l => l.startsWith('Balance:'));
    const label   = lines.find(l => !l.startsWith('ID:') && !l.startsWith('Balance:') && l.length > 0);
    if (idLine && label) {
      const id      = idLine.replace('ID:', '').trim();
      const balance = balLine ? parseInt(balLine.replace('Balance:', '').replace('sats', '').trim()) || 0 : 0;
      wallets.push({ label, id, balance });
    }
  }
  return wallets;
}

// GET /api/token — returns the saved token for loading in browser
app.get('/api/token', (req, res) => {
  let token = '';
  // Try .env first (standard practice), then TOKEN_FILE
  if (fs.existsSync(ENV_FILE)) {
    try {
      const match = fs.readFileSync(ENV_FILE, 'utf8').match(/ACCESS_TOKEN="([^"]*)"/);
      if (match) {
        token = match[1];
        return res.json({ token, source: '.env' });
      }
    } catch (_) {}
  }
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      return res.json({ token, source: 'TOKEN_FILE' });
    } catch (_) {}
  }
  res.status(404).json({ error: 'No token saved. Save one first via /api/token POST.' });
});

// POST /api/token
app.post('/api/token', (req, res) => {
  const { token } = req.body;
  if (!token || !token.trim()) return res.status(400).json({ error: 'Token is required' });
  try {
    writeToken(token);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/wallets — load from cache if available, else wallets.txt
app.post('/api/wallets', (req, res) => {
  // Prefer cache (has balances)
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      return res.json({ wallets: cached, source: 'cache' });
    } catch (_) {}
  }
  // Fallback: wallets.txt (no balances)
  const walletsFile = path.resolve('wallets.txt');
  if (!fs.existsSync(walletsFile)) {
    return res.status(404).json({ error: 'wallets.txt not found. Click "Refresh from BitGo" to fetch wallets.' });
  }
  try {
    const lines = fs.readFileSync(walletsFile, 'utf8')
      .split('\n').map(l => l.trim()).filter(Boolean);
    const wallets = lines.map(line => {
      const parts = line.split(/\s+/);
      const id    = parts[parts.length - 1];
      const label = parts.slice(0, parts.length - 1).join(' ');
      return { label, id, balance: null }; // no balance from wallets.txt
    });
    res.json({ wallets, source: 'wallets.txt' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/wallets/refresh — run list_wallets.js, parse balances, cache result
app.post('/api/wallets/refresh', (req, res) => {
  if (!fs.existsSync(ENV_FILE) && !fs.existsSync(TOKEN_FILE)) {
    return res.status(400).json({ error: 'No access token found. Please save your token first.' });
  }
  try { ensureEnvFile(); } catch (e) {
    return res.status(500).json({ error: 'Failed to sync token: ' + e.message });
  }

  const child = spawn('node', ['list_wallets.js', '--update'], { cwd: path.resolve('.') });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.on('close', (code, signal) => {
    console.log(`[transfer] exit code=${code} signal=${signal}`);
    if (code !== 0) {
      return res.status(500).json({ error: (err || out || 'list_wallets.js failed').trim() });
    }

    // Parse balances from stdout
    const wallets = parseWalletOutput(out);

    // Auto-detect custody wallets by calling BitGo API for each wallet
    let detectedCustody = {};
    try {
      const bitgo = require('bitgo');
      const tokenFile = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').match(/ACCESS_TOKEN="([^"]*)"/)?.[1] : '';
      const tokenFile2 = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '';
      const accessToken = tokenFile || tokenFile2;

      if (accessToken) {
        const bitgoApi = new bitgo.BitGo({ env: 'prod', accessToken });
        for (const w of wallets) {
          try {
            const wallet = bitgoApi.coin('btc').wallets().get({ id: w.id });
            const walletData = wallet.get();
            // Custody if: signBfdTransaction exists OR no hardwareKeyFingerprint
            detectedCustody[w.id] = !!walletData.signBfdTransaction || !walletData.hardwareKeyFingerprint;
          } catch (e) {
            // Skip if API call fails, will default to self-custody
          }
        }
      }
    } catch (e) {
      console.log('[transfer] Could not auto-detect custody wallets:', e.message);
    }

    // Add custody flag to each wallet object
    for (const w of wallets) {
      if (detectedCustody[w.id]) {
        w.isCustody = detectedCustody[w.id];
        w.custodyLabel = ' [CUSTODY]';
      } else {
        w.isCustody = false;
        w.custodyLabel = '';
      }
    }
    // If parsing failed, fall back to wallets.txt without balances
    if (wallets.length === 0 && fs.existsSync(path.resolve('wallets.txt'))) {
      try {
        const lines = fs.readFileSync(path.resolve('wallets.txt'), 'utf8')
          .split('\n').map(l => l.trim()).filter(Boolean);
        const fallback = lines.map(line => {
          const parts = line.split(/\s+/);
          const id    = parts[parts.length - 1];
          const label = parts.slice(0, parts.length - 1).join(' ');
          return { label, id, balance: null };
        });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(fallback, null, 2));
        return res.json({ wallets: fallback, source: 'wallets.txt' });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
    // Save cache with balances
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(wallets, null, 2)); } catch (_) {}
    res.json({ wallets, source: 'bitgo' });
  });
});

// POST /api/transfer — run script, buffer all output, return when done
app.post('/api/transfer', (req, res) => {
  const { feeWalletId, parentWalletId, destinationAddress, amountSats, feeRate, passphrase, prebuildOnly } = req.body;

  if (!feeWalletId || !parentWalletId || !destinationAddress || !amountSats || !feeRate) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!prebuildOnly && !passphrase) {
    return res.status(400).json({ error: 'Passphrase is required when not in prebuild-only mode' });
  }

  try {
    fs.writeFileSync(PASS_FILE, passphrase || 'prebuild-only', { mode: 0o600 });
  } catch (e) {
    return res.status(500).json({ error: `Failed to write passphrase: ${e.message}` });
  }

  const args = [
    'send_exact_cpfp.js',
    `--fee-wallet-id=${feeWalletId}`,
    `--parent-wallet-id=${parentWalletId}`,
    `--destination-address=${destinationAddress}`,
    `--amount-sats=${amountSats}`,
    `--fee-rate=${feeRate}`,
  ];
  if (prebuildOnly) args.push('--prebuild-only');

  console.log(`[transfer] spawning: node ${args.join(' ')}`);

  const child = spawn('node', ['--max-old-space-size=512', ...args], {
    cwd: path.resolve('.'),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => { output += d.toString(); });

  child.on('close', (code, signal) => {
    console.log(`[transfer] exit code=${code} signal=${signal} output_len=${output.length}`);
    try { fs.unlinkSync(PASS_FILE); } catch (_) {}
    // Use res.json() — let Express handle Content-Length and encoding correctly
    res.json({ code, signal, output, success: code === 0 });
  });
});

app.listen(PORT, () => {
  console.log(`\n  BitGo Ordinal Transfer UI`);
  console.log(`  → http://localhost:${PORT}\n`);
});
