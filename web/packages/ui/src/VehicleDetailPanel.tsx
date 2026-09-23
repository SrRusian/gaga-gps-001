import { ConnectionStatusDot } from './ConnectionStatusDot';
import { formatAccuracy } from './format';

export interface VehicleDetailData {
  deviceId: string;
  deviceName?: string;
  speed?: number;
  course?: number;
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number;
  battery?: number | null;
  fixTime: Date | string;
}

export interface VehicleOperatorSession {
  user_name: string;
  started_at: string;
}

// version instalada del APK vs la ultima publicada (ver app-update.routes.ts) - installedVersionCode
// null significa que esta tableta nunca reporto una version (app vieja sin el actualizador, o
// nunca ha llegado a hacer su primera revision) - en ese caso el campo simplemente no se muestra
export interface VehicleAppVersion {
  installedVersionCode: number | null;
  installedVersionName: string | null;
  latestVersionCode: number | null;
}

export interface VehicleDetailPanelProps {
  vehicle: VehicleDetailData;
  offline: boolean;
  operatorSession?: VehicleOperatorSession | null;
  appVersion?: VehicleAppVersion;
  // nombre del tipo de vehículo asignado (ver vehicle_types) - null/undefined si no tiene uno
  // asignado, en cuyo caso el paréntesis simplemente no aparece (nunca un "vehicle" generico)
  vehicleTypeName?: string | null;
  onClose: () => void;
}

// panel de información de vehículo - un solo componente para los 3 paneles (Admin/Supervisor-Encargado/Operador),
// no una copia por panel, así un cambio de campo/formato se ve en los 3 a la vez.
export function VehicleDetailPanel({
  vehicle,
  offline,
  operatorSession,
  appVersion,
  vehicleTypeName,
  onClose,
}: VehicleDetailPanelProps) {
  return (
    <div className="gg-vehicle-detail">
      <div className="gg-vehicle-detail__title">
        <span>
          {vehicle.deviceName
            ? `${vehicle.deviceName}${vehicleTypeName ? ` (${vehicleTypeName})` : ''}`
            : `Vehículo ${vehicle.deviceId}`}
        </span>
        <button className="gg-vehicle-detail__close" onClick={onClose} aria-label="Cerrar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <div className="gg-vehicle-detail__row">
        <span className="gg-vehicle-detail__label">Estado</span>
        <span className="gg-vehicle-detail__value gg-vehicle-detail__status">
          <ConnectionStatusDot connected={!offline} />
          {offline ? 'Sin señal' : 'En línea'}
        </span>
      </div>

      <div className="gg-vehicle-detail__row">
        <span className="gg-vehicle-detail__label">Operador</span>
        <span className="gg-vehicle-detail__value">
          {operatorSession ? operatorSession.user_name : 'Sin turno abierto'}
        </span>
      </div>

      {appVersion?.installedVersionCode != null && (
        <div className="gg-vehicle-detail__row">
          <span className="gg-vehicle-detail__label">Versión app</span>
          <span
            className={`gg-vehicle-detail__value ${
              appVersion.latestVersionCode != null && appVersion.installedVersionCode < appVersion.latestVersionCode
                ? 'gg-vehicle-detail__value--warn'
                : 'gg-vehicle-detail__value--ok'
            }`}
          >
            {appVersion.installedVersionName ?? appVersion.installedVersionCode}
            {' - '}
            {appVersion.latestVersionCode != null && appVersion.installedVersionCode < appVersion.latestVersionCode
              ? 'Desactualizado'
              : 'Actualizado'}
          </span>
        </div>
      )}

      {operatorSession && (
        <div className="gg-vehicle-detail__row">
          <span className="gg-vehicle-detail__label">Turno iniciado</span>
          <span className="gg-vehicle-detail__value">
            {new Date(operatorSession.started_at).toLocaleString('es-MX')}
          </span>
        </div>
      )}

      <div className="gg-vehicle-detail__row">
        <span className="gg-vehicle-detail__label">Velocidad</span>
        <span className="gg-vehicle-detail__value">{Math.round((vehicle.speed || 0) * 3.6)} km/h</span>
      </div>

      <div className="gg-vehicle-detail__row">
        <span className="gg-vehicle-detail__label">Rumbo</span>
        <span className="gg-vehicle-detail__value">
          {vehicle.course !== undefined ? `${Math.round(vehicle.course)}°` : '--'}
        </span>
      </div>

      <div className="gg-vehicle-detail__row">
        <span className="gg-vehicle-detail__label">Latitud</span>
        <span className="gg-vehicle-detail__value">{vehicle.latitude?.toFixed(6)}</span>
      </div>

      <div className="gg-vehicle-detail__row">
        <span className="gg-vehicle-detail__label">Longitud</span>
        <span className="gg-vehicle-detail__value">{vehicle.longitude?.toFixed(6)}</span>
      </div>

      <div className="gg-vehicle-detail__row">
        <span className="gg-vehicle-detail__label">Precisión GPS</span>
        <span className="gg-vehicle-detail__value">{formatAccuracy(vehicle.accuracy)}</span>
      </div>

      <div className="gg-vehicle-detail__row">
        <span className="gg-vehicle-detail__label">Altitud</span>
        <span className="gg-vehicle-detail__value">
          {vehicle.altitude !== undefined ? `${Math.round(vehicle.altitude)} m` : '--'}
        </span>
      </div>

      <div className="gg-vehicle-detail__row">
        <span className="gg-vehicle-detail__label">Batería</span>
        <span className="gg-vehicle-detail__value">
          {vehicle.battery !== undefined && vehicle.battery !== null
            ? `${Math.round(vehicle.battery)}%`
            : '--'}
        </span>
      </div>

      <div className="gg-vehicle-detail__row">
        <span className="gg-vehicle-detail__label">Última actualización</span>
        <span className="gg-vehicle-detail__value">
          {new Date(vehicle.fixTime || Date.now()).toLocaleTimeString('es-MX')}
        </span>
      </div>
    </div>
  );
}
