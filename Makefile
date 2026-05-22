SHELL := /bin/bash
.PHONY: transfer install run clean list-wallets update-wallets

transfer:
	@echo "=== Available Wallets ==="
	@cat wallets.txt
	@echo ""
	@echo "This will transfer exact sats between wallets (preserving ordinals)."
	@read -p "Who will fund the txs? " FEE_WALLET; \
	 FEE_ID=$$(grep "^$${FEE_WALLET} " wallets.txt | awk '{print $$2}'); \
	 if [ -z "$${FEE_ID}" ]; then echo "Error: Wallet '$${FEE_WALLET}' not found in wallets.txt"; exit 1; fi; \
	 echo "Fee wallet ID: $${FEE_ID}"; \
	 read -p "Who's sending wallet? " SEND_WALLET; \
	 SEND_ID=$$(grep "^$${SEND_WALLET} " wallets.txt | awk '{print $$2}'); \
	 if [ -z "$${SEND_ID}" ]; then echo "Error: Wallet '$${SEND_WALLET}' not found in wallets.txt"; exit 1; fi; \
	 echo "Sending wallet ID: $${SEND_ID}"; \
	 read -p "Destination BTC address (bc1... or 3... or 1...): " DEST_ADDR; \
	 if [ -z "$${DEST_ADDR}" ]; then echo "Error: Destination address cannot be empty"; exit 1; fi; \
	 echo "Destination: $${DEST_ADDR}"; \
	 read -p "Amount of sats: " AMOUNT; \
	 read -p "Fee rate (sat/kB) [2000]: " FEERATE; \
	 FEERATE=$${FEERATE:-2000}; \
	 echo ""; \
	 echo "Summary: $${SEND_WALLET} -> $${DEST_ADDR} ($${AMOUNT} sats), fees paid by $${FEE_WALLET}"; \
	 read -p "Prebuild only? (y/N): " PRE; \
	 if [ "$${PRE}" = "y" -o "$${PRE}" = "Y" ]; then \
		 echo "Running prebuild-only (no broadcast)."; \
		 node send_exact_cpfp.js --fee-wallet-id="$${FEE_ID}" --parent-wallet-id="$${SEND_ID}" --destination-address="$${DEST_ADDR}" --amount-sats=$${AMOUNT} --fee-rate=$${FEERATE} --prebuild-only; \
	 else \
		 read -s -p "Wallet passphrase (will be written to /tmp/bitgo.pass temporarily): " WP; echo; \
		 printf '%s' "$$WP" > /tmp/bitgo.pass; chmod 600 /tmp/bitgo.pass; \
		 echo "Proceeding to broadcast. Press Enter to continue or Ctrl-C to cancel."; read -r; \
		 node send_exact_cpfp.js --fee-wallet-id="$${FEE_ID}" --parent-wallet-id="$${SEND_ID}" --destination-address="$${DEST_ADDR}" --amount-sats=$${AMOUNT} --fee-rate=$${FEERATE}; \
		 rm -f /tmp/bitgo.pass; \
	 fi

install:
	npm ci

list-wallets:
	@node list_wallets.js

update-wallets:
	@node list_wallets.js --update
	@echo ""
	@echo "Updated wallets:"
	@cat wallets.txt

run: install
	node cpfp_run.js

clean:
	rm -f prebuild.json send_result.json cpfp_run.log prebuild_*.json