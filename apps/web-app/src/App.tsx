import { getStoredToken, getStoredUser } from '@gaga-gps/client';
import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { LoginScreen } from './features/auth/LoginScreen';
import './features/auth/auth.css';
import { ProtectedRoute } from './features/auth/ProtectedRoute';

// Code-splitting por rol — React.lazy() + import() dinámico hacen
// que Vite genere un chunk JS (y su CSS) separado por feature. Un
// operador que entra desde su tableta solo descarga el chunk de
// /operator; el código de Admin (tablas, mapbox-gl-draw, etc.) ni
// siquiera se pide al servidor a menos que ese usuario sea admin.
const AdminApp = lazy(() => import('./features/admin/AdminApp'));
const SupervisorApp = lazy(() => import('./features/supervisor/SupervisorApp'));
const OperatorApp = lazy(() => import('./features/operator/OperatorApp'));

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

/** Raíz del sitio: si ya hay sesión, directo a su panel; si no, login. */
function Home() {
  const token = getStoredToken();
  const user = getStoredUser();
  if (token && user) return <Navigate to={`/${user.role}`} replace />;
  return <LoginScreen />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route
            path="/admin/*"
            element={
              <ProtectedRoute role="admin">
                <AdminApp />
              </ProtectedRoute>
            }
          />
          <Route
            path="/supervisor"
            element={
              <ProtectedRoute role="supervisor">
                <SupervisorApp />
              </ProtectedRoute>
            }
          />
          <Route
            path="/operator"
            element={
              <ProtectedRoute role="operator">
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
