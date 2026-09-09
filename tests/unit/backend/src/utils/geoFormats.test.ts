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

// color en formato KML (aabbggrr) - mismo estilo que exporta Google Earth Pro al crear un poligono
// a mano con un color de la paleta propia (nunca nuestro hex exacto). fill=0 por default porque
// asi es como el usuario ya dibuja sus zonas en Google Earth (confirmado en POLIGONOSGE.txt real)
function styledPolygonKml(styleId: string, kmlColor: string, styleUrl = styleId, fill = 0): string {
  return `
    <Style id="${styleId}">
      <LineStyle><color>${kmlColor}</color><width>1.0</width></LineStyle>
      <PolyStyle><color>${kmlColor}</color><fill>${fill}</fill><outline>1</outline></PolyStyle>
    </Style>
    ${polygonKml(styleUrl)}
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

  // Colores reales tomados de un KML exportado por Google Earth Pro (files/TEST-FILES/Alcaraces/
  // POLIGONOSGE.txt) - el usuario eligio estos con la paleta propia de Google Earth, no con
  // nuestro hex exacto. Antes de la deteccion por color mas cercano, los 4 caian en "warning".
  it('detecta "danger" (rojo) aunque el hex de Google Earth no sea el nuestro exacto', () => {
    const { inputs } = kmlToGeofenceInputs(kmlDoc(styledPolygonKml('PELIGRO', 'ff0000ff')));
    expect(inputs[0].type).toBe('danger');
  });

  it('detecta "parking" (azul) aunque el hex de Google Earth no sea el nuestro exacto', () => {
    const { inputs } = kmlToGeofenceInputs(kmlDoc(styledPolygonKml('ESTACIONAMIENTO', 'ffff0000')));
    expect(inputs[0].type).toBe('parking');
  });

  it('detecta "authorized_route" (naranja) aunque el hex de Google Earth no sea el nuestro exacto', () => {
    const { inputs } = kmlToGeofenceInputs(kmlDoc(styledPolygonKml('RUTA300726', 'ff007fff')));
    expect(inputs[0].type).toBe('authorized_route');
  });

  it('detecta "discharge" (cafe) aunque el hex de Google Earth no sea el nuestro exacto', () => {
    const { inputs } = kmlToGeofenceInputs(kmlDoc(styledPolygonKml('DESCARGA', 'ff003f7f')));
    expect(inputs[0].type).toBe('discharge');
  });

  it('detecta "carga" (cyan) con el cyan puro de la rueda de color de Google Earth', () => {
    const { inputs } = kmlToGeofenceInputs(kmlDoc(styledPolygonKml('CARGA', 'ffffff00')));
    expect(inputs[0].type).toBe('carga');
  });

  it('cae en "warning" solo cuando el placemark no trae ningun color', () => {
    const { inputs } = kmlToGeofenceInputs(kmlDoc(polygonKml('SIN_ESTILO')));
    expect(inputs[0].type).toBe('warning');
  });

  // el propio KML del usuario (POLIGONOSGE.txt) dibuja todas sus zonas con <fill>0</fill> - la
  // deteccion de "sin relleno" debe funcionar automaticamente al importar, sin que el usuario
  // tenga que marcar nada a mano despues
  describe('deteccion de "filled" desde <fill> de Google Earth', () => {
    it('un poligono con <fill>0</fill> importa como filled=false con un ancho de borde por default', () => {
      const { inputs } = kmlToGeofenceInputs(kmlDoc(styledPolygonKml('PELIGRO', 'ff0000ff', 'PELIGRO', 0)));
      expect(inputs[0].filled).toBe(false);
      expect(inputs[0].corridorWidthMeters).toBeGreaterThan(0);
    });

    it('un poligono con <fill>1</fill> importa como filled=true (zona completa, sin ancho de borde)', () => {
      const { inputs } = kmlToGeofenceInputs(kmlDoc(styledPolygonKml('PELIGRO', 'ff0000ff', 'PELIGRO', 1)));
      expect(inputs[0].filled).toBe(true);
      expect(inputs[0].corridorWidthMeters).toBeUndefined();
    });

    it('un poligono sin ningun PolyStyle importa como filled=true por default (sin cambio de comportamiento)', () => {
      const { inputs } = kmlToGeofenceInputs(kmlDoc(polygonKml('SIN_ESTILO')));
      expect(inputs[0].filled).toBe(true);
    });
  });
});
