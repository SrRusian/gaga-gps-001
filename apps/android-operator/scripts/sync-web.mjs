// Compila apps/web-app y copia su dist/ a apps/android-operator/www, que es el webDir que lee
// Capacitor (ver capacitor.config.ts). El APK carga el mismo bundle que ya usa el navegador -
// login, Operador, todo el codigo es el mismo, cero fork.
import { execSync } from 'node:child_process';
import { cpSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const webAppDir = path.join(repoRoot, 'apps', 'web-app');
const webAppDist = path.join(webAppDir, 'dist');
const wwwDir = path.join(here, '..', 'www');

console.log('[sync-web] compilando apps/web-app...');
execSync('npm run build', { cwd: webAppDir, stdio: 'inherit' });

if (!existsSync(webAppDist)) {
  throw new Error(`No se genero ${webAppDist} - revisa el build de web-app`);
}

console.log('[sync-web] copiando dist/ -> apps/android-operator/www ...');
rmSync(wwwDir, { recursive: true, force: true });
cpSync(webAppDist, wwwDir, { recursive: true });

console.log('[sync-web] listo. Corre "npx cap sync android" o "npm run cap:sync" a continuacion.');
