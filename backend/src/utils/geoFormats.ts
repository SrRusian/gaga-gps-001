import { DOMParser } from '@xmldom/xmldom';
import { kml as kmlToGeoJSON } from '@tmcw/togeojson';
import type { GeofenceShapeType, GeofenceType } from '@gaga-gps/shared-types';
import type { Feature, FeatureCollection, Geometry, LineString, Point, Polygon } from 'geojson';

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
  speed_limit_kmh: number | null;
}

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

  return { type: 'Feature', properties, geometry: row.geometry as Geometry };
}

export function geofencesToGeoJSON(rows: GeofenceRow[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: rows.map(geofenceRowToFeature),
  };
}

// duplicado a proposito de web/packages/map-core/src/geofenceLayer.ts (GEOFENCE_COLORS) - shared-types
// no puede exportar valores reales que el backend importe (ver gotcha de shared-types en CLAUDE.md)
const GEOFENCE_COLORS: Record<GeofenceType, string> = {
  forbidden: '#212121',
  danger: '#ff1f3d',
  warning: '#ffb300',
  authorized_route: '#ff6d00',
  allowed: '#00c853',
  parking: '#2979ff',
  discharge: '#a1662f',
  maintenance: '#8e24aa',
};

// #rrggbb (css) -> aabbggrr (kml)
function cssHexToKmlColor(hex: string, alpha = 'ff'): string {
  return `${alpha}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toLowerCase();
}

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

  const hex = GEOFENCE_COLORS[row.type] ?? GEOFENCE_COLORS.warning;
  const styleXml =
    `<Style><LineStyle><color>${cssHexToKmlColor(hex)}</color><width>2</width></LineStyle>` +
    `<PolyStyle><color>${cssHexToKmlColor(hex, '4d')}</color></PolyStyle></Style>`;

  return `  <Placemark>
    <name>${escapeXml(row.name)}</name>
    <ExtendedData>${extendedData.join('')}</ExtendedData>
    ${styleXml}
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

// KML (Google Earth, drones) siempre trae altitud en cada coordenada - la columna PostGIS es
// 2D, así que hay que descartarla antes de guardar (si no, "Geometry has Z dimension...")
function force2DPosition(pos: number[]): [number, number] {
  return [pos[0], pos[1]];
}

function force2DPolygon(geom: Polygon): Polygon {
  return { type: 'Polygon', coordinates: geom.coordinates.map((ring) => ring.map(force2DPosition)) };
}

function force2DLineString(geom: LineString): LineString {
  return { type: 'LineString', coordinates: geom.coordinates.map(force2DPosition) };
}

const VALID_GEOFENCE_TYPES = new Set(Object.keys(GEOFENCE_COLORS));

// KML nativo de Google Earth no trae nuestro "type" - togeojson si extrae bien el color real de
// <LineStyle>/<PolyStyle> en props.stroke/fill (hex), asi que se hace match exacto contra la paleta
function typeFromStyleColor(props: Record<string, unknown>): GeofenceType | null {
  const raw = props.stroke ?? props.fill;
  if (typeof raw !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(raw)) return null;
  const hit = (Object.entries(GEOFENCE_COLORS) as [GeofenceType, string][]).find(
    ([, hex]) => hex.toLowerCase() === raw.toLowerCase(),
  );
  return hit ? hit[0] : null;
}

// el editor de poligonos a mano de Google Earth nombra cada forma con su medida ("0.000"), no con
// un nombre real - en ese caso el styleUrl (nombre del Style/carpeta, ej. "#PELIGRO") es mas util
function resolveFeatureName(props: Record<string, unknown>, index: number): string {
  const rawName = typeof props.name === 'string' ? props.name.trim() : '';
  if (rawName && !/^-?\d+([.,]\d+)?$/.test(rawName)) return rawName;

  const styleUrl = typeof props.styleUrl === 'string' ? props.styleUrl.replace(/^#/, '') : '';
  if (styleUrl) return styleUrl;

  return `Geocerca importada ${index + 1}`;
}

function featureToGeofenceInput(
  feature: Feature<Geometry | null>,
  index: number,
): FeatureConversionResult {
  const props: Record<string, unknown> = feature.properties || {};
  const name = resolveFeatureName(props, index);
  const type: GeofenceType =
    (VALID_GEOFENCE_TYPES.has(props.type as string) && (props.type as GeofenceType)) ||
    typeFromStyleColor(props) ||
    'warning';
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
    return {
      input: { name, type, shapeType: 'polygon', geometry: force2DPolygon(geometry as Polygon) },
    };
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
        geometry: force2DLineString(geometry as LineString),
        corridorWidthMeters,
      },
    };
  }

  return { error: `Feature ${index + 1}: tipo de geometría no soportado (${geometry.type})` };
}

export function geoJSONToGeofenceInputs(
  featureCollection: FeatureCollection<Geometry | null> | null | undefined,
): {
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
  // Google Earth exporta KML con BOM UTF-8 (caracter U+FEFF) al inicio - xmldom lo trata como
  // contenido antes de la declaracion <?xml ...?> y truena el parseo por completo, no solo el color
  const cleaned = kmlString.charCodeAt(0) === 0xfeff ? kmlString.slice(1) : kmlString;
  const dom = new DOMParser().parseFromString(cleaned, 'text/xml');
  const featureCollection = kmlToGeoJSON(dom);
  return geoJSONToGeofenceInputs(featureCollection);
}
