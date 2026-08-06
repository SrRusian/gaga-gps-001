/**
 * MapPipelineService.ts
 *
 * Responsabilidad: Procesar una imagen georreferenciada
 * (TIF+TFW o JPG+JPW) subida desde el panel Admin y convertirla a
 * MBTiles para distribución offline a las tabletas — usa GDAL
 * (gdal_translate, gdalsrsinfo, gdaltransform, gdal2tiles.py),
 * instalado en la imagen Docker del backend (ver Dockerfile).
 *
 * Un world file (TFW/JPW) nunca incluye el sistema de coordenadas
 * (CRS) — solo tamaño de píxel y origen en las unidades que sea.
 * Por eso el pipeline primero intenta detectar el CRS embebido en
 * la imagen (gdalsrsinfo); si no lo encuentra, usa el que el admin
 * eligió en el formulario de importación. Asumir mal el CRS coloca
 * el mapa en el lugar o a la escala equivocada sin ningún error
 * visible — de ahí la importancia de nunca adivinar en silencio.
 *
 * Usa child_process.execFile (async) en vez de execSync — convertir
 * una ortofoto grande puede tardar varios minutos, y este mismo
 * proceso Node recibe telemetría GPS en tiempo real; bloquear el
 * event loop durante el procesamiento habría congelado la recepción
 * de posiciones de toda la flota.
 *
 * RF asociados: RF-MAP-01, RF-MAP-02, RF-MAP-03
 */
import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import Database from 'better-sqlite3';
import type MapRepository from '../../repositories/MapRepository';
import type { MapBounds } from '../../repositories/MapRepository';

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — ortofotos grandes tardan

interface WorldFile {
  pixelSizeX: number;
  pixelSizeY: number;
  originX: number;
  originY: number;
}

class MapPipelineService {
  mapsDir: string;
  tmpDir: string;
  mapRepo: MapRepository;

  constructor({ mapsDir, mapRepo }: { mapsDir: string; mapRepo: MapRepository }) {
    this.mapsDir = mapsDir;
    this.tmpDir = path.join(mapsDir, 'tmp');
    this.mapRepo = mapRepo;
  }

  /**
   * Procesa un mapa ya creado en la base de datos (status='processing').
   * No lanza excepciones hacia el llamador — cualquier fallo se
   * captura y se refleja en la fila (status='failed' + error_message),
   * para que un import roto nunca tumbe el backend ni deje la fila
   * atorada en 'processing' para siempre.
   *
   * @param chosenCrs - CRS elegido en el formulario (ej. 'EPSG:32613'),
   *   usado solo si no se logra detectar uno embebido en la imagen
   */
  async process(
    mapId: number,
    imagePath: string,
    worldFilePath: string,
    chosenCrs: string | null,
  ): Promise<void> {
    const workDir = path.join(this.tmpDir, String(mapId));

    try {
      await fs.mkdir(workDir, { recursive: true });

      const detectedCrs = await this._detectCrs(imagePath);
      const crs = detectedCrs || chosenCrs;
      const crsAutoDetected = Boolean(detectedCrs);

      if (!crs) {
        throw new Error(
          'No se pudo detectar el sistema de coordenadas (CRS) y no se especificó uno en el formulario',
        );
      }

      console.log(
        `🗺️  Procesando mapa #${mapId} — CRS: ${crs} (${crsAutoDetected ? 'auto-detectado' : 'elegido por el admin'})`,
      );

      const worldFile = await this._readWorldFile(worldFilePath);
      const { widthPx, heightPx } = await this._getImageSizePixels(imagePath);

      // Bounding box en las unidades nativas del CRS — el world file
      // da el origen (esquina superior izquierda) y el tamaño de
      // píxel; la esquina inferior derecha se deriva del tamaño de
      // la imagen en píxeles.
      const ulx = worldFile.originX;
      const uly = worldFile.originY;
      const lrx = worldFile.originX + worldFile.pixelSizeX * widthPx;
      const lry = worldFile.originY + worldFile.pixelSizeY * heightPx;

      const georefPath = path.join(workDir, 'georef.tif');
      await this._run('gdal_translate', [
        '-a_srs',
        crs,
        '-a_ullr',
        String(ulx),
        String(uly),
        String(lrx),
        String(lry),
        imagePath,
        georefPath,
      ]);

      // gdal2tiles.py en esta versión de GDAL (3.6, la que trae
      // Debian bookworm) no soporta empaquetar directo a .mbtiles
      // (esa opción llegó en versiones más nuevas) — genera un
      // directorio z/x/y.png, que se empaqueta a mano abajo con
      // better-sqlite3 (ya es dependencia del backend). Sin --xyz,
      // la numeración de filas que produce es TMS — el mismo
      // esquema que ya espera maps.routes.js al servir tiles.
      const tileDir = path.join(workDir, 'tiles');
      await this._run('gdal2tiles.py', [
        // gdal2tiles.py usa "-s" para el CRS de origen (a diferencia
        // de gdal_translate, que sí usa "-a_srs") — "-s_srs" es
        // inválido aquí y el parser de opciones lo confunde con un
        // archivo de entrada extra.
        '-s',
        crs,
        '-w',
        'none',
        georefPath,
        tileDir,
      ]);

      const bounds = await this._reprojectBoundsToWgs84(crs, ulx, uly, lrx, lry);
      const outputMbtiles = path.join(this.mapsDir, `map_${mapId}.mbtiles`);
      const { tileCount, minZoom, maxZoom } = await this._packageMbtiles(tileDir, outputMbtiles, {
        name: `map_${mapId}`,
        bounds,
      });

      console.log(
        `   ${tileCount} tiles empaquetados en ${path.basename(outputMbtiles)} (zoom ${minZoom}-${maxZoom})`,
      );

      const stats = await fs.stat(outputMbtiles);
      const sizeMb = stats.size / 1024 / 1024;

      await this.mapRepo.updateResult(mapId, {
        status: 'ready',
        sourceCrs: crs,
        crsAutoDetected,
        bounds,
        mbtilesFilename: path.basename(outputMbtiles),
        sizeMb,
        minZoom: minZoom ?? undefined,
        maxZoom: maxZoom ?? undefined,
      });

      console.log(
        `✅ Mapa #${mapId} listo — ${sizeMb.toFixed(1)} MB, bounds: ${JSON.stringify(bounds)}`,
      );
    } catch (err) {
      console.error(`❌ Error procesando mapa #${mapId}:`, (err as Error).message);
      await this.mapRepo
        .updateResult(mapId, {
          status: 'failed',
          errorMessage: (err as Error).message.slice(0, 1000),
        })
        .catch(() => {});
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async deleteFile(mbtilesFilename: string | null | undefined): Promise<void> {
    if (!mbtilesFilename) return;
    await fs.rm(path.join(this.mapsDir, mbtilesFilename), { force: true }).catch(() => {});
  }

  // ── Internos ─────────────────────────────────────────────────

  /**
   * Intenta leer el CRS embebido en la imagen — algunos exportadores
   * (Pix4D, DroneDeploy, Agisoft) sí incrustan el GeoTIFF; si no hay
   * ninguno, devuelve null y el pipeline usa el CRS elegido en el
   * formulario.
   */
  async _detectCrs(imagePath: string): Promise<string | null> {
    try {
      const { stdout } = await this._run('gdalsrsinfo', ['-o', 'epsg', imagePath]);
      const match = stdout.match(/EPSG:\d+/);
      return match ? match[0] : null;
    } catch {
      return null;
    }
  }

  async _getImageSizePixels(imagePath: string): Promise<{ widthPx: number; heightPx: number }> {
    const { stdout } = await this._run('gdalinfo', ['-json', imagePath]);
    const info = JSON.parse(stdout);
    const [widthPx, heightPx] = info.size;
    return { widthPx, heightPx };
  }

  /**
   * Reproyecta las esquinas superior-izquierda/inferior-derecha del
   * CRS de origen a WGS84 — para mostrar el área cubierta en el
   * panel Admin sin tener que volver a abrir el .mbtiles resultante.
   */
  async _reprojectBoundsToWgs84(
    crs: string,
    ulx: number,
    uly: number,
    lrx: number,
    lry: number,
  ): Promise<MapBounds> {
    const input = `${ulx} ${uly}\n${lrx} ${lry}\n`;
    const { stdout } = await this._run(
      'gdaltransform',
      ['-s_srs', crs, '-t_srs', 'EPSG:4326'],
      input,
    );

    const points = stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [lon, lat] = line.trim().split(/\s+/).map(Number);
        return { lat, lon };
      });

    const [upperLeft, lowerRight] = points;
    return {
      minLat: Math.min(upperLeft.lat, lowerRight.lat),
      maxLat: Math.max(upperLeft.lat, lowerRight.lat),
      minLon: Math.min(upperLeft.lon, lowerRight.lon),
      maxLon: Math.max(upperLeft.lon, lowerRight.lon),
    };
  }

  /**
   * Empaqueta un directorio de tiles z/x/y.png (salida de
   * gdal2tiles.py) en un único archivo .mbtiles (esquema estándar:
   * tabla `tiles`, igual que ya lee maps.routes.js). Usa
   * better-sqlite3 en transacciones por lote y cede el hilo entre
   * carpetas (setImmediate) para no acaparar el event loop — no es
   * tan lento como los subprocesos GDAL, pero un directorio con
   * decenas de miles de tiles sí puede sumar tiempo de CPU síncrono.
   */
  async _packageMbtiles(
    tileDir: string,
    outputPath: string,
    { name, bounds }: { name: string; bounds: MapBounds },
  ): Promise<{ tileCount: number; minZoom: number | null; maxZoom: number | null }> {
    await fs.rm(outputPath, { force: true });
    const db = new Database(outputPath);

    try {
      // Sin WAL — este .mbtiles es un artefacto de un solo archivo
      // que se sirve directo desde disco (ver maps.routes.js); WAL
      // dejaría archivos -wal/-shm colgantes fuera de ese único
      // archivo.
      db.exec(`
        CREATE TABLE metadata (name TEXT, value TEXT);
        CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
        CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
      `);

      const insertMeta = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
      insertMeta.run('name', name);
      insertMeta.run('format', 'png');
      insertMeta.run('type', 'baselayer');
      if (bounds) {
        insertMeta.run(
          'bounds',
          `${bounds.minLon},${bounds.minLat},${bounds.maxLon},${bounds.maxLat}`,
        );
      }

      const insertTile = db.prepare(
        'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?,?,?,?)',
      );
      const insertBatch = db.transaction(
        (rows: { z: number; x: number; y: number; data: Buffer }[]) => {
          for (const row of rows) insertTile.run(row.z, row.x, row.y, row.data);
        },
      );

      const zoomDirs = (await fs.readdir(tileDir)).filter((d) => /^\d+$/.test(d));
      let minZoom: number | null = null;
      let maxZoom: number | null = null;
      let total = 0;

      for (const zDir of zoomDirs) {
        const z = parseInt(zDir, 10);
        minZoom = minZoom === null ? z : Math.min(minZoom, z);
        maxZoom = maxZoom === null ? z : Math.max(maxZoom, z);

        const xDirs = await fs.readdir(path.join(tileDir, zDir));
        for (const xDir of xDirs) {
          const x = parseInt(xDir, 10);
          if (Number.isNaN(x)) continue;

          const yFiles = (await fs.readdir(path.join(tileDir, zDir, xDir))).filter((f) =>
            f.endsWith('.png'),
          );
          const batch: { z: number; x: number; y: number; data: Buffer }[] = [];
          for (const yFile of yFiles) {
            const y = parseInt(yFile, 10);
            const data = await fs.readFile(path.join(tileDir, zDir, xDir, yFile));
            batch.push({ z, x, y, data });
          }
          insertBatch(batch);
          total += batch.length;

          // Cede el hilo tras cada carpeta x/ — evita monopolizar el
          // event loop (y con él, la recepción de telemetría GPS)
          // en ortofotos con muchísimos tiles.
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      if (minZoom !== null) {
        insertMeta.run('minzoom', String(minZoom));
        insertMeta.run('maxzoom', String(maxZoom));
      }

      return { tileCount: total, minZoom, maxZoom };
    } finally {
      db.close();
    }
  }

  /**
   * World file (TFW/JPW) — 6 líneas: tamaño de píxel X, rotación,
   * rotación, tamaño de píxel Y (negativo), origen X, origen Y. El
   * origen es el centro del píxel superior izquierdo — para el uso
   * que le damos aquí (bounding box a nivel de tiles) el desfase de
   * medio píxel es insignificante.
   */
  async _readWorldFile(worldFilePath: string): Promise<WorldFile> {
    const content = await fs.readFile(worldFilePath, 'utf8');
    const lines = content.trim().split('\n').map(Number);
    return {
      pixelSizeX: lines[0],
      pixelSizeY: lines[3],
      originX: lines[4],
      originY: lines[5],
    };
  }

  /**
   * Ejecuta un comando GDAL sin bloquear el event loop. Usa
   * execFile (no exec/execSync) — argumentos como array, sin
   * interpretación de shell.
   */
  _run(
    command: string,
    args: string[],
    stdin?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        command,
        args,
        { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = (stderr || err.message || '').trim().slice(-800);
            reject(new Error(`${command} falló: ${detail || err.message}`));
            return;
          }
          resolve({ stdout, stderr });
        },
      );

      if (stdin) {
        child.stdin?.write(stdin);
        child.stdin?.end();
      }
    });
  }
}

export default MapPipelineService;
