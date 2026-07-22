/**
 * MapPipelineService.js
 *
 * Responsabilidad: Procesar imágenes georreferenciadas
 * (JPG+JPW o TIF+TFW) y convertirlas a MBTiles
 * para distribución offline a tabletas.
 *
 * Input:  imagen.jpg + imagen.jpw (o .tif + .tfw)
 * Output: mapa.mbtiles servido por el backend
 *
 * RF asociados: RF-MAP-01, RF-MAP-02, RF-MAP-03
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('better-sqlite3');

class MapPipelineService {

  constructor({ mapsDir, io }) {
    this.mapsDir = mapsDir;
    this.io = io;
    this.currentVersion = null;
  }

  /**
   * Procesa un nuevo archivo de imagen georreferenciada
   * y genera el MBTiles correspondiente
   *
   * @param {string} imagePath - ruta al JPG o TIF
   * @param {string} worldFilePath - ruta al JPW o TFW
   */
  async process(imagePath, worldFilePath) {
    console.log(`🗺️  Iniciando pipeline de mapa: ${path.basename(imagePath)}`);

    const version = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = path.join(this.mapsDir, `map_${version}.mbtiles`);

    try {
      // Leer world file para obtener coordenadas
      const bounds = this.readWorldFile(imagePath, worldFilePath);
      console.log(`   Bounds: ${JSON.stringify(bounds)}`);

      // Generar MBTiles con Python (mismo script probado)
      const script = this.buildPythonScript(imagePath, outputPath, bounds);
      execSync(`python3 -c "${script}"`, { timeout: 300000 });

      // Validar resultado
      const stats = fs.statSync(outputPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
      console.log(`✅ MBTiles generado: ${sizeMB} MB`);

      // Guardar versión actual
      this.currentVersion = {
        version,
        path: outputPath,
        sizeMB,
        generatedAt: new Date().toISOString(),
        bounds
      };

      // Notificar a todos los dispositivos
      this.io.emit('map:update', {
        version,
        url: '/tiles/current',
        sizeMB,
        timestamp: new Date().toISOString()
      });

      return this.currentVersion;

    } catch (err) {
      console.error('❌ Error en pipeline de mapa:', err.message);
      throw err;
    }
  }

  readWorldFile(imagePath, worldFilePath) {
    // Implementación según tipo de archivo
    // JPW o TFW tienen el mismo formato de 6 líneas
    const lines = fs.readFileSync(worldFilePath, 'utf8')
      .trim().split('\n').map(Number);

    return {
      pixelSizeX: lines[0],
      pixelSizeY: lines[3],
      originX: lines[4],
      originY: lines[5]
    };
  }

  getCurrentVersion() {
    return this.currentVersion;
  }
}

module.exports = MapPipelineService;