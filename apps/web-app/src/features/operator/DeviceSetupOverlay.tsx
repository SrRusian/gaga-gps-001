import { useState } from 'react';

export interface DeviceSetupOverlayProps {
  onSave: (value: string) => void;
  onClose?: () => void;
  error: string;
  verifying: boolean;
}

export function DeviceSetupOverlay({ onSave, onClose, error, verifying }: DeviceSetupOverlayProps) {
  const [value, setValue] = useState('');

  return (
    <div className="op-full-overlay active">
      <div className="op-overlay-card">
        {onClose && (
          <button className="op-overlay-close" onClick={onClose} aria-label="Cerrar" title="Cerrar">
            ✕
          </button>
        )}
        <h2>Configuración de dispositivo</h2>
        <p>
          Esta tableta aún no tiene un identificador de vehículo asignado. Ingresa el mismo "Device
          Identifier" configurado en Traccar Client para esta máquina. Esto solo se hace una vez, al
          instalar la tableta.
        </p>
        <input
          placeholder="Ej. CAMION-01"
          autoCapitalize="characters"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button onClick={() => onSave(value)} disabled={verifying}>
          {verifying ? 'Verificando...' : 'Guardar'}
        </button>
        <div className="op-overlay-error">{error}</div>
      </div>
    </div>
  );
}
