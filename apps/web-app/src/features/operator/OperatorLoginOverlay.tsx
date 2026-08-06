import { getStoredUser } from '@gaga-gps/client';

export interface OperatorLoginOverlayProps {
  onStartShift: () => void;
  error: string;
}

/**
 * Ya no pide credenciales — el login único (gateway) ya identificó
 * a la persona antes de llegar aquí. Este paso solo declara
 * explícitamente "empiezo a operar este vehículo ahora", que es lo
 * que abre el turno en operator_sessions.
 */
export function OperatorLoginOverlay({ onStartShift, error }: OperatorLoginOverlayProps) {
  const user = getStoredUser();

  return (
    <div className="op-full-overlay active">
      <div className="op-overlay-card">
        <h2>👤 Iniciar turno</h2>
        <p>{user ? `Hola, ${user.name}. ` : ''}Confirma para empezar tu turno en este vehículo.</p>
        <button onClick={onStartShift}>Iniciar turno</button>
        <div className="op-overlay-error">{error}</div>
      </div>
    </div>
  );
}
