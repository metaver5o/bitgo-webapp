FROM node:20-alpine
RUN apk add --no-cache bash curl
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --only=production
COPY server.js ./
COPY index.html ./
COPY send_exact_cpfp.js ./
COPY list_wallets.js ./
COPY wallets.txt* ./
EXPOSE 3000
ENV NODE_ENV=production
CMD [ "node", "server.js" ]