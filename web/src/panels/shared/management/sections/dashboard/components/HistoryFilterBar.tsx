import type { DeviceRow } from '../../../types';
import type { HistoryLoadProgress } from '../useHistoryMode';

export interface HistoryFilterBarProps {
  scopedDevices: DeviceRow[];
  historyDeviceId: string;
  setHistoryDeviceId: (v: string) => void;
  historyFrom: string;
  setHistoryFrom: (v: string) => void;
  historyTo: string;
  setHistoryTo: (v: string) => void;
  onSearch: () => void;
  onExportCsv: () => void;
  csvExporting: boolean;
  loadProgress: HistoryLoadProgress | null;
}

export function HistoryFilterBar({
  scopedDevices,
  historyDeviceId,
  setHistoryDeviceId,
  historyFrom,
  setHistoryFrom,
  historyTo,
  setHistoryTo,
  onSearch,
  onExportCsv,
  csvExporting,
  loadProgress,
}: HistoryFilterBarProps) {
  const loading = loadProgress !== null;
  const percent = loading && loadProgress.total > 0 ? Math.min(100, Math.round((loadProgress.loaded / loadProgress.total) * 100)) : 0;

  return (
    <div className="dash-history-filter-bar dash-glass">
      <div className="dash-history-filter-row">
        <div className="dash-history-filter-field">
          <span className="dash-field-label">Dispositivo</span>
          <select value={historyDeviceId} onChange={(e) => setHistoryDeviceId(e.target.value)}>
            <option value="">Selecciona un dispositivo…</option>
            {scopedDevices.map((d) => (
              <option key={d.unique_id} value={d.unique_id}>
                {d.name} ({d.unique_id})
              </option>
            ))}
          </select>
        </div>
        <div className="dash-history-filter-field">
          <span className="dash-field-label">Desde</span>
          <input type="datetime-local" value={historyFrom} onChange={(e) => setHistoryFrom(e.target.value)} />
        </div>
        <div className="dash-history-filter-field">
          <span className="dash-field-label">Hasta</span>
          <input type="datetime-local" value={historyTo} onChange={(e) => setHistoryTo(e.target.value)} />
        </div>
        <button className="btn btn-sm" onClick={onSearch} disabled={loading}>
          {loading ? 'Cargando…' : 'Buscar'}
        </button>
        <button className="btn btn-sm" onClick={onExportCsv} disabled={csvExporting || loading}>
          {csvExporting ? 'Descargando…' : 'Descargar CSV'}
        </button>
      </div>
      {/* progreso REAL (paginas ya traidas del servidor), no un spinner indeterminado - pedido
          explicito: "sin límite... que muestre una barra de carga progresiva interactiva real" */}
      {loading && (
        <div className="dash-history-progress" title={`${loadProgress.loaded} de ${loadProgress.total} puntos`}>
          <div className="dash-history-progress-track">
            <div className="dash-history-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <span className="dash-history-progress-label">
            Cargando historial - {loadProgress.loaded.toLocaleString('es-MX')} de{' '}
            {loadProgress.total.toLocaleString('es-MX')} puntos ({percent}%)
          </span>
        </div>
      )}
    </div>
  );
}
