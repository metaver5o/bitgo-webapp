# Multi-Provider Ordinal & Satoshi Range Transfer Engine

A clean, production-grade automated architecture for transferring exact Satoshi amounts (Ordinals/Runes) without satoshi drift, leakage, or accidental containment breach. This tool supports **BitGo Enterprise (Server-Side CPFP Pipeline)**, **UniSat Wallet**, and **Xverse Wallet (Sats Connect)** with integrated pre-flight slice generation and post-flight mempool auditing.

---

## ⚡ Architecture Improvements Added

* **Multi-Provider Web3 Interface:** Integrated browser extension runtime gateways for UniSat and Xverse alongside the server-side BitGo automated pipeline.
* **Fully Automated Mempool Range Slicing:** Completely removed manual sequence prompting. The engine queries the Mempool API and Ordinals Indexer to dynamically compute front-padding, protected assets, and back-padding parameters while strictly maintaining dust floor thresholds ($546\text{ sats}$).
* **Real-time Post-Flight Audit Engine:** Synchronously watches public and local mempools to verify transaction propagation, output integrity, and to ensure $0\text{ satoshi}$ variance against pre-flight math.
* **Global Testing Tunnel (`cloudflared`):** Containerized Cloudflare Quick Tunnel profile to securely expose your sandbox interface over an institutional HTTPS gateway (`.trycloudflare.com`) for cross-device web3 extension testing.

---

## 🛠️ Infrastructure Component Breakdown

```text
├── index.html               # Unified Frontend Terminal & Web3 Slicing Engine
├── server.js                # Express App Serving APIs & Spawning BitGo Runtimes
├── send_exact_cpfp.js       # Core BitGo Orchestrator & CPFP Pipeline
├── list_wallets.js          # BitGo Account Enumeration & Cache Indexer
├── Makefile                 # System Automation Entrypoints
├── Dockerfile               # High-Performance Node-Alpine Minimal Casing
└── docker-compose.yml       # Orchestration Stack with Isolated Cloudflared Profiling

```

---

## 🚀 Quickstart & Deployment

### Local Host Mode

1. **Install Dependencies & Start Server:**
```bash
make run

```


2. **Access the Interface:** Navigate to `http://localhost:5555` *(Port adjusted to avoid internal multi-stack network conflicts)*.

### Containerized Sandbox Mode

To run the service completely isolated within a Docker environment:

```bash
make docker-up

```

### Remote Web3 Testing Mode (Cloudflare Tunnel)

To test browser extensions from a remote machine, phone, or external staging network without setting up reverse proxies:

1. **Boot with the Tunnel Profile:**
```bash
docker compose --profile tunnel up -d

```


2. **Retrieve your Dynamic Secure Edge URL:**
```bash
docker compose logs cloudflared | grep trycloudflare.com

```


*This outputs an explicit global endpoint (e.g., `https://bulletin-tactics-thu-wiley.trycloudflare.com`) that routes external Web3 calls straight into your local container network.*

---

## 🔬 Core Mechanics

### 1. Pre-Flight Automation & Slicing Matrix

The engine avoids accidental spent-asset destruction by fetching unspent transaction outputs (UTXOs) from the mempool layer and calculating explicit bounds:

$$\text{UTXO Total Balance} = \text{Front Padding} + \text{Target Protected Asset} + \text{Back Padding} + \text{Network Fee}$$

If the remaining front or back padding calculation drops below the standard network dust ceiling ($546\text{ sats}$), the engine automatically halts execution to enforce a strict containment guard.

### 2. Post-Flight Audit Verification Loop

Once a transaction signature array is broadcast via a Web3 gateway or BitGo, the audit loop polls mempool indices to confirm output sizes:

* **Matches Expected:** Confirms perfect execution with zero satoshi drift.
* **Discrepancy Detected:** Flags a structural alignment fault immediately in the terminal log view.

---

## 🛡️ Operational Security & Environment Alignment

* **Strict Binding:** The underlying Node application listens globally across container networks via `0.0.0.0:3000`, mapping cleanly to host port `5555`.
* **Token Isolation:** Access credentials can be written to `.ACCESS_TOKEN_OVERRIDE` or managed directly through the UI gateway.
* **Passphrase Security:** Passphrases sent to the BitGo processing layer are strictly structured via transient file systems and cleared immediately following process exits.
