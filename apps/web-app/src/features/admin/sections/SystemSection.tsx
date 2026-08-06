import { useEffect, useState } from 'react';
import type { HealthResponse } from '../types';

export function SystemSection() {
  const [text, setText] = useState('');

  async function loadHealth() {
    try {
      const health: HealthResponse = await fetch('/health').then((r) => r.json());
      setText(JSON.stringify(health, null, 2));
    } catch (err) {
      setText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  useEffect(() => {
    loadHealth();
  }, []);

  return (
    <div className="card">
      <h3>Estado del sistema</h3>
      <pre style={{ fontSize: 13, color: '#c9d1d9' }}>{text}</pre>
      <button className="btn btn-sm" style={{ width: 'auto', marginTop: 10 }} onClick={loadHealth}>
        Actualizar
      </button>
    </div>
  );
}
