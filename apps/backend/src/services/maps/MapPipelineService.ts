import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import Database from 'better-sqlite3';
import type MapRepository from '../../repositories/MapRepository';
import type { MapBounds } from '../../repositories/MapRepository';

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

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
   * @param chosenCrs - CRS elegido en el formulario
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
        ` Procesando mapa #${mapId} - CRS: ${crs} (${crsAutoDetected ? 'auto-detectado' : 'elegido por el admin'})`,
      );

      const worldFile = await this._readWorldFile(worldFilePath);
      const { widthPx, heightPx } = await this._getImageSizePixels(imagePath);

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

      const tileDir = path.join(workDir, 'tiles');
      await this._run('gdal2tiles.py', [
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
        `Mapa #${mapId} listo - ${sizeMb.toFixed(1)} MB, bounds: ${JSON.stringify(bounds)}`,
      );
    } catch (err) {
      console.error(`Error procesando mapa #${mapId}:`, (err as Error).message);
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

  async _packageMbtiles(
    tileDir: string,
    outputPath: string,
    { name, bounds }: { name: string; bounds: MapBounds },
  ): Promise<{ tileCount: number; minZoom: number | null; maxZoom: number | null }> {
    await fs.rm(outputPath, { force: true });
    const db = new Database(outputPath);

    try {
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
