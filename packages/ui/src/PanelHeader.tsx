import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { ConnectionStatusDot } from './ConnectionStatusDot';

export interface PanelHeaderProps {
  connected: boolean;
  userName: string;
  /** Ya resuelto a texto legible (ver `roleLabel` en `@gaga-gps/client`) - este componente no conoce mapeos de rol, solo lo muestra. */
  userRoleLabel: string;
  onLogout: () => void;
  /** Contenido extra entre el título "GAGA GPS" y el status - ej. el nav Dashboard/Reportes/Sistema de Admin/Encargado. Supervisor no pasa nada (es una sola vista, sin secciones a las que navegar). */
  children?: ReactNode;
}

/**
 * Header flotante completo - título "GAGA GPS" + slot opcional (nav)
 * + reloj/conexión/usuario/Salir - compartido de verdad por todos los
 * paneles que usan esta identidad visual (Admin/Encargado,
 * Supervisor). Antes cada panel tenía su propia copia casi idéntica
 * de este marcado con clases `.ad-*`/`.sup-*` distintas - un cambio
 * futuro (ej. agregar notificaciones) ahora se hace en un solo lugar.
 *
 * Operador NO lo usa - su header tiene contenido y propósito
 * distintos (nombre de equipo, estado de GPS local, Finalizar turno),
 * decisión explícita, no un olvido - traerlo a este mismo shell sería
 * un rediseño aparte de ese panel, no algo que se desprenda de este.
 */
export function PanelHeader({ connected, userName, userRoleLabel, onLogout, children }: PanelHeaderProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="gg-panel-header">
      <div className="gg-panel-header-left">
        <h1>GAGA GPS</h1>
        {children}
      </div>
      <div className="gg-panel-header-status">
        <span className="gg-panel-header-clock">{now.toLocaleTimeString('es-MX')}</span>
        <div className="gg-panel-header-connection">
          <ConnectionStatusDot connected={connected} />
          <span>{connected ? 'Conectado' : 'Desconectado'}</span>
        </div>
        <span className="gg-panel-header-user">
          {userName} <span className="gg-panel-header-role">({userRoleLabel})</span>
        </span>
        <button className="gg-panel-header-logout" onClick={onLogout}>
          Salir
        </button>
      </div>
    </header>
  );
}
