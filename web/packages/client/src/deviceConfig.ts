// Config persistida del dispositivo (app nativa Android) - vive en localStorage, sobrevive
// reinstalaciones normales de Android Studio (solo se pierde con "Clear data" o desinstalar de verdad).

const API_BASE_URL_KEY = 'gaga_api_base_url';
const TELEMETRY_TOKEN_KEY = 'gaga_telemetry_token';
export const DEVICE_ID_KEY = 'gaga_operator_device_id';

// vacio = mismo origen (comportamiento normal en navegador, donde Express sirve la SPA y la API
// desde el mismo host). Solo hace falta un valor real cuando no hay "mismo origen" posible - la
// app nativa Android (Capacitor) carga los assets desde su propio origen local, no desde el backend.
export function getApiBaseUrl(): string {
  return localStorage.getItem(API_BASE_URL_KEY) ?? '';
}

export function setApiBaseUrl(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed) localStorage.setItem(API_BASE_URL_KEY, trimmed);
  else localStorage.removeItem(API_BASE_URL_KEY);
}

export function hasApiBaseUrl(): boolean {
  return getApiBaseUrl() !== '';
}

// clave compartida (TELEMETRY_SHARED_SECRET del backend) para autenticar el envio de posicion
// estilo Traccar contra GET/POST /gps - mismo criterio que el resto de endpoints de ingestion sin sesion
export function getTelemetryToken(): string {
  return localStorage.getItem(TELEMETRY_TOKEN_KEY) ?? '';
}

export function setTelemetryToken(token: string): void {
  const trimmed = token.trim();
  if (trimmed) localStorage.setItem(TELEMETRY_TOKEN_KEY, trimmed);
  else localStorage.removeItem(TELEMETRY_TOKEN_KEY);
}

// mismo identificador que useDeviceId.ts (web) ya usa para el registro del vehiculo -
// se comparte la clave a proposito, asi configurarlo aqui evita que Operador lo vuelva a pedir
export function getDeviceId(): string {
  return localStorage.getItem(DEVICE_ID_KEY) ?? '';
}

export function setDeviceId(deviceId: string): void {
  const trimmed = deviceId.trim();
  if (trimmed) localStorage.setItem(DEVICE_ID_KEY, trimmed);
  else localStorage.removeItem(DEVICE_ID_KEY);
}

const SETTINGS_PASSWORD_KEY = 'gaga_settings_password';

// vacio = ajustes sin bloquear (comportamiento de siempre) - la persona que hace la instalacion
// pone una contrasena aqui mismo, desde dentro de ajustes, para que despues los operadores no
// puedan entrar a cambiar nada por accidente o a proposito
export function getSettingsPassword(): string {
  return localStorage.getItem(SETTINGS_PASSWORD_KEY) ?? '';
}

export function setSettingsPassword(password: string): void {
  const trimmed = password.trim();
  if (trimmed) localStorage.setItem(SETTINGS_PASSWORD_KEY, trimmed);
  else localStorage.removeItem(SETTINGS_PASSWORD_KEY);
}

export function hasSettingsPassword(): boolean {
  return getSettingsPassword() !== '';
}

const OPERATOR_MODE_KEY = 'gaga_operator_mode_enabled';

// switch de un solo sentido - una vez activado (codigo interno de 4 digitos, ver
// DeviceSettingsPanel.tsx) no se expone ninguna forma de apagarlo desde la UI. Un dispositivo
// nuevo se queda en modo basico (login + panel normal) hasta que alguien del equipo lo active a
// proposito - asi la app no pide permisos de ubicacion/USB ni manda datos hasta ese momento.
export function isOperatorModeEnabled(): boolean {
  return localStorage.getItem(OPERATOR_MODE_KEY) === 'true';
}

export function enableOperatorMode(): void {
  localStorage.setItem(OPERATOR_MODE_KEY, 'true');
}
