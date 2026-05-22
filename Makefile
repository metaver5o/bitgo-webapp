SHELL := /bin/bash
.PHONY: transfer install run clean list-wallets update-wallets docker-build docker-up docker-down docker-logs

run: install
	@echo "=== Launching Unified Multi-Provider UI ==="
	node server.js

install:
	npm ci

transfer:
	@echo "=== Choose Wallet Infrastructure Ecosystem ==="
	@echo "1) BitGo Enterprise (Server-Side Pipeline)"
	@echo "2) UniSat Wallet (Browser Extension API)"
	@echo "3) Xverse Wallet (Browser Extension API)"
	@read -p "Select provider [1-3]: " PROVIDER; \
	if [ "$${PROVIDER}" = "2" ] || [ "$${PROVIDER}" = "3" ]; then \
		echo "--> Web3 extensions run via browser execution context."; \
		echo "--> Spawning server platform at http://localhost:3000..."; \
		$(MAKE) run; \
	elif [ "$${PROVIDER}" = "1" ] || [ -z "$${PROVIDER}" ]; then \
		echo ""; \
		echo "=== BitGo Orchestration Setup ==="; \
		if [ ! -f wallets.txt ]; then echo "Error: wallets.txt missing. Run 'make update-wallets' first."; exit 1; fi; \
		cat wallets.txt; \
		echo ""; \
		read -p "Who will fund the txs? (Fee Wallet): " FEE_WALLET; \
		FEE_ID=$$(grep "^$${FEE_WALLET} " wallets.txt | awk '{print $$2}'); \
		if [ -z "$${FEE_ID}" ]; then echo "Error: Wallet '$${FEE_WALLET}' not found."; exit 1; fi; \
		read -p "Who's the sending wallet? (Asset Owner): " SEND_WALLET; \
		SEND_ID=$$(grep "^$${SEND_WALLET} " wallets.txt | awk '{print $$2}'); \
		if [ -z "$${SEND_ID}" ]; then echo "Error: Wallet '$${SEND_WALLET}' not found."; exit 1; fi; \
		read -p "Destination BTC address: " DEST_ADDR; \
		if [ -z "$${DEST_ADDR}" ]; then echo "Error: Destination address cannot be empty"; exit 1; fi; \
		read -p "Amount of sats: " AMOUNT; \
		read -p "Fee rate (sat/kB) [2000]: " FEERATE; \
		FEERATE=$${FEERATE:-2000}; \
		echo ""; \
		echo "Summary: $${SEND_WALLET} -> $${DEST_ADDR} ($${AMOUNT} sats), fees paid by $${FEE_WALLET}"; \
		read -p "Prebuild only? (y/N): " PRE; \
		if [ "$${PRE}" = "y" ] || [ "$${PRE}" = "Y" ]; then \
			node send_exact_cpfp.js --fee-wallet-id="$${FEE_ID}" --parent-wallet-id="$${SEND_ID}" --destination-address="$${DEST_ADDR}" --amount-sats=$${AMOUNT} --fee-rate=$${FEERATE} --prebuild-only; \
		else \
			read -s -p "Wallet passphrase: " WP; echo; \
			printf '%s' "$$WP" > /tmp/bitgo.pass; chmod 600 /tmp/bitgo.pass; \
			node send_exact_cpfp.js --fee-wallet-id="$${FEE_ID}" --parent-wallet-id="$${SEND_ID}" --destination-address="$${DEST_ADDR}" --amount-sats=$${AMOUNT} --fee-rate=$${FEERATE}; \
			rm -f /tmp/bitgo.pass; \
		fi \
	else \
		echo "Invalid choice selection."; exit 1; \
	fi

list-wallets:
	@node list_wallets.js

update-wallets:
	@node list_wallets.js --update
	@echo ""
	@echo "Updated wallets.txt config:"
	@cat wallets.txt

docker-build:
	docker compose build

docker-up:
	@touch wallets.txt .wallets-cache.json
	docker compose up -d
	@echo "=========================================================="
	@echo " Engine operating securely inside Docker: http://localhost:3000"
	@echo "=========================================================="

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f ordinal-engine

clean:
	rm -f prebuild.json send_result.json cpfp_run.log prebuild_*.json /tmp/bitgo.pass .wallets-cache.json