export interface ActiveMap {
  id: number;
  name: string;
  tileUrlTemplate: string;
  bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
  minZoom: number | null;
  maxZoom: number | null;
}
