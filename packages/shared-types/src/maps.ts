/**
 * Forma pública de un mapa satelital/drone activo — la que consumen
 * Operador/Supervisor/Admin vía `GET /tiles/active-maps.json` y el
 * evento de Socket.io `maps:active_update`. Ver
 * apps/backend/src/services/maps/mapShape.ts (toPublicShape).
 */
export interface ActiveMap {
  id: number;
  name: string;
  tileUrlTemplate: string;
  bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
  minZoom: number | null;
  maxZoom: number | null;
}
