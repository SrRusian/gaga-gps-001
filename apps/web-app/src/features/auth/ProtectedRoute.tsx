import { getStoredToken, getStoredUser } from '@gaga-gps/client';
import type { ReactElement } from 'react';
import { Navigate } from 'react-router-dom';

export interface ProtectedRouteProps {
  role: string | string[];
  children: ReactElement;
}

export function ProtectedRoute({ role, children }: ProtectedRouteProps) {
  const token = getStoredToken();
  const user = getStoredUser();
  const allowedRoles = Array.isArray(role) ? role : [role];

  if (!token || !user || !allowedRoles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return children;
}
