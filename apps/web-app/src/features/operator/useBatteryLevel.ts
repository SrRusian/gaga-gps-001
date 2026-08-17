import { useEffect, useState } from 'react';

interface BatteryManager extends EventTarget {
  level: number;
}
interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManager>;
}

// Battery Status API - soporte parcial/deprecado en algunos navegadores, feature-detect.
export function useBatteryLevel() {
  const [level, setLevel] = useState<number | null>(null);

  useEffect(() => {
    const nav = navigator as NavigatorWithBattery;
    if (!nav.getBattery) return;

    let battery: BatteryManager | null = null;
    const update = () => battery && setLevel(Math.round(battery.level * 100));

    nav.getBattery().then((b) => {
      battery = b;
      update();
      b.addEventListener('levelchange', update);
    });

    return () => battery?.removeEventListener('levelchange', update);
  }, []);

  return level;
}
