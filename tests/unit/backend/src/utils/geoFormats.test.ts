import { describe, expect, it } from 'vitest';
import { kmlToGeofenceInputs } from '../../../../../backend/src/utils/geoFormats';

const BOM = '﻿';

function polygonKml(styleUrl: string, name = '       0.000'): string {
  return `
    <Placemark>
      <name>${name}</name>
      <styleUrl>#${styleUrl}</styleUrl>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>-103.1,19.1,0 -103.2,19.1,0 -103.2,19.2,0 -103.1,19.1,0</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  `;
}

function kmlDoc(body: string, withBom = false): string {
  const doc = `<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2"><Document>${body}</Document></kml>`;
  return withBom ? BOM + doc : doc;
}

describe('kmlToGeofenceInputs', () => {
  it('no truena con el BOM UTF-8 que exporta Google Earth', () => {
    const { inputs, errors } = kmlToGeofenceInputs(kmlDoc(polygonKml('PELIGRO'), true));
    expect(errors).toEqual([]);
    expect(inputs).toHaveLength(1);
  });

  it('usa el styleUrl como nombre cuando el nombre del placemark es solo una medida ("0.000")', () => {
    const { inputs } = kmlToGeofenceInputs(kmlDoc(polygonKml('PELIGRO', '       0.000')));
    expect(inputs[0].name).toBe('PELIGRO');
  });

  it('conserva un nombre real del placemark en vez de usar el styleUrl', () => {
    const { inputs } = kmlToGeofenceInputs(kmlDoc(polygonKml('PELIGRO', 'Zona de voladura norte')));
    expect(inputs[0].name).toBe('Zona de voladura norte');
  });

  it('cae en "Geocerca importada N" si no hay nombre util ni styleUrl', () => {
    const kml = kmlDoc(`
      <Placemark>
        <name>0.000</name>
        <Polygon>
          <outerBoundaryIs>
            <LinearRing>
              <coordinates>-103.1,19.1,0 -103.2,19.1,0 -103.2,19.2,0 -103.1,19.1,0</coordinates>
            </LinearRing>
          </outerBoundaryIs>
        </Polygon>
      </Placemark>
    `);
    const { inputs } = kmlToGeofenceInputs(kml);
    expect(inputs[0].name).toBe('Geocerca importada 1');
  });
});
