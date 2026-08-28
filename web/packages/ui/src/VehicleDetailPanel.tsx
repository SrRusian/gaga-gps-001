import { ConnectionStatusDot } from './ConnectionStatusDot';
import { formatAccuracy } from './format';

export interface VehicleDetailData {
  deviceId: string;
  deviceName?: string;
  deviceType?: string;
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

export interface VehicleDetailPanelProps {
  vehicle: VehicleDetailData;
  offline: boolean;
  operatorSession?: VehicleOperatorSession | null;
  onClose: () => void;
}

// panel de información de vehículo - un solo componente para los 3 paneles (Admin/Supervisor-Encargado/Operador),
// no una copia por panel, así un cambio de campo/formato se ve en los 3 a la vez.
export function VehicleDetailPanel({ vehicle, offline, operatorSession, onClose }: VehicleDetailPanelProps) {
  return (
    <div className="gg-vehicle-detail">
      <div className="gg-vehicle-detail__title">
        <span>
          {vehicle.deviceName
            ? `${vehicle.deviceName}${vehicle.deviceType ? ` (${vehicle.deviceType})` : ''}`
            : `Vehículo ${vehicle.deviceId}`}
        </span>
        <button className="gg-vehicle-detail__close" onClick={onClose}>
          X
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
