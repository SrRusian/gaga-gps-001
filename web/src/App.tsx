import { clearSession, getStoredToken, getStoredUser, resolveRolePath } from '@gaga-gps/client';
import { Capacitor } from '@capacitor/core';
import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { LoginScreen } from './panels/auth/LoginScreen';
import './panels/auth/auth.css';
import { ProtectedRoute } from './panels/auth/ProtectedRoute';

const AdminApp = lazy(() => import('./panels/admin'));
const ProjectAdministratorApp = lazy(() => import('./panels/project-administrator'));
const SupervisorApp = lazy(() => import('./panels/supervisor'));
const ProjectManagerApp = lazy(() => import('./panels/project-manager'));
// Operador es exclusivo de la app instalada - el codigo fuente vive en app/packages/operator-ui,
// no en web/. Este import por nombre (no por ruta relativa) es el mismo patron ya usado con
// @gaga-gps/android-bridge: web/ sigue siendo quien compila el bundle unico, pero el codigo le
// pertenece a app/. Import de subruta especifica (no el paquete a secas) a proposito - si
// comparte un index.ts barrel con DeviceSettingsPanel (import eager de LoginScreen), Vite
// precarga el codigo de Operador para cualquier visitante sin importar su rol.
const OperatorApp = lazy(() => import('@gaga-gps/operator-ui/OperatorApp'));

function LoadingScreen() {
  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0d1117',
        color: '#8b949e',
        fontFamily: 'Arial, sans-serif',
      }}
    >
      Cargando…
    </div>
  );
}

function Home() {
  const token = getStoredToken();
  const user = getStoredUser();

  // sesion de Operador guardada (ej. localStorage copiado a mano) pero fuera de la app - sin este
  // corte, redirigir a /operator y que ProtectedRoute la rebote de vuelta aqui crea un loop infinito
  if (token && user && user.role === 'operator' && !Capacitor.isNativePlatform()) {
    clearSession();
    return <LoginScreen />;
  }

  if (token && user) return <Navigate to={`/${resolveRolePath(user.role)}`} replace />;
  return <LoginScreen />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Home />} />
          {}
          <Route
            path="/administrator/*"
            element={
              <ProtectedRoute role="admin">
                <AdminApp />
              </ProtectedRoute>
            }
          />
          <Route
            path="/project-admin/*"
            element={
              <ProtectedRoute role="project_administrator">
                <ProjectAdministratorApp />
              </ProtectedRoute>
            }
          />
          <Route
            path="/supervisor"
            element={
              <ProtectedRoute role="project_supervisor">
                <SupervisorApp />
              </ProtectedRoute>
            }
          />
          <Route
            path="/manager"
            element={
              <ProtectedRoute role="project_manager">
                <ProjectManagerApp />
              </ProtectedRoute>
            }
          />
          <Route
            path="/operator"
            element={
              <ProtectedRoute role="operator" nativeOnly>
                <OperatorApp />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
