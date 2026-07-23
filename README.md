# GAGA-GPS v1.0

Sistema de Geolocalización y Control de Flota en Tiempo Real
Operación Minera — GAGA

## Requisitos

- Docker Desktop
- Node.js 20 LTS
- Python 3.x (para pipeline de mapas)

## Instalación

### 1. Clonar el repositorio

git clone https://github.com/[org]/gaga-gps-001.git
cd gaga-gps-001

### 2. Configurar variables de entorno

cp backend/.env.example backend/.env

# Editar backend/.env con los valores correctos

### 3. Levantar infraestructura

docker compose up -d

### 4. Instalar dependencias del backend

cd backend
npm install

### 5. Iniciar el backend

node src/app.js

## URLs del sistema

- UI Operador: http://localhost:3001/operator
- UI Supervisor: http://localhost:3001/supervisor
- Panel Traccar: http://localhost:8082
- Health check: http://localhost:3001/health

## Stack tecnológico

- Traccar v6 — Core de telemetría GPS
- Node.js — Backend custom con lógica de seguridad
- PostgreSQL 16 — Base de datos con PostGIS
- Redis 7 — Estado en tiempo real
- EMQX — Broker MQTT
- MapLibre GL — Renderizado de mapas
- Docker — Containerización

## Módulos de seguridad implementados

- RF-ALR-02/03 GeofenceAlertService — Alertas zona amarilla y roja
- RF-ALR-05 SignalLostService — Emergencia colectiva por pérdida de señal
- RF-ALR-10 CollisionRiskService — Anticolisión con trayectoria proyectada
- RF-ALR-11 PreventiveStopService — Parada preventiva colectiva
- RF-ALR-12 StaticEquipmentManager — Guía de aproximación a equipo estático

## Documentación

Ver carpeta /docs con los 7 documentos de ingeniería del proyecto.
