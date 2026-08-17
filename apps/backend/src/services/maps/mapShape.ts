/**
 * mapShape.ts
 *
 * Extraído de maps.routes.js durante la migración a TypeScript
 * (antes, sockets/FleetSocketServer.js importaba esta función desde
 * un archivo de rutas - una dependencia cruzada ruta→socket que no
 * hacía falta). Único lugar que normaliza una fila de `maps` a lo
 * que necesita el frontend para agregar la capa en MapLibre - lo usan
 * tanto `GET /tiles/active-maps.json` como el broadcast de socket
 * `maps:active_update`.
 */
import type { ActiveMap } from '@gaga-gps/shared-types';
import type { MapRow } from '../../repositories/MapRepository';

export function toPublicShape(m: MapRow): ActiveMap {
  return {
    id: m.id,
    name: m.name,
    tileUrlTemplate: `/tiles/maps/${m.id}/{z}/{x}/{y}.png`,
    bounds: m.bounds || null,
    minZoom: m.min_zoom,
    maxZoom: m.max_zoom,
  };
}
