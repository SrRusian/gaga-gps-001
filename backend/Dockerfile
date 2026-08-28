FROM node:22-bookworm-slim AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY web/package.json web/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY web/packages/client/package.json web/packages/client/package.json
COPY web/packages/map-core/package.json web/packages/map-core/package.json
COPY web/packages/ui/package.json web/packages/ui/package.json
COPY app/packages/android-bridge/package.json app/packages/android-bridge/package.json
COPY app/packages/operator-ui/package.json app/packages/operator-ui/package.json
RUN npm ci

FROM deps AS build

COPY config/tsconfig.base.json config/tsconfig.base.json
COPY backend/tsconfig.json backend/tsconfig.json
COPY backend/src backend/src
COPY web/tsconfig.json web/vite.config.ts web/index.html web/
COPY web/src web/src
COPY packages/shared-types/src packages/shared-types/src
COPY web/packages/client/src web/packages/client/src
COPY web/packages/map-core/src web/packages/map-core/src
COPY web/packages/ui/src web/packages/ui/src
COPY app/packages/android-bridge/src app/packages/android-bridge/src
COPY app/packages/operator-ui/src app/packages/operator-ui/src

RUN npm run build

RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends gdal-bin python3-gdal \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app ./

RUN rm -rf web
COPY --from=build /app/web/dist ./web

RUN mkdir -p /app/maps/sources /app/maps/tmp \
    && chown -R node:node /app

USER node
WORKDIR /app/backend

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
    CMD node -e "require('http').get('http://localhost:3001/health',res=>{process.exit(res.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/app.js"]
