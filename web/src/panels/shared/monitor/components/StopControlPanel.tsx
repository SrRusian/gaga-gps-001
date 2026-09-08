import { Button } from '@gaga-gps/ui';

export interface StopStatus {
  active: boolean;
  reason?: string | null;
}

export interface StopControlPanelProps {
  stopStatus: StopStatus;
  onActivate: () => Promise<void>;
  onDeactivate: () => Promise<void>;
}

// Parada preventiva colectiva - exclusiva de project_supervisor, panels/supervisor/index.tsx es el
// unico que renderiza esto (project-manager es 100% solo lectura)
export function StopControlPanel({ stopStatus, onActivate, onDeactivate }: StopControlPanelProps) {
  async function handleActivate() {
    if (
      !confirm(
        '¿Confirma la activación de la PARADA PREVENTIVA COLECTIVA?\nTodos los vehículos recibirán la orden de detenerse.',
      )
    )
      return;
    await onActivate();
  }

  async function handleDeactivate() {
    if (
      !confirm(
        '¿Confirma la reanudación de operaciones?\nAsegúrese de que la situación de emergencia ha sido resuelta.',
      )
    )
      return;
    await onDeactivate();
  }

  return (
    <div className="sup-stop-section sup-glass">
      {!stopStatus.active ? (
        <Button variant="danger" className="sup-stop-btn" onClick={handleActivate}>
          Parada preventiva colectiva
        </Button>
      ) : (
        <Button variant="primary" className="sup-stop-btn" onClick={handleDeactivate}>
          Reanudar operación
        </Button>
      )}
      <div className={`sup-stop-status${stopStatus.active ? ' active' : ''}`}>
        {stopStatus.active
          ? `Activa${stopStatus.reason ? ` - ${stopStatus.reason}` : ''}`
          : 'Sistema en operación normal'}
      </div>
    </div>
  );
}
