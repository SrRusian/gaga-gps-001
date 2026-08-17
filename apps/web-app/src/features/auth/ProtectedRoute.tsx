import { getStoredToken, getStoredUser } from '@gaga-gps/client';
import type { ReactElement } from 'react';
import { Navigate } from 'react-router-dom';

export interface ProtectedRouteProps {
  /** Uno o varios roles permitidos - los roles de proyecto reutilizan el mismo panel que Admin/Supervisor con menos alcance. */
  role: string | string[];
  children: ReactElement;
}

/**
 * Única puerta de entrada a las vistas de cada rol - sin esto, cada
 * feature tendría que repetir su propio chequeo de sesión (como
 * pasaba antes, con 3 apps separadas). Si no hay token, no hay
 * usuario guardado, o el rol no está en la lista permitida de esta
 * ruta, redirige al login sin descargar ni montar el componente
 * protegido (React.lazy + Suspense en App.tsx se encargan de eso).
 */
export function ProtectedRoute({ role, children }: ProtectedRouteProps) {
  const token = getStoredToken();
  const user = getStoredUser();
  const allowedRoles = Array.isArray(role) ? role : [role];

  if (!token || !user || !allowedRoles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return children;
}
