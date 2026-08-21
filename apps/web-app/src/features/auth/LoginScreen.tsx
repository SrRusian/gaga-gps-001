import { ApiError, type AuthUser, createApiClient, resolveRolePath, saveSession } from '@gaga-gps/client';
import { Button } from '@gaga-gps/ui';
import { Capacitor } from '@capacitor/core';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DeviceSettingsPanel } from '../device-settings/DeviceSettingsPanel';

interface LoginResponse {
  token: string;
  user: AuthUser;
}

export function LoginScreen() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  async function handleLogin() {
    setError('');
    setLoading(true);
    try {
      // se crea aqui (no a nivel de modulo) para siempre leer la URL de servidor mas reciente -
      // en la app nativa se puede configurar desde el engranaje sin recargar la pagina
      const api = createApiClient();
      const data = await api.post<LoginResponse>('/api/auth/login', { email, password });
      saveSession(data.token, data.user);
      navigate(`/${resolveRolePath(data.user.role)}`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error de inicio de sesión');
      setLoading(false);
    }
  }

  return (
    <div className="gw-screen">
      <div className="gw-box">
        <h1>GAGA GPS</h1>
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
        <Button
          className="gw-submit"
          onClick={handleLogin}
          disabled={loading || !email || !password}
        >
          {loading ? 'Ingresando…' : 'Ingresar'}
        </Button>
        {error && <div className="gw-error">{error}</div>}
      </div>

      {Capacitor.isNativePlatform() && (
        <button
          className="ds-gear-btn"
          onClick={() => setShowSettings(true)}
          aria-label="Configuracion del dispositivo"
          title="Configuracion del dispositivo"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      )}
      {showSettings && <DeviceSettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}
