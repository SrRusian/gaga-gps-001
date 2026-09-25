import { query } from '../config/database';

export interface PositionRow {
  id: number;
  device_id: string;
  project_id: number | null;
  latitude: number;
  longitude: number;
  altitude: number;
  speed: number;
  course: number;
  accuracy: number;
  battery: number | null;
  fix_time: Date;
  protocol: string;
  valid: boolean;
  attributes: Record<string, unknown>;
}

export interface PositionInput {
  deviceId: string;
  projectId?: number | null;
  latitude: number;
  longitude: number;
  altitude?: number;
  speed?: number;
  course?: number;
  accuracy?: number;
  battery?: number | null;
  fixTime?: Date | string;
  protocol?: string;
  valid?: boolean;
  attributes?: Record<string, unknown>;
}

class PositionRepository {
  async save(position: PositionInput): Promise<PositionRow> {
    try {
      const { rows } = await query<PositionRow>(
        `INSERT INTO positions
           (device_id, project_id, latitude, longitude, altitude, speed, course,
            accuracy, battery, fix_time, protocol, valid, attributes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          position.deviceId,
          position.projectId ?? null,
          position.latitude,
          position.longitude,
          position.altitude || 0,
          position.speed || 0,
          position.course || 0,
          position.accuracy || 0,
          position.battery ?? null,
          position.fixTime || new Date(),
          position.protocol || 'osmand',
          position.valid !== false,
          position.attributes || {},
        ],
      );
      return rows[0];
    } catch (err) {
      console.error('PositionRepository.save:', (err as Error).message);
      throw err;
    }
  }

  async findLatestByDevice(deviceId: string): Promise<PositionRow | null> {
    try {
      const { rows } = await query<PositionRow>(
        `SELECT * FROM positions WHERE device_id = $1 AND valid = TRUE
         ORDER BY fix_time DESC LIMIT 1`,
        [deviceId],
      );
      return rows[0] || null;
    } catch (err) {
      console.error('PositionRepository.findLatestByDevice:', (err as Error).message);
      throw err;
    }
  }

  async findLatestPerDevice(): Promise<PositionRow[]> {
    try {
      const { rows } = await query<PositionRow>(
        `SELECT DISTINCT ON (device_id) *
         FROM positions
         WHERE valid = TRUE
         ORDER BY device_id, fix_time DESC`,
      );
      return rows;
    } catch (err) {
      console.error('PositionRepository.findLatestPerDevice:', (err as Error).message);
      throw err;
    }
  }

  // `limit` sigue siendo el tamaño de UNA pagina (default 5000, el mismo numero que antes era el
  // tope duro del total) - pedido explicito: "no deberia tener limite... aunque va a tardar". Ya no
  // hay ningun techo sobre el TOTAL de filas que se pueden traer - el caller (reports.routes.ts)
  // pagina con `offset` hasta agotar el rango, ver /history-count + el bucle del lado del cliente en
  // useHistoryMode.ts.
  async findHistory({
    deviceId,
    from,
    to,
    limit = 5000,
    offset = 0,
  }: {
    deviceId: string;
    from: Date | string;
    to: Date | string;
    limit?: number;
    offset?: number;
  }): Promise<PositionRow[]> {
    try {
      const { rows } = await query<PositionRow>(
        `SELECT * FROM positions
         WHERE device_id = $1 AND fix_time BETWEEN $2 AND $3 AND valid = TRUE
         ORDER BY fix_time ASC
         LIMIT $4 OFFSET $5`,
        [deviceId, from, to, limit, offset],
      );
      return rows;
    } catch (err) {
      console.error('PositionRepository.findHistory:', (err as Error).message);
      throw err;
    }
  }

  // total real de posiciones en el rango, sin traer ninguna fila - permite saber de antemano
  // cuantas paginas hacen falta (para la barra de progreso real del lado del cliente) sin adivinar
  async countHistory({
    deviceId,
    from,
    to,
  }: {
    deviceId: string;
    from: Date | string;
    to: Date | string;
  }): Promise<number> {
    try {
      const { rows } = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM positions
         WHERE device_id = $1 AND fix_time BETWEEN $2 AND $3 AND valid = TRUE`,
        [deviceId, from, to],
      );
      return Number(rows[0]?.count ?? 0);
    } catch (err) {
      console.error('PositionRepository.countHistory:', (err as Error).message);
      throw err;
    }
  }

  // distancia recorrida via PostGIS (LAG + ST_Distance sobre geography) en vez de traer todas las
  // filas a Node - evita el LIMIT de findHistory truncando el cálculo en rangos largos
  async sumDistanceMeters({
    deviceId,
    from,
    to,
  }: {
    deviceId: string;
    from: Date | string;
    to: Date | string;
  }): Promise<number> {
    try {
      // el LAG (window function) debe resolverse en una subquery aparte - Postgres no permite
      // SUM(...) envolviendo directamente una window function en el mismo nivel de SELECT
      const { rows } = await query<{ distance_meters: number | null }>(
        `SELECT SUM(step_meters) AS distance_meters FROM (
           SELECT ST_Distance(
             ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
             ST_SetSRID(ST_MakePoint(LAG(longitude) OVER w, LAG(latitude) OVER w), 4326)::geography
           ) AS step_meters
           FROM positions
           WHERE device_id = $1 AND fix_time BETWEEN $2 AND $3 AND valid = TRUE
           WINDOW w AS (ORDER BY fix_time)
         ) steps`,
        [deviceId, from, to],
      );
      return Number(rows[0]?.distance_meters ?? 0);
    } catch (err) {
      console.error('PositionRepository.sumDistanceMeters:', (err as Error).message);
      throw err;
    }
  }
}

export default PositionRepository;
