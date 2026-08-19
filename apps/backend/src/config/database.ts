import { Pool, type QueryResult, type QueryResultRow } from 'pg';

export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'gaga_gps',
  user: process.env.DB_USER || 'gaga_app',
  password: process.env.DB_PASSWORD || 'gaga_dev_pass',
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', () => {
  console.log('PostgreSQL - nueva conexión establecida');
});

pool.on('error', (err: Error) => {
  console.error('PostgreSQL - error inesperado en cliente inactivo:', err.message);
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  try {
    return await pool.query<T>(text, params);
  } catch (err) {
    console.error(`Error en query PostgreSQL: ${(err as Error).message}`);
    throw err;
  }
}

export async function checkConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    console.error('PostgreSQL no disponible:', (err as Error).message);
    return false;
  }
}
