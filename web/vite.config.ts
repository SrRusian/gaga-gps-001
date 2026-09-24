import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  // lee el .env de la raiz del monorepo (el mismo que usa el backend), no uno propio de web/ - un
  // solo archivo de config para todo el proyecto. Seguro: Vite solo expone al bundle las claves
  // con prefijo VITE_ (ver .env.example "5. APP ANDROID/OPERADOR") - JWT_SECRET/DB_PASSWORD/etc
  // del resto del archivo nunca llegan al cliente aunque esten en el mismo .env.
  envDir: '..',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/gps': 'http://localhost:3001',
      '/tiles': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
  },
});
