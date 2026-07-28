FROM node:22-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY backend/package*.json ./
RUN npm install --omit=dev

COPY backend/ ./
COPY ui-operator/ ./ui-operator/
COPY ui-supervisor/ ./ui-supervisor/
COPY ui-admin/ ./ui-admin/
COPY maps/ ./maps/

EXPOSE 3001

CMD ["node", "src/app.js"]