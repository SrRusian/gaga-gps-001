import { Modal } from '@gaga-gps/ui';
import { AlertsPanel } from '../../../../monitor/components/AlertsPanel';
import type { AlertEntry } from '../../../../hooks/useAlertsFeed';

export interface AlertsModalProps {
  open: boolean;
  onClose: () => void;
  alerts: AlertEntry[];
  alertCount: number;
}

// mismo componente compartido que ya usan Supervisor/Encargado (panels/shared/monitor) - Admin
// (global) lo ve dentro de un Modal en vez de una columna fija, ya que su layout ya usa modales
// para cada seccion (Dispositivos/Usuarios/Geocercas/etc). canAccessHistory=true: Admin tiene
// visibilidad completa, mismo criterio que Encargado de Proyecto.
export function AlertsModal({ open, onClose, alerts, alertCount }: AlertsModalProps) {
  return (
    <Modal size="large" open={open} title="Alertas" onClose={onClose}>
      <div className="sup-tokens">
        <AlertsPanel alerts={alerts} alertCount={alertCount} canAccessHistory />
      </div>
    </Modal>
  );
}
