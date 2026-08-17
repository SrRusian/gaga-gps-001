/**
 * loadEnv.ts
 *
 * Carga el único `.env` del proyecto (raíz del repo), sin importar
 * desde dónde se arranque el proceso. `dotenv/config` por sí solo
 * resuelve `.env` relativo a `process.cwd()` - con npm workspaces,
 * eso cambia según cómo se invoque (`npm run dev:backend` corre con
 * cwd = apps/backend, no la raíz), lo que antes obligaba a mantener
 * un `.env` duplicado dentro de apps/backend solo para ese caso.
 *
 * Este archivo vive siempre en apps/backend/{src,dist}/config/, así
 * que su propia ubicación (no el cwd del proceso) sirve de ancla
 * fija para encontrar la raíz del repo, sin importar si corre desde
 * el .ts fuente (tsx) o el .js compilado.
 */
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../../../.env') });
