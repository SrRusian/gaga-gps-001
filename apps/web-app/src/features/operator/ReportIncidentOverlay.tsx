import { useState } from 'react';
import type { IncidentCategory } from '@gaga-gps/shared-types';

const CATEGORIES: { value: IncidentCategory; label: string }[] = [
  { value: 'obstacle', label: 'Objeto en el camino' },
  { value: 'accident', label: 'Accidente' },
  { value: 'traffic', label: 'Tráfico / bloqueo' },
  { value: 'other', label: 'Otro peligro' },
];

export interface ReportIncidentOverlayProps {
  onSubmit: (category: IncidentCategory, message: string) => void;
  onClose: () => void;
  error: string;
  submitting: boolean;
}

// Estilo Waze/Uber - reporta un peligro desde la posición actual del
// operador; se marca en el mapa de los demás vehículos del mismo
// proyecto y alerta a quien se acerque (IncidentAlertService).
export function ReportIncidentOverlay({
  onSubmit,
  onClose,
  error,
  submitting,
}: ReportIncidentOverlayProps) {
  const [category, setCategory] = useState<IncidentCategory>('obstacle');
  const [message, setMessage] = useState('');

  return (
    <div className="op-full-overlay active">
      <div className="op-overlay-card">
        <button className="op-overlay-close" onClick={onClose} aria-label="Cerrar" title="Cerrar">
          X
        </button>
        <h2>Reportar peligro</h2>
        <p>
          Se marcará un punto en tu posición actual, visible en el mapa de los demás vehículos del
          proyecto.
        </p>
        <select value={category} onChange={(e) => setCategory(e.target.value as IncidentCategory)}>
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          placeholder="Detalle opcional"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button onClick={() => onSubmit(category, message)} disabled={submitting}>
          {submitting ? 'Enviando…' : 'Reportar'}
        </button>
        <div className="op-overlay-error">{error}</div>
      </div>
    </div>
  );
}
