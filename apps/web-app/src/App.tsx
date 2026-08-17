import { getStoredToken, getStoredUser, resolveRolePath } from '@gaga-gps/client';
import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { LoginScreen } from './features/auth/LoginScreen';
import './features/auth/auth.css';
import { ProtectedRoute } from './features/auth/ProtectedRoute';

// Code-splitting por rol - React.lazy() + import() dinámico hacen
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
  if (token && user) return <Navigate to={`/${resolveRolePath(user.role)}`} replace />;
  return <LoginScreen />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Home />} />
          {/* Admin y Encargado de Proyecto montan literalmente el mismo
              componente (`AdminApp`, que a su vez usa `DashboardSection`
              con menos alcance según el rol) - dos rutas separadas es
              solo para que la URL refleje con qué rol se entró, nunca
              una copia del código. Cualquier cambio a `AdminApp` aplica
              a ambas por igual. La restricción real de acceso es
              `ProtectedRoute` + la validación del backend en cada
              request, no el nombre de la ruta - si alguien entra a la
              URL del rol equivocado, `ProtectedRoute` lo rebota a "/"
              y `Home` lo manda de vuelta a SU ruta correcta. */}
          <Route
            path="/admin/*"
            element={
              <ProtectedRoute role="admin">
                <AdminApp />
              </ProtectedRoute>
            }
          />
          <Route
            path="/encargado/*"
            element={
              <ProtectedRoute role="project_manager">
                <AdminApp />
              </ProtectedRoute>
            }
          />
          <Route
            path="/supervisor"
            element={
              <ProtectedRoute role={['supervisor', 'project_supervisor']}>
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
