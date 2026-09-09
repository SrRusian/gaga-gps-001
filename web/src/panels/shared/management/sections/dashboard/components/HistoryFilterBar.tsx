import type { DeviceRow } from '../../../types';

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
}: HistoryFilterBarProps) {
  return (
    <div className="dash-history-filter-bar dash-glass">
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
      <button className="btn btn-sm" onClick={onSearch}>
        Buscar
      </button>
      <button className="btn btn-sm" onClick={onExportCsv} disabled={csvExporting}>
        {csvExporting ? 'Descargando…' : 'Descargar CSV'}
      </button>
    </div>
  );
}
