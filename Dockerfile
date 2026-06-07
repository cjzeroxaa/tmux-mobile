FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.mjs ./
COPY lib ./lib
COPY public ./public

CMD ["node", "server.mjs", "--controller"]
