# Build (desde la raíz del repo):
#   docker build -f backend/Dockerfile -t gaga-backend .
# O simplemente (recomendado — levanta todo el stack):
#   docker compose up -d --build

FROM node:22-bookworm-slim AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends gdal-bin python3-gdal \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/backend/node_modules ./backend/node_modules

# Código del backend
COPY backend/package.json backend/package-lock.json ./backend/
COPY backend/src ./backend/src
COPY backend/scripts ./backend/scripts

# UIs estáticas
COPY ui-admin ./ui-admin
COPY ui-operator ./ui-operator
COPY ui-supervisor ./ui-supervisor

RUN mkdir -p /app/maps/sources /app/maps/tmp \
    && chown -R node:node /app

USER node
WORKDIR /app/backend

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
    CMD node -e "require('http').get('http://localhost:3001/health',res=>{process.exit(res.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "src/app.js"]
