#!/usr/bin/env bash
# Minimal runner for FINAL
# Run this from the FINAL directory (do NOT change directories in the script).
set -euo pipefail

if [ ! -f .ACCESS_TOKEN_OVERRIDE ]; then
  echo ".ACCESS_TOKEN_OVERRIDE not found in $(pwd). Create it with your BitGo access token." >&2
  exit 1
fi

TOKEN=$(head -n1 .ACCESS_TOKEN_OVERRIDE)
echo "Validating token..."
curl -s -H "Authorization: Bearer $TOKEN" https://app.bitgo.com/api/v2/user/me | jq .

echo "Prebuild file: prebuild_5000.json"
if [ -f prebuild_5000.json ]; then
  jq . prebuild_5000.json || true
else
  echo "prebuild_5000.json not found"
fi

if [ ! -f /tmp/bitgo.pass ]; then
  echo "Create /tmp/bitgo.pass with your wallet passphrase (chmod 600 /tmp/bitgo.pass) and re-run" >&2
  exit 0
fi

echo "Launching orchestrator (send_exact_cpfp.js) - edit arguments below as needed"
node send_exact_cpfp.js \
  --parent-wallet-id="68e861f32a71afbb33dcc7110179e695" \
  --intermediate-wallet-id="68e863476a4cefcc84e1b4f25eea7a98" \
  --final-address="REPLACE_WITH_FINAL_ADDR" \
  --amount-sats=5000 \
  --fee-rate=2000

# cleanup passfile
rm -f /tmp/bitgo.pass || true

echo "Done"
#!/usr/bin/env bash
# Minimal runner for FINAL
# Place .ACCESS_TOKEN_OVERRIDE in this folder or update DOTENV path
set -euo pipefail
cd "$(dirname "$0")"

# 1) Validate token
TOKEN=$(head -n1 .ACCESS_TOKEN_OVERRIDE)
echo "Validating token..."
curl -s -H "Authorization: Bearer $TOKEN" https://app.bitgo.com/api/v2/user/me | jq .

# 2) Show prebuild (we ship prebuild_5000.json)
echo "Prebuild file: prebuild_5000.json"
jq . prebuild_5000.json

# 3) Sign & send (reads /tmp/bitgo.pass)
if [ ! -f /tmp/bitgo.pass ]; then
  echo "Create /tmp/bitgo.pass with your wallet passphrase (chmod 600 /tmp/bitgo.pass) and re-run"
  exit 0
fi
PASS=$(head -n1 /tmp/bitgo.pass)
node -e "const fs=require('fs');const BitGo=require('bitgo');(async()=>{const token=fs.readFileSync('.ACCESS_TOKEN_OVERRIDE','utf8').trim();const pass=fs.readFileSync('/tmp/bitgo.pass','utf8').trim();const bitgo=new BitGo.BitGo({env:'prod',accessToken:token});const w=await bitgo.coin('btc').wallets().get({id:'68e861f32a71afbb33dcc7110179e695'});const res=await w.send({address:'bc1q4vxned489ztuugf07zhcpwaz57jhdkzgdxjefhsa85rhm84ug9qsetdczw',amount:'5000',walletPassphrase:pass,feeRate:20000,comment:'Mainnet: Sending exactly 5000 sats - preserving ordinals'});console.log(JSON.stringify(res,null,2));})().catch(e=>{console.error(e&&e.message); if(e.result) console.error(JSON.stringify(e.result,null,2)); process.exit(1)})"

# cleanup suggestion
printf '%s' '' > /tmp/bitgo.pass && rm -f /tmp/bitgo.pass || true

echo "Done"
