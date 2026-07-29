/**
 * geoFormats.js
 *
 * Conversión de geocercas entre el modelo interno (fila de
 * PostgreSQL) y formatos estándar de intercambio geoespacial:
 *   - GeoJSON (RFC 7946) — formato principal, nativo en JS
 *   - KML — muy usado en topografía/minería y Google Earth
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

const { DOMParser } = require('@xmldom/xmldom');
const togeojson = require('@tmcw/togeojson');

// ── Exportar a GeoJSON ──────────────────────────────────────────

function geofenceRowToFeature(row) {
  const properties = { name: row.name, type: row.type };

  if (row.shape_type === 'circle') {
    properties.radiusMeters = row.radius_meters;
    return {
      type: 'Feature',
      properties,
      geometry: { type: 'Point', coordinates: [row.center_lon, row.center_lat] }
    };
  }

  if (row.shape_type === 'polyline') {
    properties.corridorWidthMeters = row.corridor_width_meters;
    return { type: 'Feature', properties, geometry: row.geometry };
  }

  // polygon
  return { type: 'Feature', properties, geometry: row.geometry };
}

function geofencesToGeoJSON(rows) {
  return {
    type: 'FeatureCollection',
    features: rows.map(geofenceRowToFeature)
  };
}

// ── Exportar a KML ───────────────────────────────────────────────

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function coordToKml([lon, lat]) {
  return `${lon},${lat},0`;
}

function geofenceRowToKmlPlacemark(row) {
  const extendedData = [`<Data name="type"><value>${escapeXml(row.type)}</value></Data>`];
  let geometryXml;

  if (row.shape_type === 'circle') {
    extendedData.push(`<Data name="radiusMeters"><value>${row.radius_meters}</value></Data>`);
    geometryXml = `<Point><coordinates>${row.center_lon},${row.center_lat},0</coordinates></Point>`;
  } else if (row.shape_type === 'polyline') {
    extendedData.push(`<Data name="corridorWidthMeters"><value>${row.corridor_width_meters}</value></Data>`);
    const coords = row.geometry.coordinates.map(coordToKml).join(' ');
    geometryXml = `<LineString><coordinates>${coords}</coordinates></LineString>`;
  } else {
    const coords = row.geometry.coordinates[0].map(coordToKml).join(' ');
    geometryXml = `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
  }

  return `  <Placemark>
    <name>${escapeXml(row.name)}</name>
    <ExtendedData>${extendedData.join('')}</ExtendedData>
    ${geometryXml}
  </Placemark>`;
}

function geofencesToKml(rows) {
  const placemarks = rows.map(geofenceRowToKmlPlacemark).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>Geocercas GAGA-GPS</name>
${placemarks}
</Document>
</kml>`;
}

// ── Importar — GeoJSON/KML → parámetros para GeofenceRepository.create() ─

/**
 * Convierte un Feature GeoJSON en los parámetros esperados por
 * GeofenceRepository.create(). Retorna null (con un motivo) si el
 * feature no se puede mapear a una de nuestras 3 formas soportadas.
 */
function featureToGeofenceInput(feature, index) {
  const props = feature.properties || {};
  const name = props.name || `Geocerca importada ${index + 1}`;
  const type = props.type === 'danger' ? 'danger' : 'warning';
  const geometry = feature.geometry;

  if (!geometry) return { error: `Feature ${index + 1}: sin geometría` };

  if (geometry.type === 'Point') {
    const radiusMeters = Number(props.radiusMeters ?? props.radius);
    if (!radiusMeters || radiusMeters <= 0) {
      return { error: `Feature ${index + 1} (Point "${name}"): falta radiusMeters — se omite` };
    }
    const [lon, lat] = geometry.coordinates;
    return { input: { name, type, shapeType: 'circle', centerLat: lat, centerLon: lon, radiusMeters } };
  }

  if (geometry.type === 'Polygon') {
    return { input: { name, type, shapeType: 'polygon', geometry } };
  }

  if (geometry.type === 'LineString') {
    const corridorWidthMeters = Number(props.corridorWidthMeters ?? props.width);
    if (!corridorWidthMeters || corridorWidthMeters <= 0) {
      return { error: `Feature ${index + 1} (LineString "${name}"): falta corridorWidthMeters — se omite` };
    }
    return { input: { name, type, shapeType: 'polyline', geometry, corridorWidthMeters } };
  }

  return { error: `Feature ${index + 1}: tipo de geometría no soportado (${geometry.type})` };
}

/**
 * @param {Object} featureCollection - GeoJSON FeatureCollection
 * @returns {{ inputs: Array, errors: Array<string> }}
 */
function geoJSONToGeofenceInputs(featureCollection) {
  const features = featureCollection?.features || [];
  const inputs = [];
  const errors = [];

  features.forEach((feature, index) => {
    const result = featureToGeofenceInput(feature, index);
    if (result.error) errors.push(result.error);
    else inputs.push(result.input);
  });

  return { inputs, errors };
}

/**
 * @param {string} kmlString - contenido de un archivo .kml
 * @returns {{ inputs: Array, errors: Array<string> }}
 */
function kmlToGeofenceInputs(kmlString) {
  const dom = new DOMParser().parseFromString(kmlString, 'text/xml');
  const featureCollection = togeojson.kml(dom);
  return geoJSONToGeofenceInputs(featureCollection);
}

module.exports = {
  geofencesToGeoJSON,
  geofencesToKml,
  geoJSONToGeofenceInputs,
  kmlToGeofenceInputs
};
