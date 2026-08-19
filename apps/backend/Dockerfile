FROM node:22-bookworm-slim AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/web-app/package.json apps/web-app/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/map-core/package.json packages/map-core/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm ci

FROM deps AS build

COPY tsconfig.base.json ./
COPY apps/backend/tsconfig.json apps/backend/tsconfig.json
COPY apps/backend/src apps/backend/src
COPY apps/web-app/tsconfig.json apps/web-app/vite.config.ts apps/web-app/index.html apps/web-app/
COPY apps/web-app/src apps/web-app/src
COPY packages/shared-types/src packages/shared-types/src
COPY packages/client/src packages/client/src
COPY packages/map-core/src packages/map-core/src
COPY packages/ui/src packages/ui/src

RUN npm run build

RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends gdal-bin python3-gdal \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app ./

RUN rm -rf apps/web-app
COPY --from=build /app/apps/web-app/dist ./apps/web-app

RUN mkdir -p /app/maps/sources /app/maps/tmp \
    && chown -R node:node /app

USER node
WORKDIR /app/apps/backend

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
    CMD node -e "require('http').get('http://localhost:3001/health',res=>{process.exit(res.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/app.js"]
