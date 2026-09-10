import './loadEnv';
import { z } from 'zod';
import * as database from './database';
import * as redisConfig from './redis';

export interface PositionFilterConfig {
  toleranceFactor: number;
  minFloorKmh: number;
  absoluteCeilingKmh: number;
  jitterRadiusMeters: number;
  historyWindow: number;
  maxConsecutiveRejects: number;
}

export interface Env {
  port: number;
  jwtSecret: string;
  jwtExpiresIn: string;
  operatorJwtExpiresIn: string;
  operatorSessionMaxIdleDays: number;
  mapsDir: string;
  maxMapUploadMb: number;
  releasesDir: string;
  maxApkUploadMb: number;
  telemetrySharedSecret: string | null;
  defaultAdminEmail: string;
  defaultAdminPassword: string;
  positionFilter: PositionFilterConfig;
}

export const env: Env = {
  port: parseInt(process.env.PORT || '3001', 10),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-cambiar-en-produccion',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  operatorJwtExpiresIn: process.env.OPERATOR_JWT_EXPIRES_IN || '30d',
  operatorSessionMaxIdleDays: parseInt(process.env.OPERATOR_SESSION_MAX_IDLE_DAYS || '7', 10),
  mapsDir: process.env.MAPS_DIR || 'maps',
  maxMapUploadMb: parseInt(process.env.MAX_MAP_UPLOAD_MB || '500', 10),
  releasesDir: process.env.RELEASES_DIR || 'releases',
  maxApkUploadMb: parseInt(process.env.MAX_APK_UPLOAD_MB || '200', 10),
  telemetrySharedSecret: process.env.TELEMETRY_SHARED_SECRET || null,

  defaultAdminEmail: process.env.DEFAULT_ADMIN_EMAIL || 'admin@gaga.com',
  defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || 'admin',

  positionFilter: {
    toleranceFactor: parseFloat(process.env.POSITION_FILTER_TOLERANCE_FACTOR || '1.8'),
    minFloorKmh: parseFloat(process.env.POSITION_FILTER_MIN_FLOOR_KMH || '25'),
    absoluteCeilingKmh: parseFloat(process.env.POSITION_FILTER_ABSOLUTE_CEILING_KMH || '120'),
    jitterRadiusMeters: parseFloat(process.env.POSITION_FILTER_JITTER_RADIUS_M || '5'),
    historyWindow: parseInt(process.env.POSITION_FILTER_HISTORY_WINDOW || '8', 10),
    maxConsecutiveRejects: parseInt(process.env.POSITION_FILTER_MAX_CONSECUTIVE_REJECTS || '3', 10),
  },
};

const requiredEnvSchema = z.object({
  JWT_SECRET: z.string().min(1),
  TELEMETRY_SHARED_SECRET: z.string().min(1),
});

function validateEnv(): void {
  const result = requiredEnvSchema.safeParse(process.env);
  if (!result.success) {
    const missing = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Faltan variables de entorno requeridas: ${missing.join(', ')}`);
  }
}

validateEnv();

export const db = database;
export const redis = redisConfig;
