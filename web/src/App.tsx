import { getStoredToken, getStoredUser, resolveRolePath } from '@gaga-gps/client';
import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { LoginScreen } from './features/auth/LoginScreen';
import './features/auth/auth.css';
import { ProtectedRoute } from './features/auth/ProtectedRoute';

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
                <AdminApp />
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
