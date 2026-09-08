import { getStoredToken, getStoredUser } from '@gaga-gps/client';
import { Capacitor } from '@capacitor/core';
import type { ReactElement } from 'react';
import { Navigate } from 'react-router-dom';

export interface ProtectedRouteProps {
  role: string | string[];
  children: ReactElement;
  // Operador es exclusivo de la app instalada - esto cierra el hueco de una sesion ya guardada
  // en localStorage (ej. copiada a mano) que intente entrar directo a /operator en un navegador
  nativeOnly?: boolean;
}

export function ProtectedRoute({ role, children, nativeOnly }: ProtectedRouteProps) {
  const token = getStoredToken();
  const user = getStoredUser();
  const allowedRoles = Array.isArray(role) ? role : [role];

  if (!token || !user || !allowedRoles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  if (nativeOnly && !Capacitor.isNativePlatform()) {
    return <Navigate to="/" replace />;
  }

  return children;
}
