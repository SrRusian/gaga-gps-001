import { Capacitor } from '@capacitor/core';

// Config persistida del dispositivo (app nativa Android) - vive en localStorage, sobrevive
// reinstalaciones normales de Android Studio (solo se pierde con "Clear data" o desinstalar de verdad).

const API_BASE_URL_KEY = 'gaga_api_base_url';
const TELEMETRY_TOKEN_KEY = 'gaga_telemetry_token';
export const DEVICE_ID_KEY = 'gaga_operator_device_id';

// servidor real de produccion - fallback automatico SOLO dentro de la app nativa, para que un
// rol que no sea operador (Admin/Encargado/Supervisor) pueda instalar el APK y hacer login sin
// entrar nunca a Ajustes a configurar nada a mano. En navegador normal nunca aplica (ahi "vacio"
// siempre significa mismo origen, que es correcto - Express sirve la SPA y la API del mismo host).
export const PRODUCTION_SERVER_URL = 'https://app.gaga-maquinaria.com';

// valor guardado tal cual, SIN el fallback de produccion de abajo - lo usa la migracion de
// perfiles (DeviceSettingsPanel.tsx) para distinguir "nunca se configuro nada" de "ya apunta a
// produccion porque es el default", y no crear un perfil falso a partir del default.
export function getStoredApiBaseUrl(): string {
  return localStorage.getItem(API_BASE_URL_KEY) ?? '';
}

export function getApiBaseUrl(): string {
  const stored = getStoredApiBaseUrl();
  if (stored) return stored;
  return Capacitor.isNativePlatform() ? PRODUCTION_SERVER_URL : '';
}

export function setApiBaseUrl(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed) localStorage.setItem(API_BASE_URL_KEY, trimmed);
  else localStorage.removeItem(API_BASE_URL_KEY);
}

// true solo si alguien configuro un servidor explicitamente - no cuenta el fallback de produccion
export function hasApiBaseUrl(): boolean {
  return getStoredApiBaseUrl() !== '';
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

export interface ServerProfile {
  id: string;
  name: string;
  serverUrl: string;
  token: string;
  deviceId: string;
}

const SERVER_PROFILES_KEY = 'gaga_server_profiles';
const ACTIVE_SERVER_PROFILE_KEY = 'gaga_active_server_profile_id';

// varias configuraciones guardadas de servidor+token+identificador (una tableta puede probarse
// contra distintos servidores/proyectos) - cambiar entre una y otra aplica sus 3 valores a las
// claves "en vivo" de arriba (getApiBaseUrl/getTelemetryToken/getDeviceId), que son las que de
// verdad lee el resto de la app (envio de posicion, llamadas a la API)
export function listServerProfiles(): ServerProfile[] {
  try {
    const raw = localStorage.getItem(SERVER_PROFILES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function upsertServerProfile(profile: ServerProfile): void {
  const profiles = listServerProfiles();
  const idx = profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) profiles[idx] = profile;
  else profiles.push(profile);
  localStorage.setItem(SERVER_PROFILES_KEY, JSON.stringify(profiles));
}

export function deleteServerProfile(id: string): void {
  const remaining = listServerProfiles().filter((p) => p.id !== id);
  localStorage.setItem(SERVER_PROFILES_KEY, JSON.stringify(remaining));
  if (getActiveServerProfileId() === id) localStorage.removeItem(ACTIVE_SERVER_PROFILE_KEY);
}

export function getActiveServerProfileId(): string {
  return localStorage.getItem(ACTIVE_SERVER_PROFILE_KEY) ?? '';
}

export function setActiveServerProfileId(id: string): void {
  localStorage.setItem(ACTIVE_SERVER_PROFILE_KEY, id);
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
