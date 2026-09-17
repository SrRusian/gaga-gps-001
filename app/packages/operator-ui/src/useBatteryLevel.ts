import { useEffect, useState } from 'react';

interface BatteryManager extends EventTarget {
  level: number;
  charging: boolean;
}
interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManager>;
}

export interface BatteryStatus {
  level: number | null;
  // true mientras la tableta recibe corriente (cable del vehiculo) - distinto de "suspendido" en
  // power/PowerStatusPlugin.kt, esto es el estado real de carga del propio navegador (Battery
  // Status API), no depende de que el kiosko este activo ni de la logica de suspension
  charging: boolean | null;
}

export function useBatteryLevel(): BatteryStatus {
  const [level, setLevel] = useState<number | null>(null);
  const [charging, setCharging] = useState<boolean | null>(null);

  useEffect(() => {
    const nav = navigator as NavigatorWithBattery;
    if (!nav.getBattery) return;

    let battery: BatteryManager | null = null;
    const update = () => {
      if (!battery) return;
      setLevel(Math.round(battery.level * 100));
      setCharging(battery.charging);
    };

    nav.getBattery().then((b) => {
      battery = b;
      update();
      b.addEventListener('levelchange', update);
      b.addEventListener('chargingchange', update);
    });

    return () => {
      battery?.removeEventListener('levelchange', update);
      battery?.removeEventListener('chargingchange', update);
    };
  }, []);

  return { level, charging };
}
