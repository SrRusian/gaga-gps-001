import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// base: '/' - una sola app SPA en la raíz del dominio. El
// enrutamiento de /administrator, /manager, /supervisor y /operator
// ya no lo resuelve Express (4 mount points distintos como antes)
// sino React Router dentro de esta misma app - ver
// apps/backend/src/app.ts (fallback de SPA) y src/App.tsx (rutas +
// lazy loading por rol).
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
  build: {
    // El aviso por defecto (500kB) dispara con el chunk compartido
    // (`src-*.js`, confirmado por grep en el bundle que contiene el
    // UMD de maplibre-gl - un motor de mapas WebGL, ~1MB minificado
    // es normal para esa librería) - Admin/Encargado/Supervisor/
    // Operador ya tienen code-splitting real por rol (chunks propios,
    // AdminApp/SupervisorApp/OperatorApp), pero los tres necesitan un
    // mapa desde la primera carga, así que maplibre-gl siempre cae en
    // el chunk compartido entre los tres - no hay forma de dividirlo
    // más sin cambiar cuántos bytes baja cada usuario (seguiría
    // siendo el mismo total, solo repartido en más archivos). Límite
    // subido con margen sobre el tamaño real actual (~1037kB) para
    // seguir avisando si algo genuinamente nuevo e inesperado infla
    // el bundle más adelante.
    chunkSizeWarningLimit: 1200,
  },
});
