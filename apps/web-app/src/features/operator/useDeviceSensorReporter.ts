import { createApiClient, getStoredToken } from '@gaga-gps/client';
import { useEffect, useRef } from 'react';

const api = createApiClient({ getToken: getStoredToken });
const DYNAMIC_REPORT_INTERVAL_MS = 30000;

interface NetworkInformation extends EventTarget {
  effectiveType?: string;
  downlink?: number;
  downlinkMax?: number;
  rtt?: number;
  saveData?: boolean;
  type?: string;
}
interface BatteryManager extends EventTarget {
  level: number;
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
}
interface ExtendedNavigator extends Navigator {
  connection?: NetworkInformation;
  deviceMemory?: number;
  getBattery?: () => Promise<BatteryManager>;
  userAgentData?: { platform?: string; mobile?: boolean; brands?: { brand: string }[] };
}

interface OrientationSample {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
}
interface MotionSample {
  x: number | null;
  y: number | null;
  z: number | null;
  rotationRateAlpha: number | null;
}

async function post(deviceId: string, data: Record<string, unknown>, source: string) {
  try {
    await api.post(`/api/devices/${encodeURIComponent(deviceId)}/sensors`, { data, source });
  } catch (err) {
    console.error('No se pudo enviar snapshot de sensores:', (err as Error).message);
  }
}

function collectProfile(): Record<string, unknown> {
  const nav = navigator as ExtendedNavigator;
  return {
    userAgent: nav.userAgent,
    platform: nav.userAgentData?.platform ?? nav.platform,
    language: nav.language,
    languages: nav.languages,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemoryGb: nav.deviceMemory ?? null,
  };
}

async function collectDynamicSnapshot(
  orientation: OrientationSample | null,
  motion: MotionSample | null,
): Promise<Record<string, unknown>> {
  const nav = navigator as ExtendedNavigator;
  const snapshot: Record<string, unknown> = {
    onLine: nav.onLine,
    visibilityState: document.visibilityState,
    screen: {
      width: screen.width,
      height: screen.height,
      pixelRatio: window.devicePixelRatio,
      orientation: screen.orientation?.type ?? null,
    },
  };

  if (nav.connection) {
    snapshot.network = {
      effectiveType: nav.connection.effectiveType ?? null,
      downlinkMbps: nav.connection.downlink ?? null,
      rttMs: nav.connection.rtt ?? null,
      saveData: nav.connection.saveData ?? null,
      type: nav.connection.type ?? null,
    };
  }

  if (nav.getBattery) {
    try {
      const battery = await nav.getBattery();
      snapshot.battery = {
        levelPct: Math.round(battery.level * 100),
        charging: battery.charging,
        chargingTimeSec: Number.isFinite(battery.chargingTime) ? battery.chargingTime : null,
        dischargingTimeSec: Number.isFinite(battery.dischargingTime)
          ? battery.dischargingTime
          : null,
      };
    } catch {
      // Sin soporte real en este dispositivo
    }
  }

  if (navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      snapshot.storage = { usageBytes: estimate.usage ?? null, quotaBytes: estimate.quota ?? null };
    } catch {
      // Idem - algunos navegadores exponen la API pero la rechazan en ciertos contextos.
    }
  }

  if (orientation) snapshot.deviceOrientation = orientation;
  if (motion) snapshot.deviceMotion = motion;

  return snapshot;
}

export function useDeviceSensorReporter(deviceId: string | null) {
  const orientationRef = useRef<OrientationSample | null>(null);
  const motionRef = useRef<MotionSample | null>(null);

  useEffect(() => {
    function onOrientation(e: DeviceOrientationEvent) {
      orientationRef.current = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
    }
    function onMotion(e: DeviceMotionEvent) {
      motionRef.current = {
        x: e.acceleration?.x ?? null,
        y: e.acceleration?.y ?? null,
        z: e.acceleration?.z ?? null,
        rotationRateAlpha: e.rotationRate?.alpha ?? null,
      };
    }
    window.addEventListener('deviceorientation', onOrientation);
    window.addEventListener('devicemotion', onMotion);
    return () => {
      window.removeEventListener('deviceorientation', onOrientation);
      window.removeEventListener('devicemotion', onMotion);
    };
  }, []);

  useEffect(() => {
    if (!deviceId) return;
    const id = deviceId;

    let cancelled = false;

    post(id, collectProfile(), 'browser_profile');

    async function reportDynamic() {
      const snapshot = await collectDynamicSnapshot(orientationRef.current, motionRef.current);
      if (cancelled) return;
      await post(id, snapshot, 'browser');
    }

    reportDynamic();
    const interval = setInterval(reportDynamic, DYNAMIC_REPORT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [deviceId]);
}
