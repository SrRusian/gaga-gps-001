# GAGA-GPS v2.0

Sistema de Geolocalización y Control de Flota en Tiempo Real
Operación Minera — GAGA

Sistema propio de telemetría GPS — **sin Traccar Server** como
intermediario. Las tabletas siguen usando Traccar Client sin cambios
(protocolo OsmAnd); solo cambia la URL del servidor al backend Node.js.

## Requisitos

- Docker Desktop
- Node.js 22 LTS
- Python 3.x (para pipeline de mapas)

## Instalación

### 1. Clonar el repositorio

git clone https://github.com/[org]/gaga-gps-001.git
cd gaga-gps-001

### 2. Configurar variables de entorno

cp backend/.env-example backend/.env

# Editar backend/.env con los valores correctos (DB, Redis, JWT)

### 3. Levantar infraestructura (PostgreSQL + TimescaleDB + Redis)

docker compose up -d

Las migraciones en `db/migrations/` se aplican automáticamente al
crear el volumen de PostgreSQL por primera vez.

### 4. Instalar dependencias del backend

cd backend
npm install

### 5. Iniciar el backend

node src/app.js

## URLs del sistema

- Telemetría (tabletas): GET http://localhost:3001/gps
- UI Operador: http://localhost:3001/operator
- UI Supervisor: http://localhost:3001/supervisor
- Panel Admin: http://localhost:3001/admin
- Health check: http://localhost:3001/health

## Stack tecnológico

- Node.js 22 — Backend propio: recepción de telemetría, persistencia,
  seguridad y distribución en tiempo real
- PostgreSQL 16 + PostGIS + TimescaleDB — Persistencia de dispositivos,
  posiciones (hypertable), geocercas, equipo estático y usuarios
- Redis 7 — Estado de flota en tiempo real
- Socket.io — Distribución de posiciones y alertas a las UIs
- MapLibre GL — Renderizado de mapas
- Docker — Containerización

## Receptor de telemetría propio

`GET /gps` reemplaza la dependencia de Traccar Server — recibe las
posiciones directamente desde Traccar Client (protocolo OsmAnd),
auto-registra el dispositivo si es la primera vez que se conecta, y
las procesa con `PositionProcessor.js` (persistencia, seguridad y
distribución en tiempo real).

## Módulos de seguridad implementados

- RF-ALR-02/03 GeofenceAlertService — Alertas zona amarilla y roja
- RF-ALR-05 SignalLostService — Emergencia colectiva por pérdida de señal
- RF-ALR-10 CollisionRiskService — Anticolisión con trayectoria proyectada
- RF-ALR-11 PreventiveStopService — Parada preventiva colectiva
- RF-ALR-12 StaticEquipmentManager — Guía de aproximación a equipo estático

## Documentación

Ver carpeta /docs con los 7 documentos de ingeniería del proyecto.
