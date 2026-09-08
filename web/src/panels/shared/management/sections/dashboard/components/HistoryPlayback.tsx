import type { HistoryPoint } from '../../../types';
import { formatHistoryDateTime } from '../useHistoryMode';

export interface HistoryPlaybackProps {
  historyMode: boolean;
  historyPoints: HistoryPoint[];
  historySliderIndex: number;
  setHistorySliderIndex: (i: number) => void;
  historyPlaying: boolean;
  onTogglePlayback: () => void;
  showHistoryPanel: boolean;
  setShowHistoryPanel: (v: (prev: boolean) => boolean) => void;
}

export function HistoryPlayback({
  historyMode,
  historyPoints,
  historySliderIndex,
  setHistorySliderIndex,
  historyPlaying,
  onTogglePlayback,
  showHistoryPanel,
  setShowHistoryPanel,
}: HistoryPlaybackProps) {
  if (!historyMode) return null;
  const hasPoints = historyPoints.length > 0;

  return (
    <>
      {hasPoints && (
        <div className="dash-history-playback dash-glass">
          <button className="btn btn-sm" onClick={onTogglePlayback}>
            {historyPlaying ? 'Pausar' : 'Reproducir'}
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(0, historyPoints.length - 1)}
            value={historySliderIndex}
            onChange={(e) => setHistorySliderIndex(parseInt(e.target.value, 10))}
          />
          <span className="dash-history-playback-readout">
            {historyPoints[historySliderIndex]
              ? `${new Date(historyPoints[historySliderIndex].fix_time).toLocaleString()} · ${(historyPoints[historySliderIndex].speed * 3.6).toFixed(1)} km/h`
              : ''}
          </span>
        </div>
      )}

      {hasPoints && (
        <button
          className={`dash-history-toggle${showHistoryPanel ? ' dash-history-toggle--open' : ' dash-history-toggle--closed'}`}
          onClick={() => setShowHistoryPanel((v) => !v)}
          title={showHistoryPanel ? 'Ocultar detalle' : 'Mostrar detalle'}
          aria-label={showHistoryPanel ? 'Ocultar detalle' : 'Mostrar detalle'}
        >
          {showHistoryPanel ? '>' : '<'}
        </button>
      )}

      <div className={`dash-history-detail dash-glass${showHistoryPanel && hasPoints ? ' visible' : ''}`}>
        <div className="dash-history-detail-header">
          <h4>Detalle del recorrido</h4>
          <span className="dash-hint">
            {historyPoints.length
              ? `${historyPoints.filter((p) => p.zones.length > 0).length}/${historyPoints.length} puntos dentro de zona autorizada`
              : 'Sin datos en el rango seleccionado'}
          </span>
        </div>
        <div className="dash-history-detail-body">
          <table>
            <colgroup>
              <col style={{ width: '13%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '20%' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Lat</th>
                <th>Lon</th>
                <th>Vel. (km/h)</th>
                <th>Rumbo</th>
                <th>Altitud (m)</th>
                <th>Precisión (m)</th>
                <th>Batería</th>
                <th>Zona</th>
              </tr>
            </thead>
            <tbody>
              {historyPoints.map((p, i) => (
                <tr
                  key={i}
                  className={`org-row${i === historySliderIndex ? ' selected' : ''}`}
                  onClick={() => setHistorySliderIndex(i)}
                >
                  <td>{formatHistoryDateTime(p.fix_time)}</td>
                  <td>{p.latitude.toFixed(6)}</td>
                  <td>{p.longitude.toFixed(6)}</td>
                  <td>{(p.speed * 3.6).toFixed(1)}</td>
                  <td>{Math.round(p.course)}°</td>
                  <td>{Math.round(p.altitude)}</td>
                  <td>{Math.round(p.accuracy)}</td>
                  <td>{p.battery != null ? `${Math.round(p.battery)}%` : '-'}</td>
                  <td
                    className={p.zones.length ? 'zone-in' : 'zone-out'}
                    title={p.zones.length ? p.zones.map((z) => z.name).join(', ') : 'Fuera de zona'}
                  >
                    {p.zones.length ? p.zones.map((z) => z.name).join(', ') : 'Fuera de zona'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
