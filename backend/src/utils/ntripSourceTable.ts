import net from 'net';

// misma logica que NtripSourceTable.kt (app/android/.../rtk/NtripSourceTable.kt) - duplicada a
// proposito, no hay forma de compartir codigo real entre Node y Kotlin (ver gotcha de
// shared-types en CLAUDE.md). GET / (sin mountpoint) contra cualquier caster NTRIP real regresa
// la tabla completa de fuentes disponibles - estandar del protocolo (RTCM Ntrip 1/2), no algo
// especifico de un proveedor. Formato de cada fila: "STR;mountpoint;identifier;format;
// format-details;carrier;nav-system;network;country;lat;lon;nmea;..." hasta "ENDSOURCETABLE".
export interface NtripMountpointInfo {
  mountpoint: string;
  identifier: string;
  format: string;
  navSystem: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  nmeaRequired: boolean;
}

const SOCKET_TIMEOUT_MS = 10000;

export function fetchNtripSourceTable(host: string, port: number): Promise<NtripMountpointInfo[]> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let state: 'status' | 'headers' | 'body' = 'status';
    let settled = false;
    const mountpoints: NtripMountpointInfo[] = [];

    const socket = net.connect({ host, port });

    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(mountpoints);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(SOCKET_TIMEOUT_MS, () => fail(new Error('Tiempo de espera agotado consultando el caster')));
    socket.on('error', (err) => fail(err));
    socket.on('close', finish);

    socket.on('connect', () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: NTRIP GAGA-GPS/1.0\r\nConnection: close\r\n\r\n`,
      );
    });

    socket.on('data', (chunk) => {
      // latin1: la tabla de fuentes es ASCII/latin1 puro, nunca UTF-8 multibyte - igual que el
      // parser NMEA del lado Kotlin
      buffer += chunk.toString('latin1');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);

        if (state === 'status') {
          if (!line.includes('200') && !line.includes('SOURCETABLE')) {
            fail(new Error(`El caster no respondió con la tabla de fuentes: ${line || 'sin respuesta'}`));
            return;
          }
          state = 'headers';
          continue;
        }
        if (state === 'headers') {
          if (line.trim() === '') state = 'body';
          continue;
        }
        if (line.startsWith('ENDSOURCETABLE')) {
          finish();
          return;
        }
        if (!line.startsWith('STR;')) continue;
        const f = line.split(';');
        if (f.length < 9) continue;
        mountpoints.push({
          mountpoint: f[1] ?? '',
          identifier: f[2] ?? '',
          format: f[3] ?? '',
          navSystem: f[6] ?? '',
          country: f[8] ?? '',
          latitude: f[9] ? Number(f[9]) : null,
          longitude: f[10] ? Number(f[10]) : null,
          nmeaRequired: f[11] === '1',
        });
      }
    });
  });
}
