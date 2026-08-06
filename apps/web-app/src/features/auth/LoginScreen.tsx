import { ApiError, createApiClient, saveSession } from '@gaga-gps/client';
import { Button } from '@gaga-gps/ui';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const api = createApiClient();

interface LoginResponse {
  token: string;
  user: { id: number; email: string; name: string; role: string };
}

/**
 * Login único para todos los roles — reemplaza lo que antes era la
 * app separada web-gateway. Al loguearse exitosamente navega a
 * /${role} sin recargar la página (SPA real, no window.location).
 */
export function LoginScreen() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    setError('');
    setLoading(true);
    try {
      const data = await api.post<LoginResponse>('/api/auth/login', { email, password });
      saveSession(data.token, data.user);
      navigate(`/${data.user.role}`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error de inicio de sesión');
      setLoading(false);
    }
  }

  return (
    <div className="gw-screen">
      <div className="gw-box">
        <h1>🛰️ GAGA GPS</h1>
        <p className="gw-subtitle">Inicia sesión para continuar a tu panel</p>
        <input
          type="email"
          placeholder="Correo"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          placeholder="Contraseña"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
        />
        <Button onClick={handleLogin} disabled={loading || !email || !password}>
          {loading ? 'Ingresando…' : 'Ingresar'}
        </Button>
        {error && <div className="gw-error">{error}</div>}
      </div>
    </div>
  );
}
