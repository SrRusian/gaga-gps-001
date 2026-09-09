import { useEffect, useState } from 'react';

const HEALTH_CHECK_INTERVAL_MS = 7000;

export function useBackendReachable(): boolean {
  const [reachable, setReachable] = useState(true);
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch('/health');
        if (!cancelled) setReachable(res.ok);
      } catch {
        if (!cancelled) setReachable(false);
      }
    }
    check();
    const interval = setInterval(check, HEALTH_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
  return reachable;
}
