# The department workspace: Vite build, then Express serving both the built
# UI and the API from one port.
#
# better-sqlite3 is a native module, so it is compiled in a builder stage and
# only the result is carried forward - the toolchain does not belong in the
# image that faces the internet.
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && apk del python3 make g++
COPY server ./server
COPY --from=build /app/dist ./dist

# SQLite lives on a volume, not in the image.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production
ENV API_PORT=8130
ENV API_HOST=0.0.0.0
ENV MHA_DATABASE_PATH=/data/mha-grievance.sqlite
EXPOSE 8130

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8130/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
