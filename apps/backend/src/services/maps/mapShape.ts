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
