import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// base: '/' - una sola app SPA en la raíz del dominio. El
// enrutamiento de /admin, /supervisor y /operator ya no lo resuelve
// Express (4 mount points distintos como antes) sino React Router
// dentro de esta misma app - ver apps/backend/src/app.ts (fallback
// de SPA) y src/App.tsx (rutas + lazy loading por rol).
export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/gps': 'http://localhost:3001',
      '/tiles': 'http://localhost:3001',
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
});
