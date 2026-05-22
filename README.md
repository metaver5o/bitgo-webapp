# BitGo Ordinals Transfer ToolMinimal folder to reproduce the exact 5,000 sats send flow.



Clean, minimal tool for transferring exact satoshi amounts (ordinals) between BitGo wallets while preserving sat ranges.Files included:

- `prebuild_5000.json` — the BitGo prebuild response (txHex, feeInfo)

## Problem Solved- `run.sh` — a small script that walks through validate -> prebuild -> send using `.ACCESS_TOKEN_OVERRIDE` and a passfile

- `.env.example` — sample env showing where to put ACCESS_TOKEN

When transferring ordinals between wallets, you need to:- `package.json` — minimal dependencies for Node helper

1. **Preserve exact sat amounts** (can't use them as fees)- `.gitignore` — exclude secrets

2. **Have a separate wallet pay transaction fees**- `config.example.json` — example runtime configuration for `cpfp_run.js`

3. **Prove the same sats moved through multiple wallets**- `cpfp_run.js` — configurable runner (prebuild → sign → send)

- `cpfp_child.js` — child tx helper (if present)

BitGo's API doesn't support mixing inputs from different wallets in a single transaction, so this tool implements an automatic funding + CPFP strategy.

Usage: edit `.env.example` or create `.ACCESS_TOKEN_OVERRIDE` in this folder, add your passphrase to `/tmp/bitgo.pass` (or change `run.sh`), then run `./run.sh`.

## How It Works

Runner and automation

**Strategy:** If sender wallet lacks funds for fees, fee-paying wallet automatically funds it first, then sender transfers exact ordinals.---------------------

You can put dynamic values into `config.json` (use `config.example.json` as a template) and then run:

**Example Flow:** Transfer 500 ordinal sats from `btc` → `alice` with `5K` paying all fees:

```bash

1. **Auto-funding** (if needed): `5K` sends 546+ sats to `btc` for fee paymentcd FINAL

2. **Wait for indexing**: Script polls until BitGo indexes the funding txmake run

3. **Transfer ordinals**: `btc` sends exact 500 sats to `alice` ```

4. **CPFP acceleration**: `5K` creates high-fee tx to accelerate confirmation

Or with Docker Compose:

Result: **Exact 500 ordinal sats** arrive at alice, all fees paid by 5K wallet.

```bash

## Setupcd FINAL

docker compose up --build --abort-on-container-exit

### 1. Install Dependencies```



```bashThe runner will prebuild the transaction and save `prebuild.json` for inspection, then read `/tmp/bitgo.pass` for the wallet passphrase and sign/send the transaction. Results are written to `send_result.json` and logged to `cpfp_run.log`.

npm install

```Notes and next improvements

- Add a simple frontend to edit config and show status (we can add a lightweight React app served by the node backend and a docker-compose service).

### 2. Configure Wallets- Implement sats-range verification against ordinals explorer (this requires pulling ordinals data; we can integrate with an ordinals API or scrape the site).

- Be careful with tokens and passphrases — do not commit secrets. Use `.gitignore` (already present) and the provided `.env.example`.

Edit `wallets.txt` with your wallet names and IDs:Minimal folder to reproduce the exact 5,000 sats send flow.



```Files included:

btc 68e861f32a71afbb33dcc7110179e695- `prebuild_5000.json` — the BitGo prebuild response (txHex, feeInfo)

5K 68e863476a4cefcc84e1b4f25eea7a98- `run.sh` — a small script that walks through validate -> prebuild -> send using `.ACCESS_TOKEN_OVERRIDE` and a passfile

alice 690bbad191dc411eda2e14e5e7e6ac75- `.env.example` — sample env showing where to put ACCESS_TOKEN

bob 690bbb03e17d39ddac16dd64aeff15df- `package.json` — minimal dependencies for Node helper

```- `.gitignore` — exclude secrets



### 3. Configure Access TokenUsage: edit `.env.example` or create `.ACCESS_TOKEN_OVERRIDE` in this folder, add your passphrase to `/tmp/bitgo.pass` (or change `run.sh`), then run `./run.sh`.


Create `.env` file:

```bash
ACCESS_TOKEN="v2x..."
WALLET_ID=your_default_wallet_id
```

Get your token from BitGo dashboard with these permissions:
- Wallet - View all
- Wallet - Spend
- Wallet - Create

**Important:** Set IP restriction to your current IP for security.

## Usage

### Interactive Transfer

```bash
make transfer
```

Follow the prompts:
- **Who will fund the txs?** → Wallet that pays all transaction fees (e.g., `5K`)
- **Who's sending wallet?** → Wallet with ordinals to send (e.g., `btc`)
- **Who is receiving?** → Destination wallet (e.g., `alice`)
- **Amount of sats:** → Exact amount to transfer (e.g., `500`)
- **Fee rate (sat/kB):** → Press Enter for default 2000, or enter custom rate
- **Prebuild only?** → `y` to preview without broadcasting, `N` to execute

### Example Session

```
=== Available Wallets ===
btc 68e861f32a71afbb33dcc7110179e695
5K 68e863476a4cefcc84e1b4f25eea7a98
alice 690bbad191dc411eda2e14e5e7e6ac75
bob 690bbb03e17d39ddac16dd64aeff15df

Who will fund the txs? 5K
Who's sending wallet? btc
Who is receiving? alice
Amount of sats: 500
Fee rate (sat/kB) [2000]: 1000
Prebuild only? (y/N): N
```

The script will:
1. Check if sender has enough for amount + fee
2. Auto-fund from fee wallet if needed (>= 546 sats dust threshold)
3. Wait for funding to be indexed (up to 60 seconds)
4. Send exact ordinals from sender → receiver
5. Create CPFP from fee wallet to accelerate

## Files

- **`Makefile`** - Interactive CLI interface
- **`send_exact_cpfp.js`** - Main orchestrator script
- **`wallets.txt`** - Wallet configuration (name → ID mapping)
- **`.env`** - BitGo access token and settings
- **`package.json`** - Node.js dependencies

## Technical Details

### Why Auto-Funding?

Bitcoin has a **dust threshold** of 546 sats - outputs below this are rejected. If sender wallet only has the exact ordinal amount (e.g., 500 sats), it can't pay any fee. Solution: fee wallet sends 546+ sats to sender first.

### Why CPFP?

BitGo doesn't allow mixing inputs from different wallets. CPFP (Child Pays For Parent) creates a second transaction that references the first, paying a higher fee to accelerate both transactions together.

### Prebuild-Only Mode

Use `y` for prebuild-only to:
- Inspect transaction before broadcasting
- Verify fee amounts
- Review output addresses
- Check if auto-funding is needed

Generated files: `prebuild_parent.json`, `prebuild_step1.json`, `prebuild_step2.json`

## Common Issues

### "Sender wallet not yet funded"

The auto-funding transaction was sent but not yet indexed. Wait 1-2 minutes and retry.

### "sub-dust-threshold amount"

Trying to send < 546 sats. Bitcoin protocol rejects dust outputs.

### "insufficient funds"

Sender wallet doesn't have enough for amount + fee, and auto-funding failed. Check fee wallet balance.

### "Missing parameter: address"

Known BitGo SDK bug with `.send()` method. Script uses workaround: `prebuild → sign → submit`.

## Multi-Hop Transfers

To prove same sats moved through multiple wallets:

```bash
# Hop 1: btc → alice (5K pays fees)
make transfer
# Enter: 5K, btc, alice, 500

# Hop 2: alice → bob (5K pays fees)  
make transfer
# Enter: 5K, alice, bob, 500
```

After each hop, verify sat ranges with ordinals explorer to prove same sats moved.

## Security Notes

- **Passphrase storage**: Script writes passphrase to `/tmp/bitgo.pass` temporarily, deletes after use
- **IP restrictions**: Strongly recommended on BitGo access tokens
- **Prebuild first**: Always test with prebuild-only mode before broadcasting
- **Production environment**: Uses BitGo production API (`env: 'prod'`)

## Troubleshooting

### Check wallet balances

```bash
node -e "
const BitGo = require('bitgo');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const token = env.match(/ACCESS_TOKEN=\"([^\"]+)\"/)[1];
const bitgo = new BitGo.BitGo({ env: 'prod', accessToken: token });

(async () => {
  const wallet = await bitgo.coin('btc').wallets().get({ id: 'WALLET_ID_HERE' });
  const unspents = await wallet.unspents();
  console.log('UTXOs:', unspents.unspents.map(u => \`\${u.id}: \${u.value} sats\`));
  console.log('Total:', unspents.unspents.reduce((s, u) => s + u.value, 0), 'sats');
})();
"
```

### View transaction on blockchain

```
https://mempool.space/tx/TXID_HERE
```

## License

MIT
