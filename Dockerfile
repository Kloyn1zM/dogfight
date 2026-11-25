# syntax=docker/dockerfile:1

# --- Stage 1: Build shared, server (pure JS), and client static bundle ---
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/tsconfig.json shared/tsconfig.build.json ./shared/
COPY server/package.json server/tsconfig.json server/tsconfig.build.json ./server/
COPY client/package.json client/tsconfig.json ./client/

RUN npm ci

COPY shared/src ./shared/src
COPY server/src ./server/src
COPY client/index.html client/vite.config.js ./client/
COPY client/public ./client/public
COPY client/src ./client/src

RUN npm run build

# --- Stage 2: Minimal production runtime (no devDependencies, non-root, < 200 MB) ---
FROM node:22-alpine AS runner

ARG GIT_SHA=dev

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_DIR=/app/logs \
    LOG_LEVEL=info \
    TRUST_PROXY=1 \
    GIT_SHA=${GIT_SHA}

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

RUN mkdir -p /app/logs && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Запускаємо node напряму (не npm start), щоб SIGTERM миттєво доходив до PID 1
CMD ["node", "server/dist/index.js"]
