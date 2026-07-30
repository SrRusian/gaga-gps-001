# syntax=docker/dockerfile:1
#
# Dockerfile del backend GAGA-GPS — pensado para construirse con el
# CONTEXTO EN LA RAÍZ DEL REPO (no en backend/), porque el propio
# backend sirve las 3 UIs estáticas (ui-admin/, ui-operator/,
# ui-supervisor/) como hermanas de backend/ vía express.static
# (ver backend/src/app.js). Por eso no hay Dockerfiles separados
# para el frontend: no son apps con su propio build/servidor, son
# HTML servidos tal cual por este mismo proceso Node.
#
# Build (desde la raíz del repo):
#   docker build -f backend/Dockerfile -t gaga-backend .
# O simplemente:
#   docker compose -f docker-compose.prod.yml up -d --build

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

COPY --from=deps /app/backend/node_modules ./backend/node_modules

# Código del backend
COPY backend/package.json backend/package-lock.json ./backend/
COPY backend/src ./backend/src
COPY backend/scripts ./backend/scripts

# UIs estáticas
COPY ui-admin ./ui-admin
COPY ui-operator ./ui-operator
COPY ui-supervisor ./ui-supervisor

# Carpeta de mapas (.mbtiles).
RUN mkdir -p /app/maps \
    && chown -R node:node /app

USER node
WORKDIR /app/backend

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
    CMD node -e "require('http').get('http://localhost:3001/health',res=>{process.exit(res.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "src/app.js"]
