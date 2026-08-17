/**
 * geoFormats.ts
 *
 * Conversión de geocercas entre el modelo interno (fila de
 * PostgreSQL) y formatos estándar de intercambio geoespacial:
 *   - GeoJSON (RFC 7946) - formato principal, nativo en JS
 *   - KML - muy usado en topografía/minería y Google Earth
 *
 * Convención para círculos (GeoJSON no tiene un tipo nativo para
 * ellos): se representan como Point + propiedad `radiusMeters`,
 * el mismo patrón usado por Leaflet/Mapbox y herramientas GIS.
 *
 * Propiedades usadas en properties/ExtendedData:
 *   name               - nombre de la geocerca
 *   type               - 'warning' | 'danger'
 *   radiusMeters        - solo para círculos (Point)
 *   corridorWidthMeters - solo para rutas (LineString)
 */
import { DOMParser } from '@xmldom/xmldom';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- @tmcw/togeojson no expone default export ESM-friendly
const togeojson = require('@tmcw/togeojson');
import type { GeofenceShapeType, GeofenceType } from '@gaga-gps/shared-types';
import type { Feature, FeatureCollection, Geometry, LineString, Point, Polygon } from 'geojson';

/** Fila cruda de la tabla `geofences` - snake_case, tal como la devuelve PostgreSQL. */
export interface GeofenceRow {
  id: number;
  project_id: number | null;
  name: string;
  type: GeofenceType;
  shape_type: GeofenceShapeType;
  active: boolean;
  center_lat: number | null;
  center_lon: number | null;
  radius_meters: number | null;
  geometry: Polygon | LineString | null;
  corridor_width_meters: number | null;
  corridor_danger_margin_meters: number | null;
}

// ── Exportar a GeoJSON ──────────────────────────────────────────

function geofenceRowToFeature(row: GeofenceRow): Feature {
  const properties: Record<string, unknown> = { name: row.name, type: row.type };

  if (row.shape_type === 'circle') {
    properties.radiusMeters = row.radius_meters;
    return {
      type: 'Feature',
      properties,
      geometry: {
        type: 'Point',
        coordinates: [row.center_lon as number, row.center_lat as number],
      },
    };
  }

  if (row.shape_type === 'polyline') {
    properties.corridorWidthMeters = row.corridor_width_meters;
    return { type: 'Feature', properties, geometry: row.geometry as Geometry };
  }

  // polygon
  return { type: 'Feature', properties, geometry: row.geometry as Geometry };
}

export function geofencesToGeoJSON(rows: GeofenceRow[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: rows.map(geofenceRowToFeature),
  };
}

// ── Exportar a KML ───────────────────────────────────────────────

function escapeXml(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function coordToKml([lon, lat]: number[]): string {
  return `${lon},${lat},0`;
}

function geofenceRowToKmlPlacemark(row: GeofenceRow): string {
  const extendedData = [`<Data name="type"><value>${escapeXml(row.type)}</value></Data>`];
  let geometryXml: string;

  if (row.shape_type === 'circle') {
    extendedData.push(`<Data name="radiusMeters"><value>${row.radius_meters}</value></Data>`);
    geometryXml = `<Point><coordinates>${row.center_lon},${row.center_lat},0</coordinates></Point>`;
  } else if (row.shape_type === 'polyline') {
    extendedData.push(
      `<Data name="corridorWidthMeters"><value>${row.corridor_width_meters}</value></Data>`,
    );
    const coords = (row.geometry as LineString).coordinates.map(coordToKml).join(' ');
    geometryXml = `<LineString><coordinates>${coords}</coordinates></LineString>`;
  } else {
    const coords = (row.geometry as Polygon).coordinates[0].map(coordToKml).join(' ');
    geometryXml = `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
  }

  return `  <Placemark>
    <name>${escapeXml(row.name)}</name>
    <ExtendedData>${extendedData.join('')}</ExtendedData>
    ${geometryXml}
  </Placemark>`;
}

export function geofencesToKml(rows: GeofenceRow[]): string {
  const placemarks = rows.map(geofenceRowToKmlPlacemark).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>Geocercas GAGA-GPS</name>
${placemarks}
</Document>
</kml>`;
}

// ── Importar - GeoJSON/KML → parámetros para GeofenceRepository.create() ─

export interface GeofenceInput {
  name: string;
  type: GeofenceType;
  shapeType: GeofenceShapeType;
  centerLat?: number;
  centerLon?: number;
  radiusMeters?: number;
  geometry?: Polygon | LineString;
  corridorWidthMeters?: number;
}

interface FeatureConversionResult {
  input?: GeofenceInput;
  error?: string;
}

/**
 * Convierte un Feature GeoJSON en los parámetros esperados por
 * GeofenceRepository.create(). Retorna null (con un motivo) si el
 * feature no se puede mapear a una de nuestras 3 formas soportadas.
 */
function featureToGeofenceInput(feature: Feature, index: number): FeatureConversionResult {
  const props: Record<string, unknown> = feature.properties || {};
  const name = (props.name as string) || `Geocerca importada ${index + 1}`;
  const type: GeofenceType =
    props.type === 'danger' ? 'danger' : props.type === 'parking' ? 'parking' : 'warning';
  const geometry = feature.geometry;

  if (!geometry) return { error: `Feature ${index + 1}: sin geometría` };

  if (geometry.type === 'Point') {
    const radiusMeters = Number(props.radiusMeters ?? props.radius);
    if (!radiusMeters || radiusMeters <= 0) {
      return { error: `Feature ${index + 1} (Point "${name}"): falta radiusMeters - se omite` };
    }
    const [lon, lat] = (geometry as Point).coordinates;
    return {
      input: { name, type, shapeType: 'circle', centerLat: lat, centerLon: lon, radiusMeters },
    };
  }

  if (geometry.type === 'Polygon') {
    return { input: { name, type, shapeType: 'polygon', geometry: geometry as Polygon } };
  }

  if (geometry.type === 'LineString') {
    const corridorWidthMeters = Number(props.corridorWidthMeters ?? props.width);
    if (!corridorWidthMeters || corridorWidthMeters <= 0) {
      return {
        error: `Feature ${index + 1} (LineString "${name}"): falta corridorWidthMeters - se omite`,
      };
    }
    return {
      input: {
        name,
        type,
        shapeType: 'polyline',
        geometry: geometry as LineString,
        corridorWidthMeters,
      },
    };
  }

  return { error: `Feature ${index + 1}: tipo de geometría no soportado (${geometry.type})` };
}

export function geoJSONToGeofenceInputs(featureCollection: FeatureCollection | null | undefined): {
  inputs: GeofenceInput[];
  errors: string[];
} {
  const features = featureCollection?.features || [];
  const inputs: GeofenceInput[] = [];
  const errors: string[] = [];

  features.forEach((feature, index) => {
    const result = featureToGeofenceInput(feature, index);
    if (result.error) errors.push(result.error);
    else if (result.input) inputs.push(result.input);
  });

  return { inputs, errors };
}

export function kmlToGeofenceInputs(kmlString: string): {
  inputs: GeofenceInput[];
  errors: string[];
} {
  const dom = new DOMParser().parseFromString(kmlString, 'text/xml');
  const featureCollection = togeojson.kml(dom);
  return geoJSONToGeofenceInputs(featureCollection);
}
