import { createSocket } from '@gaga-gps/client';
import type { ActiveMap, Geofence, Position } from '@gaga-gps/shared-types';
import { useEffect, useRef, useState } from 'react';
import { useAlertSound } from './useAlertSound';

export interface AlertState {
  severity: 'warning' | 'danger' | null;
  message: string;
}

export function useOperatorSocket(deviceId: string | null) {
  const [connected, setConnected] = useState(false);
  const [fleet, setFleet] = useState<Record<string, Position>>({});
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [activeMaps, setActiveMaps] = useState<ActiveMap[]>([]);
  const [myPosition, setMyPosition] = useState<Position | null>(null);
  const [myOnline, setMyOnline] = useState(false);
  const [alert, setAlert] = useState<AlertState>({ severity: null, message: '' });
  const { playWarningSound, playDangerSound, stopSound } = useAlertSound();

  // Refs para no re-suscribir el socket cada vez que cambian (los
  // handlers de socket.io capturan closures al momento de registrarse).
  const soundsRef = useRef({ playWarningSound, playDangerSound, stopSound });
  soundsRef.current = { playWarningSound, playDangerSound, stopSound };

  useEffect(() => {
    // Sin vehículo registrado no hay "mi posición" ni turno posible —
    // ni siquiera vale la pena abrir el socket. El operador ve un
    // mapa vacío hasta que registre un vehículo (ver OperatorApp).
    if (!deviceId) return;

    const socket = createSocket();

    const showWarning = (message: string) => setAlert({ severity: 'warning', message });
    const showDanger = (message: string) => setAlert({ severity: 'danger', message });
    const clearAlertState = () => setAlert({ severity: null, message: '' });

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => {
      setConnected(false);
      setMyOnline(false);
    });

    socket.on('maps:active_update', ({ maps }) => setActiveMaps(maps));
    socket.on('geofences:update', (gs) => setGeofences(gs));

    socket.on('fleet:update', (data) => {
      setFleet((prev) => {
        const next = { ...prev };
        data.positions.forEach((pos) => {
          next[pos.deviceId] = pos;
        });
        return next;
      });

      const mine = data.positions.find((p) => p.deviceId === deviceId);
      if (mine) {
        setMyPosition(mine);
        setMyOnline(true);
      }
    });

    // RF-ALR-02/03 — geocercas
    socket.on('alert:warning', (data) => {
      if (data.deviceId === deviceId) {
        showWarning(data.message);
        soundsRef.current.playWarningSound();
      }
    });
    socket.on('alert:critical', (data) => {
      if (data.deviceId === deviceId) {
        showDanger(data.message);
        soundsRef.current.playDangerSound(data.loop);
      }
    });
    socket.on('alert:clear', (data) => {
      if (data.deviceId === deviceId) {
        clearAlertState();
        soundsRef.current.stopSound();
      }
    });

    // RF-ALR-05 — pérdida de señal (broadcast a toda la flota, no filtrado por deviceId)
    socket.on('signal:lost:level1', (data) => {
      showWarning(data.message);
      soundsRef.current.playWarningSound();
    });
    socket.on('signal:lost:level2', (data) => {
      showDanger(data.message);
      soundsRef.current.playDangerSound(data.loop);
    });
    socket.on('signal:recovered', () => {
      clearAlertState();
      soundsRef.current.stopSound();
    });

    // RF-ALR-10 — anticolisión
    socket.on('collision:proximity', (data) => {
      showWarning(data.message);
      soundsRef.current.playWarningSound();
    });
    socket.on('collision:critical', (data) => {
      showDanger(data.message);
      soundsRef.current.playDangerSound(data.loop);
    });
    socket.on('collision:clear', () => {
      clearAlertState();
      soundsRef.current.stopSound();
    });

    // RF-ALR-12 — aproximación a equipo estático
    socket.on('equipment:approach_outer', (data) => {
      if (data.deviceId === deviceId) showWarning(data.message);
    });
    socket.on('equipment:approach_inner', (data) => {
      if (data.deviceId === deviceId) {
        showWarning(`${data.message} — VELOCIDAD MÁXIMA 5 km/h`);
        soundsRef.current.playWarningSound();
      }
    });
    socket.on('equipment:minimum_limit', (data) => {
      if (data.deviceId === deviceId) {
        showDanger(data.message);
        soundsRef.current.playDangerSound(data.loop);
      }
    });
    socket.on('equipment:approach_clear', (data) => {
      if (data.deviceId === deviceId) {
        clearAlertState();
        soundsRef.current.stopSound();
      }
    });

    // RF-ALR-11 — parada preventiva colectiva
    socket.on('fleet:preventive_stop', (data) => {
      showDanger(data.message);
      soundsRef.current.playDangerSound(data.loop);
    });
    socket.on('fleet:preventive_stop_clear', (data) => {
      clearAlertState();
      soundsRef.current.stopSound();
      showWarning(data.message);
      setTimeout(clearAlertState, 5000);
    });

    return () => {
      socket.disconnect();
    };
  }, [deviceId]);

  const activeCount = Object.keys(fleet).length;

  return { connected, fleet, geofences, activeMaps, myPosition, myOnline, alert, activeCount };
}
