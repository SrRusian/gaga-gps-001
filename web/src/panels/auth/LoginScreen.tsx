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
  const [showPassword, setShowPassword] = useState(false);

  async function performLogin(emailValue: string, passwordValue: string): Promise<boolean> {
    setError('');
    setLoading(true);
    try {
      // se crea aqui (no a nivel de modulo) para siempre leer la URL de servidor mas reciente -
      // en la app nativa se puede configurar desde el engranaje sin recargar la pagina
      const api = createApiClient();
      const data = await api.post<LoginResponse>('/api/auth/login', {
        email: emailValue,
        password: passwordValue,
      });

      // Operador es exclusivo de la app instalada - nunca se debe poder ver este panel desde un
      // navegador normal, ni siquiera con credenciales validas. Se corta aqui, antes de guardar
      // sesion, para que ni el login parezca haber funcionado.
      if (data.user.role === 'operator' && !Capacitor.isNativePlatform()) {
        setError('Esta cuenta es de Operador - inicia sesión desde la app instalada en la tableta, no desde el navegador.');
        setLoading(false);
        return false;
      }

      saveSession(data.token, data.user);
      if (data.user.role !== 'operator') captureApproximateLocation(data.token);
      navigate(`/${resolveRolePath(data.user.role)}`, { replace: true });
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error de inicio de sesión');
      setLoading(false);
      return false;
    }
  }

  function handleLogin() {
    performLogin(email, password);
  }

  return (
    <div className="gw-screen">
      <div className="gw-box">
        <div className="gw-brand">
          <svg className="gw-logo" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <defs>
              <linearGradient id="gw-gps-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#00C6FF" />
                <stop offset="0.5" stopColor="#008CFF" />
                <stop offset="1" stopColor="#0066FF" />
              </linearGradient>
            </defs>
            <path
              d="M12 22s7-6.7 7-12A7 7 0 0 0 5 10c0 5.3 7 12 7 12Z"
              stroke="url(#gw-gps-grad)"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="10" r="2.6" stroke="url(#gw-gps-grad)" strokeWidth="1.8" />
          </svg>
          <h1>
            <span className="gw-gaga">GAGA</span>
            <span className="gw-gps">GPS</span>
          </h1>
          <p className="gw-subtitle">Inicia sesión para continuar a tu panel</p>
        </div>

        <div className="gw-input-wrap">
          <svg className="gw-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="m4 7 8 6 8-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <input
            type="email"
            placeholder="Correo"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="gw-input-wrap gw-input-wrap--password">
          <svg className="gw-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" strokeLinecap="round" />
          </svg>
          <input
            type={showPassword ? 'text' : 'password'}
            placeholder="Contraseña"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          />
          <button
            type="button"
            className="gw-toggle-pw"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
            title={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          >
            {showPassword ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M2 12s3.5-7 10-7c1.7 0 3.2.4 4.6 1.1M22 12s-3.5 7-10 7c-1.7 0-3.2-.4-4.6-1.1" strokeLinecap="round" />
                <path d="M4 4l16 16" strokeLinecap="round" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" strokeLinejoin="round" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>

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
