# Build (desde la raíz del repo):
#   docker build -f apps/backend/Dockerfile -t gaga-backend .
# O simplemente (recomendado - levanta todo el stack):
#   docker compose up -d --build
#
# Monorepo: backend TypeScript compilado a JS puro; el frontend es
# una sola SPA (apps/web-app, React + TypeScript + React Router,
# arquitectura feature-driven con code-splitting por rol) compilada a
# estático - el contenedor final solo corre/sirve artefactos ya
# construidos, sin TypeScript fuente ni devDependencies.

FROM node:22-bookworm-slim AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Todo el monorepo comparte un solo lockfile (npm workspaces) - hace
# falta el package.json de cada workspace (no solo el del backend)
# para que "npm ci" resuelva las referencias cruzadas entre paquetes.
# Con devDependencies (typescript, vite, @types/*) - esta etapa
# alimenta el build, no el contenedor final.
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/web-app/package.json apps/web-app/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/map-core/package.json packages/map-core/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm ci

FROM deps AS build

# Los packages/* se consumen como TypeScript fuente (sin build
# propio) - tsc/vite necesitan su código para resolver los tipos e
# incluirlo en el bundle, aunque no se compilan por separado.
COPY tsconfig.base.json ./
COPY apps/backend/tsconfig.json apps/backend/tsconfig.json
COPY apps/backend/src apps/backend/src
COPY apps/web-app/tsconfig.json apps/web-app/vite.config.ts apps/web-app/index.html apps/web-app/
COPY apps/web-app/src apps/web-app/src
COPY packages/shared-types/src packages/shared-types/src
COPY packages/client/src packages/client/src
COPY packages/map-core/src packages/map-core/src
COPY packages/ui/src packages/ui/src

# tsc (backend) + vite build (web-app) - cualquier workspace con
# script "build" (ver npm run build en package.json raíz).
RUN npm run build

# Poda devDependencies del mismo node_modules ya resuelto - más
# rápido y más simple que una segunda instalación limpia con un
# subconjunto distinto de manifests. Ya no hace falta para servir
# nada (el backend corre compilado, la UI es estático puro), pero sí
# para healthcheck/troubleshooting con las mismas deps que producción.
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends gdal-bin python3-gdal \
    && rm -rf /var/lib/apt/lists/*

# node_modules ya podado (solo dependencias de producción) + el JS
# compilado del backend (apps/backend/dist) - nada de TypeScript
# fuente ni devDependencies llegan a la imagen final.
COPY --from=build /app ./

# UI - reemplaza apps/web-app por el estático ya construido
# (dist/index.html + assets/), en el mismo mount point que ya espera
# app.ts (express.static(../../web-app) + fallback de SPA).
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
