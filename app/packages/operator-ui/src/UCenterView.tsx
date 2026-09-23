import { useEffect, useMemo, useRef, useState } from 'react';
import type { KioskStatus, NtripMountpoint, RtkFixLabel, RtkStatus, SatelliteInfo } from '@gaga-gps/android-bridge';
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

// C/N0 en dB-Hz: bajo 25 no sirve ni para posicion estable, 35+ es lo minimo para RTK
function snrColor(snr: number | null): string {
  if (snr == null) return '#4b5563';
  if (snr >= 40) return '#22c55e';
  if (snr >= 35) return '#84cc16';
  if (snr >= 25) return '#eab308';
  return '#ef4444';
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
    <div className="uc-panel">
      <h4 className="uc-panel-title">Data</h4>
      <div className="uc-data-grid">
        <div className="uc-data-row">
          <span>Longitude</span>
          <span>{formatCoord(fix?.longitude)}</span>
        </div>
        <div className="uc-data-row">
          <span>Latitude</span>
          <span>{formatCoord(fix?.latitude)}</span>
        </div>
        <div className="uc-data-row">
          <span>Altitude</span>
          <span>{formatMeters(fix?.ellipsoidalAltitudeMeters)}</span>
        </div>
        <div className="uc-data-row">
          <span>Altitude (msl)</span>
          <span>{formatMeters(fix?.altitude)}</span>
        </div>
        <div className="uc-data-row">
          <span>TTFF</span>
          <span>{status.ttffMs != null ? `${(status.ttffMs / 1000).toFixed(1)} s` : '--'}</span>
        </div>
        <div className="uc-data-row">
          <span>Fix Mode</span>
          <span className={mode.danger ? 'uc-value-danger' : undefined}>{mode.text}</span>
        </div>
        <div className="uc-data-row">
          <span>3D Acc. [m]</span>
          <span>{formatMeters(fix?.fullStdMeters, 3)}</span>
        </div>
        <div className="uc-data-row">
          <span>2D Acc. [m]</span>
          <span>{formatMeters(fix?.horizontalStdMeters, 3)}</span>
        </div>
        <div className="uc-data-row">
          <span>PDOP</span>
          <span>{formatDop(status.pdop)}</span>
        </div>
        <div className="uc-data-row">
          <span>HDOP</span>
          <span>{formatDop(status.hdop)}</span>
        </div>
        <div className="uc-data-row">
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
    <div className="uc-panel">
      <h4 className="uc-panel-title">Satellite Level</h4>
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
    <div className="uc-panel">
      <h4 className="uc-panel-title">Satellite Position</h4>
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
              <circle cx={x} cy={y} r={7} fill={snrColor(s.snr)} stroke="#0b0d10" strokeWidth={1} />
              <text x={x} y={y + 3} textAnchor="middle" className="uc-sky-sat-id">
                {s.id}
              </text>
            </g>
          );
        })}
      </svg>
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
    <div className="uc-panel uc-panel-wide">
      <h4 className="uc-panel-title">World Position</h4>
      <svg viewBox={`0 0 ${width} ${height}`} className="uc-world-map">
        {/* graticula cada 30 grados */}
        {[-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150].map((lon) => {
          const x = equirectangular(lon, 0, width, height).x;
          return <line key={`m${lon}`} x1={x} y1={0} x2={x} y2={height} className="uc-world-grid" />;
        })}
        {[-60, -30, 0, 30, 60].map((lat) => {
          const y = equirectangular(0, lat, width, height).y;
          return <line key={`p${lat}`} x1={0} y1={y} x2={width} y2={y} className="uc-world-grid" />;
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
        {receiver && (() => {
          const p = equirectangular(receiver.lon, receiver.lat, width, height);
          return (
            <g>
              <circle cx={p.x} cy={p.y} r={5} className="uc-world-receiver-ring" />
              <circle cx={p.x} cy={p.y} r={2.5} className="uc-world-receiver-dot" />
            </g>
          );
        })()}
        {subpoints.map(({ lat, lon, sat }) => {
          const p = equirectangular(lon, lat, width, height);
          return (
            <circle
              key={`${sat.constellation}-${sat.id}-${sat.signalId}`}
              cx={p.x}
              cy={p.y}
              r={3.5}
              fill={snrColor(sat.snr)}
              opacity={sat.used ? 1 : 0.5}
            >
              <title>{signalLabel(sat)}</title>
            </circle>
          );
        })}
      </svg>
      {!receiver && <p className="ds-hint">Sin posicion propia todavia - necesaria para ubicar los satelites en el mapa.</p>}
      <p className="ds-hint">
        Punto grande = posicion del receptor. Puntos chicos = subpunto aproximado de cada satelite (proyeccion
        vertical sobre la superficie, no la posicion orbital real) - altitud tipica por constelacion, informativo.
      </p>
    </div>
  );
}

// -- Panel: Satellite Level History (sparkline por satelite) ---------------------------------------

const HISTORY_LENGTH = 30;

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
  const w = 64;
  const h = 22;
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

function SatelliteLevelHistoryPanel({ status }: { status: RtkStatus }) {
  const history = useSatelliteHistory(status.satellites);
  const groups = useMemo(() => groupByConstellation(status.satellites), [status.satellites]);

  return (
    <div className="uc-panel">
      <h4 className="uc-panel-title">Satellite Level History</h4>
      {groups.length === 0 ? (
        <p className="ds-hint">Sin historial todavia.</p>
      ) : (
        groups.map(([constellation, sats]) => (
          <div className="ds-sat-group" key={constellation}>
            <div className="ds-sat-group-title">{constellation}</div>
            <div className="uc-history-rows">
              {sats.map((s) => {
                const key = `${s.constellation}-${s.id}-${s.signalId}`;
                return (
                  <div className="uc-history-row" key={key}>
                    <span className="uc-history-id">{s.id}</span>
                    <Sparkline values={history.get(key) ?? []} />
                    <span className="uc-history-snr">{s.snr ?? '--'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))
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
    <div className="uc-panel">
      <h4 className="uc-panel-title">Compass</h4>
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
    <div className="uc-panel">
      <h4 className="uc-panel-title">Speed Meter</h4>
      <ArcGauge value={kmh} max={250} labels={[0, 50, 100, 150, 200, 250]} />
      <p className="ds-hint">{kmh != null ? `${kmh.toFixed(1)} km/h` : 'Sin dato de velocidad'}</p>
    </div>
  );
}

function AltitudeMeterPanel({ status }: { status: RtkStatus }) {
  const alt = status.lastFix?.ellipsoidalAltitudeMeters ?? status.lastFix?.altitude ?? null;
  return (
    <div className="uc-panel">
      <h4 className="uc-panel-title">Altitude Meter</h4>
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
    <div className="uc-panel">
      <h4 className="uc-panel-title">Watch</h4>
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
  onToggleBluetooth: (address: string) => void;
  usbDevices: { deviceId: number; name: string | null }[];
  selectedUsbDeviceId: number | null;
  onSelectUsbDevice: (id: number) => void;
  baudRate: number;
  onUpdateBaudRate: (value: number) => void;
  onToggleUsb: () => void;
}

function ReceiverSection({ status, connection }: { status: RtkStatus; connection: UCenterConnectionProps }) {
  return (
    <section className="uc-config-section">
      <h4 className="uc-config-title">Receptor</h4>

      {!status.mockLocationAllowed && (
        <div className="ds-hint" style={{ border: '1px solid #d29922', borderRadius: 6, padding: 10 }}>
          <p>
            <strong>Pendiente:</strong> esta tableta todavia no esta configurada como app de
            ubicacion simulada - necesario para que el receptor RTK reemplace el GPS interno.
          </p>
          {!connection.kioskStatus.developerOptionsEnabled && (
            <p>
              1. Activa Opciones de desarrollador: Ajustes de Android {'>'} Acerca de la tableta
              {' > '}toca 7 veces "Numero de compilacion".
            </p>
          )}
          <p>
            {connection.kioskStatus.developerOptionsEnabled ? '' : '2. '}En Opciones de desarrollador, en
            "Seleccionar app de ubicacion falsa", elige <strong>GAGA Operador</strong>.
          </p>
          <div className="ds-actions">
            <button onClick={connection.onOpenDeveloperOptions}>Abrir Ajustes de Android</button>
            <button onClick={connection.onRetryMockLocation} disabled={connection.mockLocationBusy}>
              {connection.mockLocationBusy ? 'Verificando…' : 'Ya lo hice, verificar'}
            </button>
          </div>
        </div>
      )}

      <h5 className="uc-config-subtitle">Bluetooth</h5>
      <div className="ds-actions">
        <span className="ds-status">
          {status.bluetoothConnected
            ? `Conectado - ${status.connectedBluetoothName ?? 'Bluetooth'} - ${formatRate(status.bluetoothDataRateBps)} - ${formatTotalBytes(status.bluetoothTotalBytes)} total`
            : 'Sin conectar'}
        </span>
      </div>
      {!status.bluetoothPermissionGranted && (
        <div className="ds-actions">
          <button onClick={connection.onGrantBluetoothPermission}>Permitir Bluetooth</button>
        </div>
      )}
      {status.bluetoothPermissionGranted && !status.bluetoothEnabled && (
        <p className="ds-hint">El Bluetooth de la tableta esta apagado. Enciendelo en Ajustes de Android.</p>
      )}
      {connection.btDevices.map((d) => {
        const isSelected = status.bluetoothConnected && status.connectedBluetoothAddress === d.address;
        return (
          <label className="ds-usb-option" key={d.address}>
            <input
              type="radio"
              name="uc-btDevice"
              checked={isSelected}
              onChange={() => connection.onToggleBluetooth(d.address)}
            />
            {d.name ?? d.address}
          </label>
        );
      })}
      {connection.btDevices.length === 0 && status.bluetoothPermissionGranted && (
        <p className="ds-hint">
          Ningun modulo vinculado todavia. Vincula el HC-05 desde Ajustes de Android (codigo 1234) y aparecera solo aqui.
        </p>
      )}
      <p className="ds-hint">
        Se conecta solo al modulo vinculado y reintenta si se cae el enlace. El baud rate no se configura aqui: vive entre el HC-05 y el receptor.
      </p>

      <h5 className="uc-config-subtitle">USB</h5>
      <div className="ds-actions">
        <span className="ds-status">
          {status.usbConnected
            ? `Conectado - ${status.connectedUsbDeviceName ?? 'USB'} - ${formatRate(status.usbDataRateBps)} - ${formatTotalBytes(status.usbTotalBytes)} total`
            : 'Sin conectar'}
        </span>
      </div>
      {connection.usbDevices.map((d) => {
        // "seleccionado" no depende solo del clic manual - el receptor se auto-conecta solo al
        // enchufarlo, asi que tambien cuenta como seleccionada la fila que coincide con el
        // dispositivo YA conectado
        const isSelected =
          connection.selectedUsbDeviceId === d.deviceId ||
          (status.usbConnected && status.connectedUsbDeviceId === d.deviceId);
        return (
          <label className="ds-usb-option" key={d.deviceId}>
            <input
              type="radio"
              name="uc-usbDevice"
              checked={isSelected}
              onChange={() => connection.onSelectUsbDevice(d.deviceId)}
            />
            {d.name ?? `USB ${d.deviceId}`}
          </label>
        );
      })}
      {connection.usbDevices.length === 0 && <p className="ds-hint">Ningun dispositivo USB detectado todavia.</p>}
      <label className="ds-label">Baud rate</label>
      <input
        type="number"
        value={connection.baudRate}
        onChange={(e) => connection.onUpdateBaudRate(Number(e.target.value))}
      />
      <div className="ds-actions">
        <button onClick={connection.onToggleUsb} disabled={!status.usbConnected && connection.selectedUsbDeviceId == null}>
          {status.usbConnected ? 'Desconectar' : 'Conectar'}
        </button>
      </div>
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
  onToggleConnect: () => void;
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
          <button className="ds-remove" onClick={onClose}>
            Cancelar
          </button>
        </div>
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
      <div className="ds-actions">
        <button onClick={ntrip.onToggleConnect} disabled={!ntrip.activeProfile}>
          {status.ntripConnected ? 'Detener NTRIP' : 'Conectar NTRIP'}
        </button>
        <span className="ds-status">
          {status.ntripConnected
            ? `Conectado - ${formatRate(status.ntripDataRateBps)} - ${formatTotalBytes(status.ntripTotalBytes)} total`
            : 'Sin conectar'}
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
}

// Réplica de u-center dentro de la app - conexion/correccion (Receptor, NTRIP Client) y las vistas
// de diagnostico (paneles) que en el programa real viven en menus separados (Receiver, Tools >
// NTRIP Client, View > Panels) - aqui, todo consolidado en un solo overlay con scroll/grid, sin
// intentar replicar el manejo de ventanas acopladas de un programa de escritorio (no tiene sentido
// en una tableta). "World Position" NO es el mapa real del Operador (MapView, con tiles reales) -
// es puramente informativo dentro de este menu de diagnostico, para ver donde cae aproximadamente
// cada satelite sobre el globo (ver satelliteSubpoint()), nunca se usa para navegar.
export function UCenterView({ status, onClose, connection, ntrip }: UCenterViewProps) {
  const mode = fixModeLabel(status);
  return (
    <div className="ds-modal-overlay" onClick={onClose}>
      <div className="uc-shell" onClick={(e) => e.stopPropagation()}>
        <div className="uc-header">
          <div>
            <h3>u-center</h3>
            {status.lastFix && (
              <span className="uc-header-status" style={{ color: fixBadgeColor(status.lastFix.fixLabel) }}>
                {fixBadgeLabel(status.lastFix.fixLabel)} · {mode.text}
              </span>
            )}
          </div>
          <button className="uc-close" onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </div>
        <div className="uc-body">
          <div className="uc-config-row">
            <ReceiverSection status={status} connection={connection} />
            <NtripSection status={status} ntrip={ntrip} />
          </div>

          <section className="uc-panels-main">
            <h4 className="uc-group-title">Satelites</h4>
            <SatellitePositionPanel status={status} />
            <SatelliteLevelPanel status={status} />
            <SatelliteLevelHistoryPanel status={status} />

            <h4 className="uc-group-title">Posicion</h4>
            <WorldPositionPanel status={status} />
            <DataPanel status={status} />

            <h4 className="uc-group-title">Instrumentos</h4>
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
