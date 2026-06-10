FROM node:20-alpine
RUN apk add --no-cache bash curl
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --only=production
COPY server.js index.html send_exact_cpfp.js list_wallets.js Makefile ./
COPY wallets.txt* ./
EXPOSE 3000
CMD ["node", "server.js"]
