FROM node:22-alpine

WORKDIR /app

# Install dependencies first so a source-only change reuses the layer.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY migrations ./migrations
COPY public ./public
COPY test ./test

# Uploaded evidence lives on a volume, not in the image.
RUN mkdir -p /data/uploads && chown -R node:node /data /app
USER node

ENV NODE_ENV=production
EXPOSE 8120

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8120/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
