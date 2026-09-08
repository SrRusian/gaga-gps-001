import { ApiError, type AuthUser, createApiClient, resolveRolePath, saveSession } from '@gaga-gps/client';
import { Button } from '@gaga-gps/ui';
import { Capacitor } from '@capacitor/core';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DeviceSettingsPanel } from '@gaga-gps/operator-ui/DeviceSettingsPanel';

interface LoginResponse {
  token: string;
  user: AuthUser;
}

// ubicacion aproximada, una sola vez al iniciar sesion - solo roles no-operador (Operador ya
// tiene su propio GPS/RTK en tiempo real, esto seria redundante). Nunca bloquea el login ni
// muestra error - si no hay permiso o falla, simplemente no se guarda nada.
function captureApproximateLocation(token: string) {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const api = createApiClient({ getToken: () => token });
      api
        .patch('/api/auth/me/location', {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        })
        .catch(() => {});
    },
    () => {},
    { timeout: 5000 },
  );
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

      // Operador es exclusivo de la app instalada - nunca se debe poder ver este panel desde un
      // navegador normal, ni siquiera con credenciales validas. Se corta aqui, antes de guardar
      // sesion, para que ni el login parezca haber funcionado.
      if (data.user.role === 'operator' && !Capacitor.isNativePlatform()) {
        setError('Esta cuenta es de Operador - inicia sesión desde la app instalada en la tableta, no desde el navegador.');
        setLoading(false);
        return;
      }

      saveSession(data.token, data.user);
      if (data.user.role !== 'operator') captureApproximateLocation(data.token);
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
