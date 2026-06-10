# BitGo Ordinal Transfer Tool

Web UI + CLI for transferring exact satoshi UTXOs (ordinals) between BitGo wallets while preserving sat ranges. A separate fee wallet pays all transaction fees.

## Problem

When moving ordinals:
1. Exact sat amounts must be preserved — they can't be consumed as fees.
2. BitGo doesn't allow mixing inputs from different wallets in one TX.
3. If the sender wallet only holds the ordinal amount, it has no sats left for fees.

## Solution

Auto-funding + CPFP strategy:

1. **Fund check** — if sender can't cover fees, fee wallet sends 546+ sats to sender first (dust threshold minimum).
2. **Wait for indexing** — polls until BitGo indexes the funding TX (up to 60s).
3. **Transfer** — sender sends exact ordinal sats to destination address.
4. **CPFP** — fee wallet creates a high-fee child TX referencing the parent, accelerating both.

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure wallets

Edit `wallets.txt` (format: `name id`):

```
btc  68e861f32a71afbb33dcc7110179e695
5K   68e863476a4cefcc84e1b4f25eea7a98
alice 690bbad191dc411eda2e14e5e7e6ac75
bob  690bbb03e17d39ddac16dd64aeff15df
```

Or use **Refresh from BitGo** in the web UI to auto-populate.

### 3. Configure access token

Create `.env`:

```
ACCESS_TOKEN="v2x..."
```

Get your token from the BitGo dashboard with:
- Wallet: View all
- Wallet: Spend
- Wallet: Create

Set IP restriction to your current IP (or `0.0.0.0/0` if you get IP-restriction errors).

## Usage

### Web UI

```bash
node server.js
# open http://localhost:3000
```

Steps:
1. Enter and save your BitGo access token.
2. Load or refresh wallets.
3. Select sender and fee wallets.
4. Enter destination address, amount (sats), and fee rate (sat/kB).
5. Enter wallet passphrase.
6. Optionally check **Prebuild only** to inspect without broadcasting.
7. Click **Run Transfer**.

### CLI (interactive)

```bash
make transfer
```

Prompts for fee wallet, sender wallet, destination address, amount, fee rate, and passphrase.

### CLI (direct)

```bash
node send_exact_cpfp.js \
  --fee-wallet-id=ID \
  --parent-wallet-id=ID \
  --destination-address=bc1p... \
  --amount-sats=5000 \
  --fee-rate=1000 \
  [--prebuild-only]
```

Passphrase must be in `.bitgo-pass` (chmod 600) in the working directory.

## Files

| File | Purpose |
|------|---------|
| `server.js` | Express backend; serves UI and REST API |
| `index.html` | Web UI |
| `send_exact_cpfp.js` | Core transfer orchestrator |
| `list_wallets.js` | List BitGo BTC wallets; optionally update `wallets.txt` |
| `Makefile` | CLI interface |
| `wallets.txt` | Wallet name → ID mapping |
| `prebuild_parent.json` | Last saved parent TX prebuild (audit) |
| `prebuild_cpfp.json` | Last saved CPFP TX prebuild (audit) |

## API

All endpoints served by `server.js` on port 3000.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/token` | Return saved access token |
| POST | `/api/token` | Save access token to `.env` and `.ACCESS_TOKEN_OVERRIDE` |
| POST | `/api/wallets` | Return wallets from cache or `wallets.txt` |
| POST | `/api/wallets/refresh` | Fetch live wallets + balances from BitGo; update cache |
| POST | `/api/transfer` | Run transfer script; return buffered output |

`POST /api/transfer` body:

```json
{
  "feeWalletId": "...",
  "parentWalletId": "...",
  "destinationAddress": "bc1p...",
  "amountSats": 5000,
  "feeRate": 1000,
  "passphrase": "...",
  "prebuildOnly": false
}
```

## Common Issues

**"Sender wallet not yet funded"** — funding TX not yet indexed; wait 1-2 min and retry.

**"sub-dust-threshold amount"** — amount < 546 sats; Bitcoin rejects outputs below dust threshold.

**"insufficient funds"** — sender and fee wallet together can't cover amount + fees.

**"Missing parameter: address"** — BitGo SDK bug with `.send()`; the script works around it using `prebuild → sign → submit`.

**"IP-restricted token"** — your token has IP restrictions; create a new one with `0.0.0.0/0` or set the correct IP.

## Multi-hop transfers

To prove the same sats moved through multiple wallets:

```bash
# Hop 1: btc → alice (5K pays fees)
make transfer   # fee=5K, sender=btc, dest=alice addr, amount=500

# Hop 2: alice → bob (5K pays fees)
make transfer   # fee=5K, sender=alice, dest=bob addr, amount=500
```

Verify sat ranges with an ordinals explorer after each hop.

## Security

- Passphrase is written to `.bitgo-pass` temporarily and deleted immediately after the script exits.
- Set IP restrictions on BitGo access tokens.
- Always run prebuild-only first to inspect before broadcasting.
- Never commit `.env`, `.ACCESS_TOKEN_OVERRIDE`, or `.bitgo-pass`.
