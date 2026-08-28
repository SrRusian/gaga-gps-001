import { getStoredUser } from '@gaga-gps/client';

export interface OperatorLoginOverlayProps {
  onStartShift: () => void;
  error: string;
}

export function OperatorLoginOverlay({ onStartShift, error }: OperatorLoginOverlayProps) {
  const user = getStoredUser();

  return (
    <div className="op-full-overlay active">
      <div className="op-overlay-card">
        <h2>Iniciar turno</h2>
        <p>{user ? `Hola, ${user.name}. ` : ''}Confirma para empezar tu turno en este vehículo.</p>
        <button onClick={onStartShift}>Iniciar turno</button>
        <div className="op-overlay-error">{error}</div>
      </div>
    </div>
  );
}
