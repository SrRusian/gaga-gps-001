/**
 * MapRepository.js
 *
 * Responsabilidad: CRUD de mapas satelitales/drone importados
 * (tabla `maps`, ver db/migrations/007_maps.sql) — metadata del
 * pipeline TIF/TFW → MBTiles, no el archivo en sí.
 */

const { query } = require('../config/database');

class MapRepository {

  async findAll() {
    try {
      const { rows } = await query('SELECT * FROM maps ORDER BY created_at DESC');
      return rows;
    } catch (err) {
      console.error('❌ MapRepository.findAll:', err.message);
      throw err;
    }
  }

  async findById(id) {
    try {
      const { rows } = await query('SELECT * FROM maps WHERE id = $1', [id]);
      return rows[0] || null;
    } catch (err) {
      console.error('❌ MapRepository.findById:', err.message);
      throw err;
    }
  }

  /**
   * Crea la fila antes de conocer los nombres finales de archivo —
   * el id (necesario para la carpeta maps/sources/<id>/ donde se
   * guardan) solo existe después de este INSERT.
   */
  async create({ name, uploadedBy }) {
    try {
      const { rows } = await query(
        `INSERT INTO maps (name, uploaded_by) VALUES ($1,$2) RETURNING *`,
        [name, uploadedBy || null]
      );
      return rows[0];
    } catch (err) {
      console.error('❌ MapRepository.create:', err.message);
      throw err;
    }
  }

  async setSourceFiles(id, { sourceImageFilename, sourceWorldFilename }) {
    try {
      const { rows } = await query(
        `UPDATE maps SET source_image_filename = $2, source_world_filename = $3
         WHERE id = $1 RETURNING *`,
        [id, sourceImageFilename, sourceWorldFilename]
      );
      return rows[0] || null;
    } catch (err) {
      console.error('❌ MapRepository.setSourceFiles:', err.message);
      throw err;
    }
  }

  async rename(id, name) {
    try {
      const { rows } = await query(
        'UPDATE maps SET name = $2 WHERE id = $1 RETURNING *',
        [id, name]
      );
      return rows[0] || null;
    } catch (err) {
      console.error('❌ MapRepository.rename:', err.message);
      throw err;
    }
  }

  /**
   * Actualiza el resultado del pipeline — a 'ready' con
   * bounds/mbtilesFilename/sizeMb/minZoom/maxZoom, o a 'failed' con
   * errorMessage.
   */
  async updateResult(id, { status, sourceCrs, crsAutoDetected, bounds, mbtilesFilename, sizeMb, minZoom, maxZoom, errorMessage }) {
    try {
      const { rows } = await query(
        `UPDATE maps SET
           status = $2,
           source_crs = COALESCE($3, source_crs),
           crs_auto_detected = COALESCE($4, crs_auto_detected),
           bounds = COALESCE($5, bounds),
           mbtiles_filename = COALESCE($6, mbtiles_filename),
           size_mb = COALESCE($7, size_mb),
           min_zoom = COALESCE($8, min_zoom),
           max_zoom = COALESCE($9, max_zoom),
           error_message = $10
         WHERE id = $1 RETURNING *`,
        [id, status, sourceCrs, crsAutoDetected, bounds ? JSON.stringify(bounds) : null, mbtilesFilename, sizeMb, minZoom, maxZoom, errorMessage || null]
      );
      return rows[0] || null;
    } catch (err) {
      console.error('❌ MapRepository.updateResult:', err.message);
      throw err;
    }
  }

  /**
   * Activa o desactiva un mapa como capa visible — varios mapas
   * pueden estar activos a la vez (se apilan en el frontend, ver
   * findActiveReady). Ya no es exclusivo (antes solo uno podía estar
   * activo, servido en un archivo fijo).
   */
  async setActive(id, active) {
    try {
      const { rows } = await query(
        'UPDATE maps SET active = $2 WHERE id = $1 RETURNING *',
        [id, active]
      );
      return rows[0] || null;
    } catch (err) {
      console.error('❌ MapRepository.setActive:', err.message);
      throw err;
    }
  }

  /**
   * Mapas activos y listos, del más viejo al más nuevo — el
   * frontend agrega las capas en este orden, así el mapa creado más
   * recientemente termina agregado al final = visualmente arriba.
   */
  async findActiveReady() {
    try {
      const { rows } = await query(
        `SELECT * FROM maps WHERE active = TRUE AND status = 'ready' ORDER BY created_at ASC`
      );
      return rows;
    } catch (err) {
      console.error('❌ MapRepository.findActiveReady:', err.message);
      throw err;
    }
  }

  async delete(id) {
    try {
      await query('DELETE FROM maps WHERE id = $1', [id]);
      return true;
    } catch (err) {
      console.error('❌ MapRepository.delete:', err.message);
      throw err;
    }
  }
}

module.exports = MapRepository;
