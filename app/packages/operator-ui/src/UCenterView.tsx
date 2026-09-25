import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  KioskStatus,
  NmeaMessageId,
  NtripMountpoint,
  RtkFix,
  RtkFixLabel,
  RtkStatus,
  SatelliteInfo,
  UsbDeviceInfo,
} from '@gaga-gps/android-bridge';
import type { NtripProfile } from './ntripProfiles';
import { WORLD_CONTINENTS } from './worldOutline';

// -- utilidades compartidas por varios paneles --------------------------------------------------

function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
  return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
}

function formatTotalBytes(totalBytes: number): string {
  if (totalBytes < 1024) return `${totalBytes} B`;
  if (totalBytes < 1024 * 1024) return `${(totalBytes / 1024).toFixed(1)} KB`;
  return `${(totalBytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatCoord(value: number | null | undefined): string {
  return value != null ? value.toFixed(7) : '--';
}

function formatMeters(value: number | null | undefined, digits = 2): string {
  return value != null ? `${value.toFixed(digits)} m` : '--';
}

function formatDop(value: number | null | undefined): string {
  return value != null ? value.toFixed(2) : '--';
}

// precision dinamica para el encabezado - cm cuando importa la resolucion fina (RTK FIX/FLOAT,
// tipicamente bajo 1m), m para el resto (DGPS/GPS). Prefiere la medicion real del receptor (GST,
// fix.horizontalStdMeters); sin GST habilitado cae a la estimacion categorica por tipo de fix
// (fix.accuracyMeters, mismo criterio de "sin piso artificial" que el resto del proyecto) y lo
// marca con "~" para no presentar una estimacion como si fuera una medicion real.
function formatHeaderPrecision(fix: RtkFix | undefined | null): string | null {
  if (!fix) return null;
  const real = fix.horizontalStdMeters;
  const value = real ?? fix.accuracyMeters;
  if (value == null) return null;
  const prefix = real == null ? '~' : '';
  return value < 1 ? `${prefix}±${Math.round(value * 100)}cm` : `${prefix}±${value.toFixed(1)}m`;
}

// C/N0 en dB-Hz: bajo 25 no sirve ni para posicion estable, 35+ es lo minimo para RTK
function snrColor(snr: number | null): string {
  if (snr == null) return '#4b5563';
  if (snr >= 40) return '#22c55e';
  if (snr >= 35) return '#84cc16';
  if (snr >= 25) return '#eab308';
  return '#ef4444';
}

// paleta categorica para distinguir CONSTELACIONES a simple vista en Satellite Position/World
// Position - eje distinto al de snrColor() (que sigue codificando calidad de señal en Satellite
// Level/History). Mismo criterio que el u-center real, que tambien colorea su sky plot por
// constelacion. Fallback gris para una constelacion no listada (ej. SBAS).
const CONSTELLATION_COLOR: Record<string, string> = {
  GPS: '#4f8ff0',
  GLONASS: '#e0793f',
  Galileo: '#2dd4bf',
  BeiDou: '#c084fc',
  QZSS: '#f4d35e',
  NavIC: '#f472b6',
};

function constellationColor(constellation: string): string {
  return CONSTELLATION_COLOR[constellation] ?? '#9ca3af';
}

function distinctConstellations(satellites: SatelliteInfo[]): string[] {
  return [...new Set(satellites.map((s) => s.constellation))].sort();
}

// leyenda compartida por Satellite Position y World Position - solo lista las constelaciones que
// de verdad estan presentes ahora, no las 6 posibles siempre
function ConstellationLegend({ constellations }: { constellations: string[] }) {
  if (constellations.length === 0) return null;
  return (
    <div className="uc-constellation-legend">
      {constellations.map((c) => (
        <span className="uc-constellation-legend-item" key={c}>
          <span className="uc-constellation-dot" style={{ background: constellationColor(c) }} />
          {c}
        </span>
      ))}
    </div>
  );
}

const SIGNAL_NAMES: Record<string, Record<number, string>> = {
  GPS: { 1: 'L1C/A', 5: 'L2 CM', 6: 'L2 CL' },
  GLONASS: { 1: 'L1 OF', 3: 'L2 OF' },
  Galileo: { 7: 'E1', 2: 'E5b' },
  BeiDou: { 1: 'B1I', 3: 'B2I', 5: 'B2a' },
};

function signalLabel(s: SatelliteInfo): string {
  const band = SIGNAL_NAMES[s.constellation]?.[s.signalId] ?? `señal ${s.signalId}`;
  return `${s.constellation} ${s.id} - ${band} - ${s.snr ?? '--'} dB-Hz${s.used ? ' (en uso)' : ''}`;
}

function fixBadgeColor(label: RtkFixLabel): string {
  switch (label) {
    case 'RTK_FIX':
      return '#3fb950';
    case 'RTK_FLOAT':
      return '#f0a83c';
    case 'DGPS':
    case 'GPS':
      return '#4f8ff0';
    default:
      return '#565d68';
  }
}

function fixBadgeLabel(label: RtkFixLabel): string {
  switch (label) {
    case 'RTK_FIX':
      return 'RTK FIJO';
    case 'RTK_FLOAT':
      return 'RTK FLOTANTE';
    case 'DGPS':
      return 'DGPS';
    case 'GPS':
      return 'GPS';
    default:
      return 'SIN FIX';
  }
}

function groupByConstellation(satellites: SatelliteInfo[] | undefined): [string, SatelliteInfo[]][] {
  const map = new Map<string, SatelliteInfo[]>();
  for (const s of satellites ?? []) {
    const list = map.get(s.constellation);
    if (list) list.push(s);
    else map.set(s.constellation, [s]);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// combina dimension (GSA: 2D/3D) + fixQuality (GGA: DGNSS/RTK) - mismo criterio que la vista
// "Data" de u-center, que muestra ambos ejes en una sola etiqueta ("3D/RTK FIXED")
function fixModeLabel(status: RtkStatus): { text: string; danger: boolean } {
  const fix = status.lastFix;
  const dim = status.dimension;
  if (!fix || fix.fixQuality === 0 || !dim || dim < 2) return { text: 'Sin fix', danger: true };
  const suffix =
    fix.fixQuality === 4
      ? '/RTK FIJO'
      : fix.fixQuality === 5
        ? '/RTK FLOTANTE'
        : fix.fixQuality === 2
          ? '/DGNSS'
          : '';
  return { text: `${dim}D${suffix}`, danger: false };
}

// -- geometria compartida por los graficos polares (sky plot, gauges circulares) -----------------

function polarPoint(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = polarPoint(cx, cy, r, endAngle);
  const end = polarPoint(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
}

// -- Panel: Data ----------------------------------------------------------------------------------

function DataPanel({ status }: { status: RtkStatus }) {
  const fix = status.lastFix;
  const mode = fixModeLabel(status);
  return (
    <div className="cfg-panel">
      <h4 className="cfg-panel-title">Data</h4>
      <div className="cfg-data-grid">
        <div className="cfg-data-row">
          <span>Longitude</span>
          <span>{formatCoord(fix?.longitude)}</span>
        </div>
        <div className="cfg-data-row">
          <span>Latitude</span>
          <span>{formatCoord(fix?.latitude)}</span>
        </div>
        <div className="cfg-data-row">
          <span>Altitude</span>
          <span>{formatMeters(fix?.ellipsoidalAltitudeMeters)}</span>
        </div>
        <div className="cfg-data-row">
          <span>Altitude (msl)</span>
          <span>{formatMeters(fix?.altitude)}</span>
        </div>
        <div className="cfg-data-row">
          <span>TTFF</span>
          <span>{status.ttffMs != null ? `${(status.ttffMs / 1000).toFixed(1)} s` : '--'}</span>
        </div>
        <div className="cfg-data-row">
          <span>Fix Mode</span>
          <span className={mode.danger ? 'uc-value-danger' : undefined}>{mode.text}</span>
        </div>
        <div className="cfg-data-row">
          <span>3D Acc. [m]</span>
          <span>{formatMeters(fix?.fullStdMeters, 3)}</span>
        </div>
        <div className="cfg-data-row">
          <span>2D Acc. [m]</span>
          <span>{formatMeters(fix?.horizontalStdMeters, 3)}</span>
        </div>
        <div className="cfg-data-row">
          <span>PDOP</span>
          <span>{formatDop(status.pdop)}</span>
        </div>
        <div className="cfg-data-row">
          <span>HDOP</span>
          <span>{formatDop(status.hdop)}</span>
        </div>
        <div className="cfg-data-row">
          <span>Satellites</span>
          <span>{fix?.satellites ?? '--'}</span>
        </div>
      </div>
      {fix?.horizontalStdMeters == null && (
        <p className="ds-hint">
          3D/2D Acc. requieren GST habilitado en el puerto del receptor - ver README de aprovisionamiento.
        </p>
      )}
    </div>
  );
}

// -- Panel: Satellite Level (barras de C/N0 por constelacion) -------------------------------------

function SatelliteLevelPanel({ status }: { status: RtkStatus }) {
  const groups = useMemo(() => groupByConstellation(status.satellites), [status.satellites]);
  return (
    <div className="cfg-panel">
      <h4 className="cfg-panel-title">Satellite Level</h4>
      {groups.length === 0 ? (
        <p className="ds-hint">Sin satelites reportados. Requiere que GSV este habilitado en el puerto del receptor.</p>
      ) : (
        <>
          <div className="ds-fix-details">
            <span>PDOP {formatDop(status.pdop)}</span>
            <span>HDOP {formatDop(status.hdop)}</span>
            <span>VDOP {formatDop(status.vdop)}</span>
          </div>
          {groups.map(([constellation, sats]) => (
            <div className="ds-sat-group" key={constellation}>
              <div className="ds-sat-group-title">
                {constellation}
                <span>
                  {sats.filter((s) => s.used).length}/{sats.length} en uso
                </span>
              </div>
              <div className="ds-sat-bars">
                {sats.map((s) => (
                  <div className="ds-sat-bar" key={`${s.id}-${s.signalId}`} title={signalLabel(s)}>
                    <div className="ds-sat-bar-track">
                      <div
                        className="ds-sat-bar-fill"
                        style={{
                          height: `${Math.min(100, ((s.snr ?? 0) / 50) * 100)}%`,
                          background: snrColor(s.snr),
                          opacity: s.used ? 1 : 0.45,
                        }}
                      />
                    </div>
                    <span className="ds-sat-bar-snr">{s.snr ?? '--'}</span>
                    <span className="ds-sat-bar-id">{s.id}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <p className="ds-hint">
            Barra mas alta = señal mas fuerte (mejor recepcion). El numero es C/N0 en dB-Hz: bajo
            25 no sirve ni para posicion basica, RTK necesita 35-45 en varios satelites y en las
            dos frecuencias. Las barras tenues son satelites rastreados que no entran al calculo
            (señal insuficiente o constelacion sin usar).
          </p>
        </>
      )}
    </div>
  );
}

// -- Panel: Satellite Position (sky plot polar) ---------------------------------------------------

function SatellitePositionPanel({ status }: { status: RtkStatus }) {
  const size = 220;
  const center = size / 2;
  const maxR = center - 20;
  const sats = (status.satellites ?? []).filter((s) => s.elevation != null && s.azimuth != null);

  return (
    <div className="cfg-panel">
      <h4 className="cfg-panel-title">Satellite Position</h4>
      <svg viewBox={`0 0 ${size} ${size}`} className="uc-sky-plot">
        {[0, 30, 60].map((deg) => (
          <circle key={deg} cx={center} cy={center} r={(maxR * (90 - deg)) / 90} className="uc-sky-ring" />
        ))}
        <line x1={center} y1={center - maxR} x2={center} y2={center + maxR} className="uc-sky-axis" />
        <line x1={center - maxR} y1={center} x2={center + maxR} y2={center} className="uc-sky-axis" />
        <text x={center} y={14} textAnchor="middle" className="uc-sky-label">
          N
        </text>
        <text x={center} y={size - 4} textAnchor="middle" className="uc-sky-label">
          S
        </text>
        <text x={8} y={center + 4} textAnchor="start" className="uc-sky-label">
          W
        </text>
        <text x={size - 8} y={center + 4} textAnchor="end" className="uc-sky-label">
          E
        </text>
        {sats.map((s) => {
          const r = (maxR * (90 - (s.elevation as number))) / 90;
          const { x, y } = polarPoint(center, center, r, s.azimuth as number);
          return (
            <g key={`${s.constellation}-${s.id}-${s.signalId}`} opacity={s.used ? 1 : 0.5}>
              <circle cx={x} cy={y} r={7} fill={constellationColor(s.constellation)} stroke="#0b0d10" strokeWidth={1} />
              <text x={x} y={y + 3} textAnchor="middle" className="uc-sky-sat-id">
                {s.id}
              </text>
            </g>
          );
        })}
      </svg>
      <ConstellationLegend constellations={distinctConstellations(sats)} />
      {sats.length === 0 && <p className="ds-hint">Sin satelites con elevacion/azimut todavia.</p>}
      <p className="ds-hint">Centro = cenit (90°), borde = horizonte (0°). Util para ver que parte del cielo esta obstruida.</p>
    </div>
  );
}

// -- Panel: World Position (subpunto de cada satelite sobre un mapa mundial simplificado) ----------

const EARTH_RADIUS_KM = 6371;

// altitud orbital tipica por constelacion (km sobre la superficie) - GPS/GLONASS/Galileo/BeiDou MEO
// son casi circulares, la variacion real es de unos cientos de km, despreciable para "mas o menos
// donde" sobre un mapa mundial. QZSS/NavIC son geosincronas/geoestacionarias, mucho mas altas.
const CONSTELLATION_ALTITUDE_KM: Record<string, number> = {
  GPS: 20200,
  GLONASS: 19130,
  Galileo: 23222,
  BeiDou: 21528,
  QZSS: 35786,
  NavIC: 35786,
  GNSS: 20200,
};

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

// subpunto de un satelite (el punto de la superficie terrestre justo debajo) a partir de la
// posicion del observador + elevacion/azimut vistos desde ahi + la altitud orbital tipica de su
// constelacion. Formula estandar de seguimiento satelital ("look angles a subpunto", la inversa de
// calcular Az/El desde una posicion orbital conocida) - geometria esferica real, no un adorno.
// Aproximada a proposito (altitud fija por constelacion, Tierra esferica no elipsoidal) - suficiente
// para "mas o menos donde", no para navegacion.
function satelliteSubpoint(
  observerLat: number,
  observerLon: number,
  elevationDeg: number,
  azimuthDeg: number,
  constellation: string,
): { lat: number; lon: number } | null {
  if (elevationDeg < 0) return null;
  const altitudeKm = CONSTELLATION_ALTITUDE_KM[constellation] ?? CONSTELLATION_ALTITUDE_KM.GNSS;
  const el = toRad(elevationDeg);
  const az = toRad(azimuthDeg);
  const lat0 = toRad(observerLat);
  const lon0 = toRad(observerLon);

  const ratio = (EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altitudeKm)) * Math.cos(el);
  const clamped = Math.min(1, Math.max(-1, ratio));
  const gamma = Math.PI / 2 - el - Math.asin(clamped);

  const subLat = Math.asin(Math.sin(lat0) * Math.cos(gamma) + Math.cos(lat0) * Math.sin(gamma) * Math.cos(az));
  const subLon =
    lon0 +
    Math.atan2(
      Math.sin(gamma) * Math.sin(az),
      Math.cos(lat0) * Math.cos(gamma) - Math.sin(lat0) * Math.sin(gamma) * Math.cos(az),
    );

  return { lat: toDeg(subLat), lon: toDeg(subLon) };
}

function equirectangular(lon: number, lat: number, width: number, height: number) {
  // normaliza la longitud a -180..180 antes de proyectar - atan2 ya regresa en ese rango, pero el
  // subpunto puede salirse ligeramente cerca del antimeridiano
  const normLon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { x: ((normLon + 180) / 360) * width, y: ((90 - lat) / 180) * height };
}

function WorldPositionPanel({ status }: { status: RtkStatus }) {
  const width = 420;
  const height = 210;
  const fix = status.lastFix;
  const sats = (status.satellites ?? []).filter((s) => s.elevation != null && s.azimuth != null);

  const receiverLat = fix?.latitude ?? null;
  const receiverLon = fix?.longitude ?? null;
  const receiver = receiverLat != null && receiverLon != null ? { lat: receiverLat, lon: receiverLon } : null;

  const subpoints = useMemo(() => {
    if (receiverLat == null || receiverLon == null) return [];
    return sats
      .map((s) => {
        const sub = satelliteSubpoint(receiverLat, receiverLon, s.elevation as number, s.azimuth as number, s.constellation);
        return sub ? { ...sub, sat: s } : null;
      })
      .filter((v): v is { lat: number; lon: number; sat: SatelliteInfo } => v != null);
  }, [receiverLat, receiverLon, sats]);

  return (
    <div className="cfg-panel uc-panel-wide">
      <h4 className="cfg-panel-title">World Position</h4>
      <svg viewBox={`0 0 ${width} ${height}`} className="uc-world-map">
        <defs>
          {/* oceano con un leve gradiente vertical (mas claro cerca del ecuador) en vez de un
              fondo plano - lee mas a "mapa" que a "vacio" */}
          <linearGradient id="ucOceanGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0d1219" />
            <stop offset="50%" stopColor="#111826" />
            <stop offset="100%" stopColor="#0d1219" />
          </linearGradient>
        </defs>
        <rect x={0} y={0} width={width} height={height} fill="url(#ucOceanGradient)" />
        {/* graticula cada 30 grados - ecuador/meridiano de Greenwich (0) un poco mas visibles que
            el resto, convencion cartografica estandar para orientarse de un vistazo */}
        {[-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150].map((lon) => {
          const x = equirectangular(lon, 0, width, height).x;
          return (
            <line
              key={`m${lon}`}
              x1={x}
              y1={0}
              x2={x}
              y2={height}
              className={lon === 0 ? 'uc-world-grid-main' : 'uc-world-grid'}
            />
          );
        })}
        {[-60, -30, 0, 30, 60].map((lat) => {
          const y = equirectangular(0, lat, width, height).y;
          return (
            <line
              key={`p${lat}`}
              x1={0}
              y1={y}
              x2={width}
              y2={y}
              className={lat === 0 ? 'uc-world-grid-main' : 'uc-world-grid'}
            />
          );
        })}
        {WORLD_CONTINENTS.map((poly, i) => (
          <polygon
            key={i}
            points={poly.map(([lon, lat]) => {
              const p = equirectangular(lon, lat, width, height);
              return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
            }).join(' ')}
            className="uc-world-land"
          />
        ))}
        {subpoints.map(({ lat, lon, sat }) => {
          const p = equirectangular(lon, lat, width, height);
          return (
            <circle
              key={`${sat.constellation}-${sat.id}-${sat.signalId}`}
              cx={p.x}
              cy={p.y}
              r={4}
              fill={constellationColor(sat.constellation)}
              stroke="#0b0d10"
              strokeWidth={1}
              opacity={sat.used ? 1 : 0.5}
            >
              <title>{signalLabel(sat)}</title>
            </circle>
          );
        })}
        {receiver && (() => {
          const p = equirectangular(receiver.lon, receiver.lat, width, height);
          return (
            <g>
              {/* halo suave detras del anillo - le da algo de profundidad sin animacion ni filtros
                  SVG pesados, solo un circulo extra semi-transparente */}
              <circle cx={p.x} cy={p.y} r={10} className="uc-world-receiver-halo" />
              <circle cx={p.x} cy={p.y} r={5} className="uc-world-receiver-ring" />
              <circle cx={p.x} cy={p.y} r={2.5} className="uc-world-receiver-dot" />
            </g>
          );
        })()}
      </svg>
      <ConstellationLegend constellations={distinctConstellations(sats)} />
      {!receiver && <p className="ds-hint">Sin posicion propia todavia - necesaria para ubicar los satelites en el mapa.</p>}
      <p className="ds-hint">
        Punto grande = posicion del receptor. Puntos chicos = subpunto aproximado de cada satelite (proyeccion
        vertical sobre la superficie, no la posicion orbital real) - altitud tipica por constelacion, informativo.
      </p>
    </div>
  );
}

// -- Panel: Satellite Level History (sparkline por satelite) ---------------------------------------

// 300 (no 30) porque desde que u-center activa el modo diagnostico (ver setDiagnosticsActive en
// DeviceSettingsPanel.tsx), satellites llega hasta a 10Hz - 300 lecturas siguen cubriendo ~30
// segundos de historial real, igual que antes cuando esto solo llegaba 1 vez/seg
const HISTORY_LENGTH = 300;

function useSatelliteHistory(satellites: SatelliteInfo[] | undefined) {
  const historyRef = useRef<Map<string, number[]>>(new Map());
  const [, forceRender] = useState(0);

  useEffect(() => {
    const seenKeys = new Set<string>();
    for (const s of satellites ?? []) {
      const key = `${s.constellation}-${s.id}-${s.signalId}`;
      seenKeys.add(key);
      const arr = historyRef.current.get(key) ?? [];
      arr.push(s.snr ?? 0);
      if (arr.length > HISTORY_LENGTH) arr.shift();
      historyRef.current.set(key, arr);
    }
    // limpia satelites que ya no se reportan - sin esto la memoria crece sin limite en una sesion larga
    for (const key of [...historyRef.current.keys()]) {
      if (!seenKeys.has(key)) historyRef.current.delete(key);
    }
    forceRender((n) => n + 1);
  }, [satellites]);

  return historyRef.current;
}

function Sparkline({ values }: { values: number[] }) {
  const w = 52;
  const h = 40; // coincide con el tamaño renderizado real (.uc-sparkline) para que la linea no se deforme
  const maxSnr = 50;
  const points = values
    .map((v, i) => {
      const x = (i / Math.max(1, HISTORY_LENGTH - 1)) * w;
      const y = h - Math.min(1, v / maxSnr) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="uc-sparkline">
      <polyline points={points} fill="none" stroke="#4f8ff0" strokeWidth={1.5} />
    </svg>
  );
}

// Vuelto al visual de tarjeta+sparkline original (mas legible que la matriz de color en cuadros,
// que resulto confusa en la practica). Panel de una sola columna (no cfg-panel-full) - dentro de su
// propio ancho, las constelaciones (uc-history-groups) siguen agregandose hacia la derecha con
// scroll horizontal si no caben todas, en vez de estirar el panel entero.
function SatelliteLevelHistoryPanel({ status }: { status: RtkStatus }) {
  const history = useSatelliteHistory(status.satellites);
  const groups = useMemo(() => groupByConstellation(status.satellites), [status.satellites]);

  return (
    <div className="cfg-panel">
      <h4 className="cfg-panel-title">Satellite Level History</h4>
      {groups.length === 0 ? (
        <p className="ds-hint">Sin historial todavia.</p>
      ) : (
        <div className="uc-history-groups">
          {groups.map(([constellation, sats]) => (
            <div className="uc-history-group" key={constellation}>
              <div className="ds-sat-group-title">{constellation}</div>
              <div className="uc-history-rows">
                {sats.map((s) => {
                  const key = `${s.constellation}-${s.id}-${s.signalId}`;
                  return (
                    <div className="uc-history-row" key={key}>
                      <span className="uc-history-row-id">{s.id}</span>
                      <Sparkline values={history.get(key) ?? []} />
                      <span className="uc-history-row-snr">{s.snr ?? '--'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="ds-hint">Ultimas {HISTORY_LENGTH} lecturas de C/N0 - util para ver un satelite intermitente que las barras no muestran.</p>
    </div>
  );
}

// -- Paneles: instrumentos (Compass / Speed Meter / Altitude Meter) --------------------------------

function ArcGauge({
  value,
  max,
  labels,
}: {
  value: number | null;
  max: number;
  labels: number[];
}) {
  const size = 150;
  const center = size / 2;
  const r = center - 26;
  const sweepStart = -135;
  const sweepDeg = 270;

  function angleFor(v: number) {
    return sweepStart + (Math.min(max, Math.max(0, v)) / max) * sweepDeg;
  }

  const needleAngle = value != null ? angleFor(value) : sweepStart;
  const needleTip = polarPoint(center, center, r * 0.85, needleAngle);

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="uc-gauge">
      <path d={describeArc(center, center, r, sweepStart, sweepStart + sweepDeg)} className="uc-gauge-track" fill="none" />
      {labels.map((l) => {
        const p = polarPoint(center, center, r + 14, angleFor(l));
        return (
          <text key={l} x={p.x} y={p.y + 3} textAnchor="middle" className="uc-gauge-tick">
            {l}
          </text>
        );
      })}
      {value != null && <line x1={center} y1={center} x2={needleTip.x} y2={needleTip.y} className="uc-gauge-needle" />}
      <circle cx={center} cy={center} r={4} fill="#e8eaed" />
    </svg>
  );
}

function CompassPanel({ status }: { status: RtkStatus }) {
  const course = status.lastFix?.courseDeg;
  const size = 150;
  const center = size / 2;
  const r = center - 26;
  const needleTip = course != null ? polarPoint(center, center, r * 0.85, course) : null;

  return (
    <div className="cfg-panel">
      <h4 className="cfg-panel-title">Compass</h4>
      <svg viewBox={`0 0 ${size} ${size}`} className="uc-gauge">
        <circle cx={center} cy={center} r={r} className="uc-gauge-ring" fill="none" />
        <text x={center} y={16} textAnchor="middle" className="uc-sky-label">
          N
        </text>
        <text x={center} y={size - 4} textAnchor="middle" className="uc-sky-label">
          S
        </text>
        <text x={8} y={center + 4} textAnchor="start" className="uc-sky-label">
          W
        </text>
        <text x={size - 8} y={center + 4} textAnchor="end" className="uc-sky-label">
          E
        </text>
        {needleTip ? (
          <line x1={center} y1={center} x2={needleTip.x} y2={needleTip.y} className="uc-gauge-needle" />
        ) : (
          <circle cx={center} cy={center} r={3} fill="#565d68" />
        )}
      </svg>
      <p className="ds-hint">{course != null ? `Rumbo ${course.toFixed(0)}°` : 'Sin rumbo (vehiculo detenido o sin fix)'}</p>
    </div>
  );
}

function SpeedMeterPanel({ status }: { status: RtkStatus }) {
  const kmh = status.lastFix?.speedMps != null ? status.lastFix.speedMps * 3.6 : null;
  return (
    <div className="cfg-panel">
      <h4 className="cfg-panel-title">Speed Meter</h4>
      <ArcGauge value={kmh} max={250} labels={[0, 50, 100, 150, 200, 250]} />
      <p className="ds-hint">{kmh != null ? `${kmh.toFixed(1)} km/h` : 'Sin dato de velocidad'}</p>
    </div>
  );
}

function AltitudeMeterPanel({ status }: { status: RtkStatus }) {
  const alt = status.lastFix?.ellipsoidalAltitudeMeters ?? status.lastFix?.altitude ?? null;
  return (
    <div className="cfg-panel">
      <h4 className="cfg-panel-title">Altitude Meter</h4>
      {/* aguja simple en vez del dial de tambores giratorios de u-center - misma informacion, sin
          el costo de un componente de digitos rotativos que no aporta mas valor diagnostico */}
      <ArcGauge value={alt} max={3000} labels={[0, 750, 1500, 2250, 3000]} />
      <p className="ds-hint">{alt != null ? `${alt.toFixed(1)} m` : 'Sin dato de altitud'}</p>
    </div>
  );
}

// -- Panel: Watch -----------------------------------------------------------------------------------

function WatchPanel({ status }: { status: RtkStatus }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const gpsTimeMs = status.lastFix?.gpsTimeMs;
  const gpsDate = gpsTimeMs != null ? new Date(gpsTimeMs) : null;
  const deviceUtc = new Date().toISOString().substring(11, 19);
  const driftSeconds = gpsTimeMs != null ? Math.abs((Date.now() - gpsTimeMs) / 1000) : null;

  return (
    <div className="cfg-panel">
      <h4 className="cfg-panel-title">Watch</h4>
      <div className="uc-watch-time">{gpsDate ? `${gpsDate.toISOString().substring(11, 19)} UTC` : '--:--:-- UTC'}</div>
      <p className="ds-hint">
        {gpsDate
          ? `Hora GPS real (RMC). Tableta: ${deviceUtc} UTC${driftSeconds != null && driftSeconds > 2 ? ` - desfase ${driftSeconds.toFixed(0)}s` : ''}`
          : 'Sin hora GPS todavia - requiere un RMC valido con fecha.'}
      </p>
    </div>
  );
}

// -- Seccion: Receptor (Bluetooth + USB), movida desde Ajustes -------------------------------------

export interface UCenterConnectionProps {
  kioskStatus: KioskStatus;
  mockLocationBusy: boolean;
  onOpenDeveloperOptions: () => void;
  onRetryMockLocation: () => void;
  btDevices: { address: string; name: string | null }[];
  onGrantBluetoothPermission: () => void;
  usbDevices: UsbDeviceInfo[];
  baudRate: number;
  onUpdateBaudRate: (value: number) => void;
}

function StatusDot({ on }: { on: boolean }) {
  return <span className={`cfg-status-dot${on ? ' cfg-status-dot--on' : ''}`} />;
}

// baud real entre el HC-05 y el UART2 del receptor - fijado UNA VEZ por hardware en el
// aprovisionamiento (AT+UART en el HC-05 + CFG-PRT de UART2 en u-center, ver README), nunca
// leido ni aplicado desde aqui: RFCOMM (Bluetooth Classic) no tiene ningun concepto de baud rate,
// asi que Android no tiene forma de consultarlo ni cambiarlo. Puramente informativo - si algun dia
// se reconfigura el HC-05 a otro valor, este numero hay que actualizarlo aqui a mano tambien.
const BLUETOOTH_UART_BAUD_RATE = 115200;

// fila de "Baud rate" de solo lectura - misma forma visual para Bluetooth y USB nativo, ninguno
// de los dos puede aplicarse desde la app (ver comentario en BLUETOOTH_UART_BAUD_RATE y
// UsbSerialDriver.hasFixedBaud en el lado nativo)
function ReadOnlyBaudRow({ value, note }: { value: string; note: string }) {
  return (
    <div className="uc-baud-row">
      <span className="ds-label">Baud rate</span>
      <span className="cfg-chip">
        {value}
        <span className="cfg-chip-note">{note}</span>
      </span>
    </div>
  );
}

// Pura vista de estado - sin nada que elegir ni desconectar. La prioridad de transporte (USB gana,
// Bluetooth es respaldo automatico) y la conexion misma viven enteramente del lado nativo
// (RtkNtripPlugin.applyTransportPriority), disparadas por eventos del sistema (attach USB, enlace
// Bluetooth disponible) - nunca por una accion de esta pantalla. Dejar elegir aqui solo invitaba a
// error humano (con un solo receptor real, jamas hay nada genuino que elegir) y un boton de
// "Desconectar" contradice el objetivo: el RTK debe seguir alimentando posicion sin que nadie
// tenga que acordarse de apagarlo.
function ReceiverSection({ status, connection }: { status: RtkStatus; connection: UCenterConnectionProps }) {
  // el receptor USB conectado ahora mismo (o, si ninguno esta conectado todavia, el primero
  // detectado) - solo para saber si tiene baud fijo o no, nunca para elegir cual usar
  const usbDevice =
    connection.usbDevices.find((d) => d.deviceId === status.connectedUsbDeviceId) ?? connection.usbDevices[0] ?? null;

  return (
    <section className="uc-config-section">
      <h4 className="uc-config-title">Receptor</h4>

      {!status.mockLocationAllowed && (
        <div className="cfg-warning-box">
          <p>
            <strong>Pendiente:</strong> falta seleccionar esta app como ubicacion simulada para que
            el RTK reemplace el GPS interno.
          </p>
          <div className="ds-actions">
            <button onClick={connection.onOpenDeveloperOptions}>Abrir Ajustes de Android</button>
            <button onClick={connection.onRetryMockLocation} disabled={connection.mockLocationBusy}>
              {connection.mockLocationBusy ? 'Verificando…' : 'Ya lo hice, verificar'}
            </button>
          </div>
          {!connection.kioskStatus.developerOptionsEnabled && (
            <p className="cfg-mini-hint">
              Antes: Opciones de desarrollador (Ajustes {'>'} Acerca de la tableta, toca 7 veces
              "Numero de compilacion") {'>'} "Seleccionar app de ubicacion falsa" {'>'} GAGA Operador.
            </p>
          )}
        </div>
      )}

      <h5 className="uc-config-subtitle">Bluetooth</h5>
      <div className="cfg-status-row">
        <StatusDot on={status.bluetoothConnected} />
        <span className="cfg-status-text" title={status.bluetoothConnected ? status.connectedBluetoothName ?? undefined : undefined}>
          {status.bluetoothConnected
            ? `${status.connectedBluetoothName ?? 'Conectado'} · ${formatRate(status.bluetoothDataRateBps)} · ${formatTotalBytes(status.bluetoothTotalBytes)} total`
            : 'Sin conectar - se conecta solo al modulo vinculado'}
        </span>
      </div>
      {!status.bluetoothPermissionGranted && (
        <button className="uc-link-button" onClick={connection.onGrantBluetoothPermission}>
          Permitir Bluetooth
        </button>
      )}
      {status.bluetoothPermissionGranted && !status.bluetoothEnabled && (
        <p className="cfg-mini-hint">Bluetooth apagado - enciendelo en Ajustes de Android.</p>
      )}
      {status.bluetoothPermissionGranted && status.bluetoothEnabled && connection.btDevices.length === 0 && (
        <p className="cfg-mini-hint">Vincula el HC-05 en Ajustes de Android (codigo 1234) y se conectara solo.</p>
      )}
      <ReadOnlyBaudRow value={`${BLUETOOTH_UART_BAUD_RATE}`} note="fijo en el HC-05 - ver README" />

      <h5 className="uc-config-subtitle">USB</h5>
      <div className="cfg-status-row">
        <StatusDot on={status.usbConnected} />
        <span className="cfg-status-text">
          {status.usbConnected
            ? `Conectado · ${formatRate(status.usbDataRateBps)} · ${formatTotalBytes(status.usbTotalBytes)} total`
            : 'Sin conectar'}
        </span>
      </div>
      {usbDevice &&
        (usbDevice.hasFixedBaud ? (
          <ReadOnlyBaudRow value="Sin baud rate" note="puerto USB nativo del receptor" />
        ) : (
          <div className="uc-baud-row">
            <label className="ds-label">Baud rate</label>
            <input
              type="number"
              value={connection.baudRate}
              onChange={(e) => connection.onUpdateBaudRate(Number(e.target.value))}
            />
          </div>
        ))}

      <p className="cfg-mini-hint">USB tiene prioridad sobre Bluetooth - conecta solo al que este disponible.</p>
    </section>
  );
}

// -- Seccion: NTRIP Client, movida desde Ajustes ----------------------------------------------------

export interface UCenterNtripProps {
  profiles: NtripProfile[];
  activeProfileId: string;
  activeProfile: NtripProfile | null;
  message: string;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onEdit: (profile: NtripProfile) => void;
  onRemove: (id: string) => void;
  showModal: boolean;
  form: NtripProfile | null;
  onFormChange: (profile: NtripProfile) => void;
  onSearchMountpoints: () => void;
  mountpointsLoading: boolean;
  mountpointsError: string;
  mountpoints: NtripMountpoint[];
  formError: string;
  onSave: () => void;
  onCloseModal: () => void;
  // credenciales NTRIP de fabrica pedidas al backend en vivo (GET /api/app/ntrip-config, clave
  // compartida) - nunca hardcodeadas en el APK, ver DeviceSettingsPanel.tsx fetchNtripFromServer()
  onFetchFromServer: () => void;
  fetchFromServerBusy: boolean;
  fetchFromServerError: string;
}

// aprovisionamiento del receptor (UBX-CFG-VALSET) - ver UbxConfig.kt para el detalle exacto de que
// se manda; esta pantalla deja editar los mismos campos que u-center real expone en sus vistas
// RATE/NMEA/NAV5/GNSS, para no aplicar un preset ciego sin poder ajustarlo
export interface ReceiverProvisioningOptions {
  measRateMs: number;
  navRateCyc: number;
  dynModel: number;
  highPrecision: boolean;
  qzssEnabled: boolean;
  portTarget: 'I2C' | 'UART1' | 'UART2' | 'USB' | 'SPI';
  portBaudRate: number;
  portDatabits: number;
  portStopbits: number;
  portParity: number;
  portI2cAddress: number;
  portSpiCpol: boolean;
  portSpiCpha: boolean;
  portProtocolInUbx: boolean;
  portProtocolInNmea: boolean;
  portProtocolInRtcm3x: boolean;
  portProtocolInSpartn: boolean;
  portProtocolOutUbx: boolean;
  portProtocolOutNmea: boolean;
  portProtocolOutRtcm3x: boolean;
  timeRef: number;
  msgRates: { message: NmeaMessageId; port: 'UART1' | 'UART2' | 'USB'; on: boolean; value: number }[];
  nmeaProtVer: number;
  nmeaMaxSvs: number;
  nmeaCompat: boolean;
  nmeaConsider: boolean;
  nmeaLimit82: boolean;
  nmeaSvNumbering: number;
  nmeaFiltGps: boolean;
  nmeaFiltSbas: boolean;
  nmeaFiltGal: boolean;
  nmeaFiltQzss: boolean;
  nmeaFiltGlo: boolean;
  nmeaFiltBds: boolean;
  nmeaOutInvFix: boolean;
  nmeaOutMskFix: boolean;
  nmeaOutInvTime: boolean;
  nmeaOutInvDate: boolean;
  nmeaOutOnlyGps: boolean;
  nmeaOutFrozenCog: boolean;
  nmeaMainTalkerId: number;
  nmeaGsvTalkerId: number;
  nmeaBdsTalkerId: string;
}

export interface UCenterProvisioningProps {
  onApply: (options: ReceiverProvisioningOptions) => void;
  busy: boolean;
  message: string;
  error: string;
}

// mismas constantes que CFG-NAVSPG-DYNMODEL (ver UbxConfig.kt) - Automotive es el default porque es
// el unico modelo relevante para este proyecto, pero el resto son valores reales del receptor, no
// inventados, por si algun dia hace falta un equipo distinto (embarcacion, caminando, etc)
const DYN_MODEL_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Portable' },
  { value: 2, label: 'Stationary' },
  { value: 3, label: 'Pedestrian' },
  { value: 4, label: 'Automotive' },
  { value: 5, label: 'Sea' },
  { value: 6, label: 'Airborne <1g' },
  { value: 7, label: 'Airborne <2g' },
  { value: 8, label: 'Airborne <4g' },
  { value: 9, label: 'Wrist watch' },
];

// CFG-UARTn-BAUDRATE, PORT_TARGET_OPTIONS - Target ahora incluye los 5 puertos reales del ZED-F9P
// (I2C=0, UART1=1, UART2=2, USB=3, SPI=4 - misma numeracion de portID que u-center usa), pedido
// explicito tras confirmar contra el manual mas reciente (u-blox F9 HPG 1.32, UBX-22008968-R01) que
// las 5 secciones de configuracion (CFG-I2C*/CFG-UART1*/CFG-UART2*/CFG-USB*/CFG-SPI*) existen y
// siguen exactamente el mismo patron de bases in/out ya usado - ver UbxConfig.kt.
const BAUD_RATE_OPTIONS = [4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

const PORT_TARGET_OPTIONS: { value: 'I2C' | 'UART1' | 'UART2' | 'USB' | 'SPI'; label: string }[] = [
  { value: 'I2C', label: '0 - I2C' },
  { value: 'UART1', label: '1 - UART1' },
  { value: 'UART2', label: '2 - UART2' },
  { value: 'USB', label: '3 - USB' },
  { value: 'SPI', label: '4 - SPI' },
];

// CFG-UARTn-DATABITS solo soporta estos 2 (la vista legada de u-center tambien lista 5/6, pero esa
// clave moderna no los tiene) - RE-VERIFICADO contra el manual mas reciente (HPG 1.32, Table 63),
// sigue siendo asi, no es un caso de manual desactualizado como paso con NMEA/Galileo/4.11.
const DATABITS_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '8' },
  { value: 1, label: '7' },
];

// CFG-UARTn-STOPBITS - las 4 constantes reales (Table 62 del manual HPG 1.32): HALF(0)=0.5,
// ONE(1)=1.0, ONEHALF(2)=1.5, TWO(3)=2.0. HALF se habia excluido antes asumiendo (sin verificar)
// que u-center no la ofrecia - correccion real: SI es una constante real y documentada, se agrega
// por completitud (mismo criterio ya aplicado a GQ=7 en Main Talker ID de la vista NMEA).
const STOPBITS_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '0.5' },
  { value: 1, label: '1' },
  { value: 2, label: '1.5' },
  { value: 3, label: '2' },
];

// CFG-UARTn-PARITY solo soporta estos 3 (Space/Mark de la vista legada de u-center no existen aqui)
// - RE-VERIFICADO contra el manual mas reciente (HPG 1.32, Table 64), confirmado sin cambios.
const PARITY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Odd' },
  { value: 2, label: 'Even' },
];

// Protocol in/out de u-center real es UN solo desplegable por direccion (no checkboxes
// independientes) con combinaciones predefinidas. RE-VERIFICADO contra el manual mas reciente
// (HPG 1.32) tras la correccion de NMEA/Galileo/4.11 - esta vez el resultado fue el MISMO que antes,
// no un cambio: RTCM2(2)/RAW(3)/USER0-3(12-15) siguen sin clave moderna (`CFG-UARTnINPROT-*`/
// `OUTPROT-*` solo tienen UBX/NMEA/RTCM3X/SPARTN - Table 65/66) y el propio mensaje LEGADO
// UBX-CFG-PRT (el que u-center usa bajo el capo, tambien re-verificado en el manual actual, no uno
// viejo) solo define 4 bits de entrada (UBX/NMEA/RTCM2/RTCM3) y 3 de salida (UBX/NMEA/RTCM3) - ni
// RAW ni USER0-3 existen ahi tampoco, ni en la version actual del firmware. u-center los muestra
// igual porque su dropdown es generico para TODA la familia de receptores u-blox que soporta (M8 y
// anteriores si tenian esos bits), no especifico de este ZED-F9P.
// SPARTN (6) SI es real y nueva - confirmado en Table 65 (`CFG-UARTnINPROT-SPARTN`), agregada en
// firmware posterior al primer manual usado en esta sesion, solo existe como protocolo de ENTRADA
// (Table 66 de salida no la lista) - por eso solo aparece en PROTOCOL_IN_OPTIONS, nunca en OUT.
const PROTOCOL_IN_OPTIONS: { value: string; label: string; ubx: boolean; nmea: boolean; rtcm3x: boolean; spartn: boolean }[] = [
  { value: 'none', label: 'none', ubx: false, nmea: false, rtcm3x: false, spartn: false },
  { value: 'ubx', label: '0 - UBX', ubx: true, nmea: false, rtcm3x: false, spartn: false },
  { value: 'nmea', label: '1 - NMEA', ubx: false, nmea: true, rtcm3x: false, spartn: false },
  { value: 'rtcm3x', label: '5 - RTCM3', ubx: false, nmea: false, rtcm3x: true, spartn: false },
  { value: 'spartn', label: '6 - SPARTN', ubx: false, nmea: false, rtcm3x: false, spartn: true },
  { value: 'ubx+nmea', label: '0+1 - UBX+NMEA', ubx: true, nmea: true, rtcm3x: false, spartn: false },
  { value: 'ubx+nmea+rtcm3x', label: '0+1+5 - UBX+NMEA+RTCM3', ubx: true, nmea: true, rtcm3x: true, spartn: false },
  {
    value: 'ubx+nmea+rtcm3x+spartn',
    label: '0+1+5+6 - UBX+NMEA+RTCM3+SPARTN',
    ubx: true,
    nmea: true,
    rtcm3x: true,
    spartn: true,
  },
];

const PROTOCOL_OUT_OPTIONS: { value: string; label: string; ubx: boolean; nmea: boolean; rtcm3x: boolean }[] = [
  { value: 'none', label: 'none', ubx: false, nmea: false, rtcm3x: false },
  { value: 'ubx', label: '0 - UBX', ubx: true, nmea: false, rtcm3x: false },
  { value: 'nmea', label: '1 - NMEA', ubx: false, nmea: true, rtcm3x: false },
  { value: 'rtcm3x', label: '5 - RTCM3', ubx: false, nmea: false, rtcm3x: true },
  { value: 'ubx+nmea', label: '0+1 - UBX+NMEA', ubx: true, nmea: true, rtcm3x: false },
  { value: 'ubx+nmea+rtcm3x', label: '0+1+5 - UBX+NMEA+RTCM3', ubx: true, nmea: true, rtcm3x: true },
];

function protocolInFlags(key: string) {
  return PROTOCOL_IN_OPTIONS.find((o) => o.value === key) ?? PROTOCOL_IN_OPTIONS[0];
}
function protocolOutFlags(key: string) {
  return PROTOCOL_OUT_OPTIONS.find((o) => o.value === key) ?? PROTOCOL_OUT_OPTIONS[0];
}

// CFG-RATE-TIMEREF (Table 38, manual HPG 1.32) - Time Source de la vista RATE real de u-center
const TIME_REF_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '0 - UTC Time' },
  { value: 1, label: '1 - GPS Time' },
  { value: 2, label: '2 - GLO Time' },
  { value: 3, label: '3 - BDS Time' },
  { value: 4, label: '4 - GAL Time' },
  { value: 5, label: '5 - NavIC Time' },
];

// vista MSG real de u-center: un mensaje NMEA por fila, con las mismas etiquetas F0-xx que
// muestra el selector real - alcance recortado a proposito a los 7 mensajes que este proyecto ya
// usa (README "Aprovisionamiento de un receptor RTK nuevo"), sobre UART1/UART2/USB (mismo alcance
// ya decidido para "Puertos" - sin I2C/SPI, hardware real no los usa)
const NMEA_MESSAGES: { id: NmeaMessageId; label: string }[] = [
  { id: 'GGA', label: 'F0-00 NMEA GxGGA' },
  { id: 'GLL', label: 'F0-01 NMEA GxGLL' },
  { id: 'GSA', label: 'F0-02 NMEA GxGSA' },
  { id: 'GSV', label: 'F0-03 NMEA GxGSV' },
  { id: 'RMC', label: 'F0-04 NMEA GxRMC' },
  { id: 'VTG', label: 'F0-05 NMEA GxVTG' },
  { id: 'GST', label: 'F0-07 NMEA GxGST' },
];

type MsgPort = 'UART1' | 'UART2' | 'USB';
const MSG_PORTS: MsgPort[] = ['UART1', 'UART2', 'USB'];

type MsgRateState = Record<NmeaMessageId, Record<MsgPort, { on: boolean; value: number }>>;

// mismo comportamiento fijo que este archivo tenia antes de esta ronda (GGA/RMC cada epoca de
// navegacion, el resto a ~1Hz, todo por UART2) - ahora es solo el punto de partida del formulario,
// editable como en u-center real
function defaultMsgRates(): MsgRateState {
  const everyEpoch = { on: true, value: 1 };
  const housekeeping = { on: true, value: 10 };
  const off = { on: false, value: 1 };
  const row = (uart2: { on: boolean; value: number }): Record<MsgPort, { on: boolean; value: number }> => ({
    UART1: { ...off },
    UART2: { ...uart2 },
    USB: { ...off },
  });
  return {
    GGA: row(everyEpoch),
    RMC: row(everyEpoch),
    GLL: row(housekeeping),
    GSA: row(housekeeping),
    GSV: row(housekeeping),
    VTG: row(housekeeping),
    GST: row(housekeeping),
  };
}

function flattenMsgRates(state: MsgRateState): ReceiverProvisioningOptions['msgRates'] {
  const out: ReceiverProvisioningOptions['msgRates'] = [];
  for (const { id: message } of NMEA_MESSAGES) {
    for (const port of MSG_PORTS) {
      const entry = state[message][port];
      out.push({ message, port, on: entry.on, value: entry.value });
    }
  }
  return out;
}

// vista NMEA real de u-center (CFG-NMEA-DATA2) - valores reales de CFG-NMEA-PROTVER, verificados
// contra el manual "u-blox F9 HPG 1.32 Interface Description" (UBX-22008968-R01, mas reciente que
// el R04 usado en la ronda anterior) - V411=42 (NMEA 4.11) es real, agregado en firmware HPG 1.13+.
// Labels en ingles, iguales a u-center real (Emmanuel pidio priorizar el texto original del programa
// sobre traducir).
const NMEA_VERSION_OPTIONS: { value: number; label: string }[] = [
  { value: 21, label: '2.1' },
  { value: 23, label: '2.3' },
  { value: 40, label: '4.0' },
  { value: 41, label: '4.10' },
  { value: 42, label: '4.11' },
];

// CFG-NMEA-MAXSVS - texto real de u-center (captura de Emmanuel)
const MAX_SVS_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '0 - Standard' },
  { value: 8, label: '8 - 8 Channel Receiver' },
  { value: 12, label: '12 - 12 Channel Receiver' },
  { value: 16, label: '16 - 16 Channel Receiver' },
];

// CFG-NMEA-SVNUMBERING - texto real de u-center (captura de Emmanuel)
const SV_NUMBERING_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '0 - Strict (not output)' },
  { value: 1, label: '1 - Extended (3 digit)' },
];

// CFG-NMEA-MAINTALKERID - texto real de u-center (captura de Emmanuel) + GQ=7, agregado en
// firmware posterior al manual R04 (verificado contra HPG 1.32) - no aparece en la captura de
// Emmanuel pero es una constante real y documentada, no una opcion inventada
const MAIN_TALKER_ID_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '0 - System dependent' },
  { value: 1, label: '1 - GP (GPS)' },
  { value: 2, label: '2 - GL (GLONASS)' },
  { value: 3, label: '3 - GN (Combined receiver)' },
  { value: 4, label: '4 - GA (Galileo)' },
  { value: 5, label: '5 - GB (BeiDou)' },
  { value: 7, label: '7 - GQ (QZSS)' },
];

// CFG-NMEA-GSVTALKERID
const GSV_TALKER_ID_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '0 - GNSS Specific' },
  { value: 1, label: '1 - Main Talker ID' },
];

// Selector "CFG-NMEA-DATA0/1/2" del menu superior de la vista NMEA real de u-center - variantes de
// LARGO del mensaje LEGADO UBX-CFG-NMEA (0x06 0x17): DATA0 es el payload original mas corto (solo
// Filters/NMEA Version/Max SVs/Compatibility+Consider), DATA1 le agrega GNSS to filter out/
// Numbering/Main+GSV Talker ID, DATA2 el mas completo agrega ademas BeiDou Talker ID/High precision/
// Strict limit82 - asi u-center soporta receptores viejos que no entienden el mensaje completo.
// Puramente informativo aqui: esta app SIEMPRE usa la interfaz moderna UBX-CFG-VALSET (nunca el
// mensaje legado), y el ZED-F9P (protocolo 27+) siempre soporta las 22 claves sin importar que
// "DATA level" se elija - el selector solo deshabilita los campos en pantalla para verse igual que
// u-center real, nunca deja de mandar esas claves en el mensaje que se aplica.
type NmeaDataLevel = 'DATA0' | 'DATA1' | 'DATA2';
const NMEA_DATA_LEVEL_OPTIONS: { value: NmeaDataLevel; label: string }[] = [
  { value: 'DATA2', label: 'CFG-NMEA-DATA2' },
  { value: 'DATA1', label: 'CFG-NMEA-DATA1' },
  { value: 'DATA0', label: 'CFG-NMEA-DATA0' },
];

function ReceiverProvisioningModal({ provisioning, onClose }: { provisioning: UCenterProvisioningProps; onClose: () => void }) {
  const [measRateMs, setMeasRateMs] = useState(100);
  const [navRateCyc, setNavRateCyc] = useState(1);
  const [timeRef, setTimeRef] = useState(1); // CFG-RATE-TIMEREF, default 1=GPS (factory default real)
  const [dynModel, setDynModel] = useState(4);
  const [highPrecision, setHighPrecisionRaw] = useState(true);
  const [qzssEnabled, setQzssEnabled] = useState(false);

  // vista NMEA (CFG-NMEA-DATA2) - defaults = valores de fabrica reales (ver UbxConfig.kt)
  const [nmeaProtVer, setNmeaProtVer] = useState(42);
  const [nmeaMaxSvs, setNmeaMaxSvs] = useState(0);
  const [nmeaCompat, setNmeaCompatRaw] = useState(false);
  const [nmeaConsider, setNmeaConsider] = useState(true);
  const [nmeaLimit82, setNmeaLimit82Raw] = useState(false);
  const [nmeaSvNumbering, setNmeaSvNumbering] = useState(0);
  const [nmeaFiltGps, setNmeaFiltGps] = useState(false);
  const [nmeaFiltSbas, setNmeaFiltSbas] = useState(false);
  const [nmeaFiltGal, setNmeaFiltGal] = useState(false);
  const [nmeaFiltQzss, setNmeaFiltQzss] = useState(false);
  const [nmeaFiltGlo, setNmeaFiltGlo] = useState(false);
  const [nmeaFiltBds, setNmeaFiltBds] = useState(false);
  const [nmeaOutInvFix, setNmeaOutInvFix] = useState(false);
  const [nmeaOutMskFix, setNmeaOutMskFix] = useState(false);
  const [nmeaOutInvTime, setNmeaOutInvTime] = useState(false);
  const [nmeaOutInvDate, setNmeaOutInvDate] = useState(false);
  const [nmeaOutOnlyGps, setNmeaOutOnlyGps] = useState(false);
  const [nmeaOutFrozenCog, setNmeaOutFrozenCog] = useState(false);
  const [nmeaMainTalkerId, setNmeaMainTalkerId] = useState(0);
  const [nmeaGsvTalkerId, setNmeaGsvTalkerId] = useState(0);
  const [nmeaBdsTalkerId, setNmeaBdsTalkerId] = useState('');
  // CFG-NMEA-DATA0/1/2: puramente visual, ver comentario en NMEA_DATA_LEVEL_OPTIONS - default
  // DATA2 (todo habilitado), igual que el comportamiento de siempre antes de este selector
  const [nmeaDataLevel, setNmeaDataLevel] = useState<NmeaDataLevel>('DATA2');
  const nmeaDisableData1Fields = nmeaDataLevel !== 'DATA2'; // BeiDou Talker ID/High precision/Limit82
  const nmeaDisableData0Fields = nmeaDataLevel === 'DATA0'; // + GNSS filter/Numbering/Talker ID

  // CFG-NMEA-HIGHPREC no puede convivir con COMPAT ni LIMIT82 (el receptor lo rechaza) - activar
  // cualquiera de los 3 apaga los otros dos automaticamente, nunca se manda una combinacion invalida
  function setHighPrecision(v: boolean) {
    setHighPrecisionRaw(v);
    if (v) {
      setNmeaCompatRaw(false);
      setNmeaLimit82Raw(false);
    }
  }
  function setNmeaCompat(v: boolean) {
    setNmeaCompatRaw(v);
    if (v) setHighPrecisionRaw(false);
  }
  function setNmeaLimit82(v: boolean) {
    setNmeaLimit82Raw(v);
    if (v) setHighPrecisionRaw(false);
  }

  const [portTarget, setPortTarget] = useState<'I2C' | 'UART1' | 'UART2' | 'USB' | 'SPI'>('UART2');
  const [portBaudRate, setPortBaudRate] = useState(115200);
  const [portDatabits, setPortDatabits] = useState(0);
  const [portStopbits, setPortStopbits] = useState(1);
  const [portParity, setPortParity] = useState(0);
  const [portI2cAddress, setPortI2cAddress] = useState(66); // CFG-I2C-ADDRESS, 0x42 = default real de fabrica
  const [portSpiCpol, setPortSpiCpol] = useState(false); // CFG-SPI-CPOLARITY, false = Mode 0 (el default real)
  const [portSpiCpha, setPortSpiCpha] = useState(false); // CFG-SPI-CPHASE, false = Mode 0
  // default UART2 real: in = UBX+NMEA+RTCM3, out = solo NMEA
  const [portProtocolIn, setPortProtocolIn] = useState('ubx+nmea+rtcm3x');
  const [portProtocolOut, setPortProtocolOut] = useState('nmea');
  const isUartTarget = portTarget === 'UART1' || portTarget === 'UART2';
  const isI2cTarget = portTarget === 'I2C';
  const isSpiTarget = portTarget === 'SPI';

  const [msgRates, setMsgRates] = useState<MsgRateState>(defaultMsgRates);
  const [selectedMessage, setSelectedMessage] = useState<NmeaMessageId>('GGA');
  function updateMsgRate(message: NmeaMessageId, port: MsgPort, patch: Partial<{ on: boolean; value: number }>) {
    setMsgRates((prev) => ({
      ...prev,
      [message]: { ...prev[message], [port]: { ...prev[message][port], ...patch } },
    }));
  }

  // solo lectura, calculados - igual que "Measurement Frequency"/"Navigation Frequency" en la
  // vista RATE de u-center real, que tampoco se mandan al receptor, son puro derivado en pantalla
  const measFreqHz = measRateMs > 0 ? 1000 / measRateMs : 0;
  const navFreqHz = navRateCyc > 0 ? measFreqHz / navRateCyc : 0;

  return (
    <div className="ds-modal-overlay" onClick={onClose}>
      <div className="cfg-shell" onClick={(e) => e.stopPropagation()}>
        <div className="cfg-header">
          <h3>Configuración del receptor</h3>
          <button className="cfg-close" onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </div>
        <div className="cfg-body">
          <p className="cfg-mini-hint">
            Reemplaza el aprovisionamiento que antes requería una PC con u-center conectada por USB -
            se manda por el mismo cable/Bluetooth que ya está en uso.
          </p>

          <div className="cfg-row">
            <div className="cfg-col">
              <div className="cfg-panel">
                <h4 className="cfg-panel-title">RATE (Rates)</h4>
                <label className="cfg-version-row">
                  <span>Measurement Period (ms)</span>
                  <input
                    type="number"
                    min={50}
                    max={1000}
                    style={{ width: 90 }}
                    value={measRateMs}
                    onChange={(e) => setMeasRateMs(Number(e.target.value))}
                  />
                </label>
                <div className="cfg-version-row">
                  <span>Measurement Frequency</span>
                  <span className="cfg-chip">{measFreqHz.toFixed(2)} Hz</span>
                </div>
                <label className="cfg-version-row">
                  <span>Navigation Rate (cyc)</span>
                  <input
                    type="number"
                    min={1}
                    max={127}
                    style={{ width: 90 }}
                    value={navRateCyc}
                    onChange={(e) => setNavRateCyc(Number(e.target.value))}
                  />
                </label>
                <div className="cfg-version-row">
                  <span>Navigation Frequency</span>
                  <span className="cfg-chip">{navFreqHz.toFixed(2)} Hz</span>
                </div>

                <label className="ds-label">Time Source</label>
                <select value={timeRef} onChange={(e) => setTimeRef(Number(e.target.value))}>
                  {TIME_REF_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="cfg-panel">
                <h4 className="cfg-panel-title">Configuración general</h4>
                <label className="ds-label">Modelo dinámico</label>
                <select value={dynModel} onChange={(e) => setDynModel(Number(e.target.value))}>
                  {DYN_MODEL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <label className="ds-toggle-row">
                  <input type="checkbox" checked={qzssEnabled} onChange={(e) => setQzssEnabled(e.target.checked)} />
                  Activar QZSS (regional de Japón, sin uso en México)
                </label>
              </div>
            </div>

            <div className="cfg-col">
              <div className="cfg-panel">
                <h4 className="cfg-panel-title">PRT (Ports)</h4>
                <label className="ds-label">Target</label>
                <select
                  value={portTarget}
                  onChange={(e) => setPortTarget(e.target.value as 'I2C' | 'UART1' | 'UART2' | 'USB' | 'SPI')}
                >
                  {PORT_TARGET_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <label className="ds-label">Protocol in</label>
                <select value={portProtocolIn} onChange={(e) => setPortProtocolIn(e.target.value)}>
                  {PROTOCOL_IN_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <label className="ds-label">Protocol out</label>
                <select value={portProtocolOut} onChange={(e) => setPortProtocolOut(e.target.value)}>
                  {PROTOCOL_OUT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                {isUartTarget && (
                  <>
                    <label className="ds-label">Baudrate</label>
                    <select value={portBaudRate} onChange={(e) => setPortBaudRate(Number(e.target.value))}>
                      {BAUD_RATE_OPTIONS.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>

                    <label className="ds-label">Databits</label>
                    <select value={portDatabits} onChange={(e) => setPortDatabits(Number(e.target.value))}>
                      {DATABITS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>

                    <label className="ds-label">Stopbits</label>
                    <select value={portStopbits} onChange={(e) => setPortStopbits(Number(e.target.value))}>
                      {STOPBITS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>

                    <label className="ds-label">Parity</label>
                    <select value={portParity} onChange={(e) => setPortParity(Number(e.target.value))}>
                      {PARITY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </>
                )}

                {isI2cTarget && (
                  <>
                    <label className="ds-label">I2C Address</label>
                    <input
                      type="number"
                      min={0}
                      max={127}
                      value={portI2cAddress}
                      onChange={(e) => setPortI2cAddress(Number(e.target.value))}
                    />
                  </>
                )}

                {isSpiTarget && (
                  <>
                    <label className="ds-toggle-row">
                      <input type="checkbox" checked={portSpiCpol} onChange={(e) => setPortSpiCpol(e.target.checked)} />
                      Clock Polarity (Active Low - SCLK idles high)
                    </label>
                    <label className="ds-toggle-row">
                      <input type="checkbox" checked={portSpiCpha} onChange={(e) => setPortSpiCpha(e.target.checked)} />
                      Clock Phase (data capturada en el 2do flanco de SCLK)
                    </label>
                  </>
                )}

                <p className="cfg-mini-hint">
                  Databits/Parity/Protocol muestran solo lo que este receptor puede recibir de verdad -
                  verificado contra el mensaje legado UBX-CFG-PRT completo (los 4 puertos), no solo la
                  interfaz moderna: 5/6 databits y Space/Mark parity no existen en NINGUN mensaje (el
                  propio manual los marca "not supported"), igual que Bit Order (LSB/MSB First, sin
                  ningun campo para eso) y RAW/USER0-3 de Protocol (ni un solo bit en ningun protoMask).
                  RTCM2 (Protocol in) si es real mediante ese mensaje legado, pero deprecated y sin uso
                  en este proyecto (solo UBX+NMEA+RTCM3X hace falta) - se dejo fuera a proposito.
                </p>
              </div>
            </div>

            <div className="cfg-col">
              <div className="cfg-panel">
                <h4 className="cfg-panel-title">MSG (Messages)</h4>
                <label className="ds-label">Message</label>
                <select value={selectedMessage} onChange={(e) => setSelectedMessage(e.target.value as NmeaMessageId)}>
                  {NMEA_MESSAGES.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                {MSG_PORTS.map((port) => {
                  const entry = msgRates[selectedMessage][port];
                  return (
                    <div className="cfg-version-row" key={port}>
                      <label className="ds-toggle-row" style={{ flex: 1, marginBottom: 0 }}>
                        <input
                          type="checkbox"
                          checked={entry.on}
                          onChange={(e) => updateMsgRate(selectedMessage, port, { on: e.target.checked })}
                        />
                        {port}
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={255}
                        style={{ width: 70 }}
                        disabled={!entry.on}
                        value={entry.value}
                        onChange={(e) => updateMsgRate(selectedMessage, port, { value: Number(e.target.value) })}
                      />
                    </div>
                  );
                })}
                <p className="cfg-mini-hint">
                  Cada mensaje se activa/desactiva por puerto, con su propio divisor de la época de
                  navegación (1 = cada época, mayor = mas espaciado) - cambia de mensaje sin perder lo
                  ya ajustado en los demás.
                </p>
              </div>
            </div>

            <div className="cfg-col">
              <div className="cfg-panel">
                <h4 className="cfg-panel-title">NMEA (NMEA Protocol)</h4>
                <select value={nmeaDataLevel} onChange={(e) => setNmeaDataLevel(e.target.value as NmeaDataLevel)}>
                  {NMEA_DATA_LEVEL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <p className="uc-config-subtitle">Filters</p>
                <label className="ds-toggle-row">
                  <input type="checkbox" checked={nmeaOutInvFix} onChange={(e) => setNmeaOutInvFix(e.target.checked)} />
                  Permit position output for failed and invalid fixes
                </label>
                <label className="ds-toggle-row">
                  <input type="checkbox" checked={nmeaOutMskFix} onChange={(e) => setNmeaOutMskFix(e.target.checked)} />
                  Permit position output for invalid fixes
                </label>
                <label className="ds-toggle-row">
                  <input type="checkbox" checked={nmeaOutInvTime} onChange={(e) => setNmeaOutInvTime(e.target.checked)} />
                  Permit time output for invalid times
                </label>
                <label className="ds-toggle-row">
                  <input type="checkbox" checked={nmeaOutInvDate} onChange={(e) => setNmeaOutInvDate(e.target.checked)} />
                  Permit date output for invalid dates
                </label>
                <label className="ds-toggle-row">
                  <input type="checkbox" checked={nmeaOutOnlyGps} onChange={(e) => setNmeaOutOnlyGps(e.target.checked)} />
                  Restrict output to GPS SVs only
                </label>
                <label className="ds-toggle-row">
                  <input type="checkbox" checked={nmeaOutFrozenCog} onChange={(e) => setNmeaOutFrozenCog(e.target.checked)} />
                  Permit COG output even if COG frozen
                </label>

                <label className="ds-label">NMEA Version</label>
                <select value={nmeaProtVer} onChange={(e) => setNmeaProtVer(Number(e.target.value))}>
                  {NMEA_VERSION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <label className="ds-label">Max SVs per Talker Id</label>
                <select value={nmeaMaxSvs} onChange={(e) => setNmeaMaxSvs(Number(e.target.value))}>
                  {MAX_SVS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <p className="uc-config-subtitle">Mode Flags</p>
                <label className="ds-toggle-row">
                  <input type="checkbox" checked={nmeaCompat} onChange={(e) => setNmeaCompat(e.target.checked)} />
                  Compatibility mode
                </label>
                <label className="ds-toggle-row">
                  <input type="checkbox" checked={nmeaConsider} onChange={(e) => setNmeaConsider(e.target.checked)} />
                  Consider mode
                </label>
                <label className="ds-toggle-row">
                  <input
                    type="checkbox"
                    checked={nmeaLimit82}
                    disabled={nmeaDisableData1Fields}
                    onChange={(e) => setNmeaLimit82(e.target.checked)}
                  />
                  Strict limit 82 chars max
                </label>
                <label className="ds-toggle-row">
                  <input
                    type="checkbox"
                    checked={highPrecision}
                    disabled={nmeaDisableData1Fields}
                    onChange={(e) => setHighPrecision(e.target.checked)}
                  />
                  High precision mode (7 decimales en vez de 5)
                </label>
                <p className="cfg-mini-hint">
                  High precision es excluyente con Compatibility/Strict limit 82 - activar cualquiera
                  de los tres apaga los otros dos.
                </p>

                <p className="uc-config-subtitle">GNSS to filter out</p>
                <label className="ds-toggle-row">
                  <input
                    type="checkbox"
                    checked={nmeaFiltGps}
                    disabled={nmeaDisableData0Fields}
                    onChange={(e) => setNmeaFiltGps(e.target.checked)}
                  />
                  GPS
                </label>
                <label className="ds-toggle-row">
                  <input
                    type="checkbox"
                    checked={nmeaFiltSbas}
                    disabled={nmeaDisableData0Fields}
                    onChange={(e) => setNmeaFiltSbas(e.target.checked)}
                  />
                  SBAS
                </label>
                <label className="ds-toggle-row">
                  <input
                    type="checkbox"
                    checked={nmeaFiltGal}
                    disabled={nmeaDisableData0Fields}
                    onChange={(e) => setNmeaFiltGal(e.target.checked)}
                  />
                  Galileo
                </label>
                <label className="ds-toggle-row">
                  <input
                    type="checkbox"
                    checked={nmeaFiltQzss}
                    disabled={nmeaDisableData0Fields}
                    onChange={(e) => setNmeaFiltQzss(e.target.checked)}
                  />
                  QZSS
                </label>
                <label className="ds-toggle-row">
                  <input
                    type="checkbox"
                    checked={nmeaFiltGlo}
                    disabled={nmeaDisableData0Fields}
                    onChange={(e) => setNmeaFiltGlo(e.target.checked)}
                  />
                  GLONASS
                </label>
                <label className="ds-toggle-row">
                  <input
                    type="checkbox"
                    checked={nmeaFiltBds}
                    disabled={nmeaDisableData0Fields}
                    onChange={(e) => setNmeaFiltBds(e.target.checked)}
                  />
                  BeiDou
                </label>

                <label className="ds-label">Numbering used for SVs not supported by NMEA</label>
                <select
                  value={nmeaSvNumbering}
                  disabled={nmeaDisableData0Fields}
                  onChange={(e) => setNmeaSvNumbering(Number(e.target.value))}
                >
                  {SV_NUMBERING_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <label className="ds-label">Main Talker ID</label>
                <select
                  value={nmeaMainTalkerId}
                  disabled={nmeaDisableData0Fields}
                  onChange={(e) => setNmeaMainTalkerId(Number(e.target.value))}
                >
                  {MAIN_TALKER_ID_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <label className="ds-label">GSV Talker ID</label>
                <select
                  value={nmeaGsvTalkerId}
                  disabled={nmeaDisableData0Fields}
                  onChange={(e) => setNmeaGsvTalkerId(Number(e.target.value))}
                >
                  {GSV_TALKER_ID_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <label className="ds-label">BeiDou Talker ID (2 caracteres, opcional)</label>
                <input
                  type="text"
                  maxLength={2}
                  placeholder="Vacio = por defecto"
                  disabled={nmeaDisableData1Fields}
                  value={nmeaBdsTalkerId}
                  onChange={(e) => setNmeaBdsTalkerId(e.target.value.toUpperCase())}
                />
                <p className="cfg-mini-hint">
                  El selector de arriba imita las 3 variantes del mensaje legado que u-center real
                  ofrece por compatibilidad con receptores viejos - esta app siempre usa la interfaz
                  moderna (UBX-CFG-VALSET), que el ZED-F9P soporta completa sin importar el nivel
                  elegido aqui. Solo deshabilita los campos en pantalla para verse igual, nunca deja
                  de aplicar esos valores al presionar "Aplicar configuración".
                </p>
              </div>
            </div>
          </div>

          <p className="cfg-mini-hint">
            Se guarda en la memoria del receptor de una vez. SBAS sigue necesitando u-center real.
          </p>
          <div className="ds-actions">
            <button
              onClick={() => {
                const inFlags = protocolInFlags(portProtocolIn);
                const outFlags = protocolOutFlags(portProtocolOut);
                provisioning.onApply({
                  measRateMs,
                  navRateCyc,
                  timeRef,
                  dynModel,
                  highPrecision,
                  qzssEnabled,
                  portTarget,
                  portBaudRate,
                  portDatabits,
                  portStopbits,
                  portParity,
                  portI2cAddress,
                  portSpiCpol,
                  portSpiCpha,
                  portProtocolInUbx: inFlags.ubx,
                  portProtocolInNmea: inFlags.nmea,
                  portProtocolInRtcm3x: inFlags.rtcm3x,
                  portProtocolInSpartn: inFlags.spartn,
                  portProtocolOutUbx: outFlags.ubx,
                  portProtocolOutNmea: outFlags.nmea,
                  portProtocolOutRtcm3x: outFlags.rtcm3x,
                  msgRates: flattenMsgRates(msgRates),
                  nmeaProtVer,
                  nmeaMaxSvs,
                  nmeaCompat,
                  nmeaConsider,
                  nmeaLimit82,
                  nmeaSvNumbering,
                  nmeaFiltGps,
                  nmeaFiltSbas,
                  nmeaFiltGal,
                  nmeaFiltQzss,
                  nmeaFiltGlo,
                  nmeaFiltBds,
                  nmeaOutInvFix,
                  nmeaOutMskFix,
                  nmeaOutInvTime,
                  nmeaOutInvDate,
                  nmeaOutOnlyGps,
                  nmeaOutFrozenCog,
                  nmeaMainTalkerId,
                  nmeaGsvTalkerId,
                  nmeaBdsTalkerId,
                });
              }}
              disabled={provisioning.busy}
            >
              {provisioning.busy ? 'Aplicando...' : 'Aplicar configuración'}
            </button>
            <button className="ds-remove" onClick={onClose}>
              Cerrar
            </button>
          </div>
          {provisioning.message && <p className="cfg-mini-hint">{provisioning.message}</p>}
          {provisioning.error && <div className="ds-error-block">{provisioning.error}</div>}
        </div>
      </div>
    </div>
  );
}

function NtripProfileModal({
  form,
  isEditing,
  onFormChange,
  onSearchMountpoints,
  mountpointsLoading,
  mountpointsError,
  mountpoints,
  formError,
  onSave,
  onClose,
  onFetchFromServer,
  fetchFromServerBusy,
  fetchFromServerError,
}: {
  form: NtripProfile;
  isEditing: boolean;
  onFormChange: (p: NtripProfile) => void;
  onSearchMountpoints: () => void;
  mountpointsLoading: boolean;
  mountpointsError: string;
  mountpoints: NtripMountpoint[];
  formError: string;
  onSave: () => void;
  onClose: () => void;
  onFetchFromServer: () => void;
  fetchFromServerBusy: boolean;
  fetchFromServerError: string;
}) {
  return (
    <div className="ds-modal-overlay" onClick={onClose}>
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{isEditing ? 'Editar configuracion NTRIP' : 'Nueva configuracion NTRIP'}</h3>
        <label className="ds-label">Nombre</label>
        <input
          placeholder="Ej. Caster EarthScope"
          value={form.name}
          onChange={(e) => onFormChange({ ...form, name: e.target.value })}
        />
        <div className="ds-row">
          <input placeholder="NTRIP address" value={form.host} onChange={(e) => onFormChange({ ...form, host: e.target.value })} />
          <input
            placeholder="Puerto"
            type="number"
            value={form.port}
            onChange={(e) => onFormChange({ ...form, port: Number(e.target.value) })}
          />
        </div>
        <div className="ds-row">
          <input
            placeholder="Mount point"
            value={form.mountpoint}
            onChange={(e) => onFormChange({ ...form, mountpoint: e.target.value })}
          />
          <button onClick={onSearchMountpoints} disabled={!form.host || mountpointsLoading}>
            {mountpointsLoading ? 'Buscando...' : 'Buscar puntos de montura'}
          </button>
        </div>
        {mountpointsError && <div className="ds-error-block">{mountpointsError}</div>}
        {mountpoints.length > 0 && (
          <select value="" onChange={(e) => onFormChange({ ...form, mountpoint: e.target.value })}>
            <option value="" disabled>
              {mountpoints.length} puntos de montura disponibles - elige uno
            </option>
            {mountpoints.map((m) => (
              <option key={m.mountpoint} value={m.mountpoint}>
                {m.mountpoint} - {m.identifier || m.format} ({m.country}){m.nmeaRequired ? ' - pide GGA' : ''}
              </option>
            ))}
          </select>
        )}
        <div className="ds-row">
          <input
            placeholder="Usuario"
            value={form.username}
            onChange={(e) => onFormChange({ ...form, username: e.target.value })}
          />
          <input
            placeholder="Contrasena"
            type="password"
            value={form.password}
            onChange={(e) => onFormChange({ ...form, password: e.target.value })}
          />
        </div>
        <label className="ds-label">Version NTRIP</label>
        <select
          value={form.version}
          onChange={(e) => onFormChange({ ...form, version: e.target.value as NtripProfile['version'] })}
        >
          <option value="v1">V1</option>
          <option value="v2">V2</option>
        </select>
        <p className="ds-hint">V2 es el default (recomendado) - usa V1 solo si el caster lo pide.</p>
        {formError && <div className="ds-error-block">{formError}</div>}
        <div className="ds-actions">
          <button onClick={onSave}>Guardar</button>
          <button onClick={onFetchFromServer} disabled={fetchFromServerBusy}>
            {fetchFromServerBusy ? 'Obteniendo…' : 'Obtener del servidor'}
          </button>
          <button className="ds-remove" onClick={onClose}>
            Cancelar
          </button>
        </div>
        {fetchFromServerError && <div className="ds-error-block">{fetchFromServerError}</div>}
        <p className="cfg-mini-hint">
          Trae host/puerto/usuario/contraseña/mount point de fabrica desde el servidor - requiere
          que el token de telemetria de esta tableta ya funcione (revisa la bitacora de envio).
        </p>
      </div>
    </div>
  );
}

function NtripSection({ status, ntrip }: { status: RtkStatus; ntrip: UCenterNtripProps }) {
  const isEditingProfile = ntrip.form != null && ntrip.profiles.some((p) => p.id === ntrip.form!.id);
  return (
    <section className="uc-config-section">
      <h4 className="uc-config-title">NTRIP Client</h4>
      <p className="ds-hint">Modo de correccion: NTRIP Client.</p>
      <div className="ds-actions">
        <button onClick={ntrip.onCreate}>+ Nueva configuracion NTRIP</button>
        {ntrip.message && <span className="ds-saved">{ntrip.message}</span>}
      </div>
      {ntrip.profiles.length === 0 && <p className="ds-hint">Sin configuraciones NTRIP guardadas todavia.</p>}
      <div className="ds-profile-list">
        {ntrip.profiles.map((p) => {
          const isActive = p.id === ntrip.activeProfileId;
          return (
            <div className={`ds-profile-card${isActive ? ' ds-profile-active' : ''}`} key={p.id}>
              <button className="ds-profile-select" onClick={() => ntrip.onSelect(p.id)}>
                <span className="ds-profile-top">
                  <span className="ds-profile-name">{p.name}</span>
                  {isActive && <span className="ds-profile-badge">Activa</span>}
                </span>
                <span className="ds-profile-summary">
                  {p.host || '(sin servidor)'}:{p.port}
                </span>
                <span className="ds-profile-summary">Mount point: {p.mountpoint || '(sin elegir)'}</span>
              </button>
              <div className="ds-profile-actions">
                <button onClick={() => ntrip.onEdit(p)}>Editar</button>
                <button className="ds-remove" onClick={() => ntrip.onRemove(p.id)}>
                  Eliminar
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {/* pura vista de estado, sin boton - la app ya conecta/desconecta NTRIP sola en cuanto el
          receptor (USB o Bluetooth) aparece/desaparece (ver onReceiverConnected/Disconnected en
          RtkNtripPlugin.kt), mismo criterio que Receptor: con eso ya cubierto, un boton manual de
          Conectar/Detener solo invitaria a un estado inconsistente sin necesidad real */}
      <div className="cfg-status-row">
        <StatusDot on={status.ntripConnected} />
        <span className="cfg-status-text">
          {status.ntripConnected
            ? `Conectado - ${formatRate(status.ntripDataRateBps)} - ${formatTotalBytes(status.ntripTotalBytes)} total`
            : 'Sin conectar - se conecta solo cuando el receptor esta activo'}
        </span>
      </div>
      {status.ntripError && <div className="ds-error-block">{status.ntripError}</div>}

      {ntrip.showModal && ntrip.form && (
        <NtripProfileModal
          form={ntrip.form}
          isEditing={isEditingProfile}
          onFormChange={ntrip.onFormChange}
          onSearchMountpoints={ntrip.onSearchMountpoints}
          mountpointsLoading={ntrip.mountpointsLoading}
          mountpointsError={ntrip.mountpointsError}
          mountpoints={ntrip.mountpoints}
          formError={ntrip.formError}
          onSave={ntrip.onSave}
          onClose={ntrip.onCloseModal}
          onFetchFromServer={ntrip.onFetchFromServer}
          fetchFromServerBusy={ntrip.fetchFromServerBusy}
          fetchFromServerError={ntrip.fetchFromServerError}
        />
      )}
    </section>
  );
}

// -- Vista principal --------------------------------------------------------------------------------

interface UCenterViewProps {
  status: RtkStatus;
  onClose: () => void;
  connection: UCenterConnectionProps;
  ntrip: UCenterNtripProps;
  provisioning: UCenterProvisioningProps;
}

// Réplica de u-center dentro de la app - conexion/correccion (Receptor, NTRIP Client) y las vistas
// de diagnostico (paneles) que en el programa real viven en menus separados (Receiver, Tools >
// NTRIP Client, View > Panels) - aqui, todo consolidado en un solo overlay con scroll/grid, sin
// intentar replicar el manejo de ventanas acopladas de un programa de escritorio (no tiene sentido
// en una tableta). "World Position" NO es el mapa real del Operador (MapView, con tiles reales) -
// es puramente informativo dentro de este menu de diagnostico, para ver donde cae aproximadamente
// cada satelite sobre el globo (ver satelliteSubpoint()), nunca se usa para navegar.
export function UCenterView({ status, onClose, connection, ntrip, provisioning }: UCenterViewProps) {
  const mode = fixModeLabel(status);
  const precision = formatHeaderPrecision(status.lastFix);
  const [showProvisioning, setShowProvisioning] = useState(false);
  return (
    <div className="ds-modal-overlay" onClick={onClose}>
      <div className="cfg-shell" onClick={(e) => e.stopPropagation()}>
        <div className="cfg-header">
          <div>
            <h3>u-center</h3>
            {status.lastFix && (
              <span className="cfg-header-status">
                <span style={{ color: fixBadgeColor(status.lastFix.fixLabel) }}>
                  {fixBadgeLabel(status.lastFix.fixLabel)} · {mode.text}
                </span>
                {precision && <span className="uc-header-precision"> · {precision}</span>}
              </span>
            )}
          </div>
          <div className="uc-header-actions">
            <button className="cfg-close" onClick={() => setShowProvisioning(true)} aria-label="Configuración del receptor" title="Configuración del receptor">
              ⚙
            </button>
            <button className="cfg-close" onClick={onClose} aria-label="Cerrar">
              ×
            </button>
          </div>
        </div>
        {showProvisioning && (
          <ReceiverProvisioningModal provisioning={provisioning} onClose={() => setShowProvisioning(false)} />
        )}
        <div className="cfg-body">
          <div className="uc-config-row">
            <ReceiverSection status={status} connection={connection} />
            <NtripSection status={status} ntrip={ntrip} />
          </div>

          <section className="uc-grid">
            {/* fila 1: Satellite Position (1 col) + World Position (uc-panel-wide, 2 col) = 3.
                fila 2: Satellite Level + Data + Satellite Level History, 1 col cada uno = 3. */}
            <h4 className="cfg-group-title">Satelites</h4>
            <SatellitePositionPanel status={status} />
            <WorldPositionPanel status={status} />
            <SatelliteLevelPanel status={status} />
            <DataPanel status={status} />
            <SatelliteLevelHistoryPanel status={status} />

            <h4 className="cfg-group-title">Instrumentos</h4>
            <CompassPanel status={status} />
            <SpeedMeterPanel status={status} />
            <AltitudeMeterPanel status={status} />
            <WatchPanel status={status} />
          </section>
        </div>
      </div>
    </div>
  );
}
