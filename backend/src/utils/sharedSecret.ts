import nodeCrypto from 'crypto';

// comparación en tiempo constante - usado por cualquier endpoint de ingestión sin sesión de usuario (/gps, /api/equipment-variables)
export function isValidSharedSecret(expectedSecret: string | null, providedKey: unknown): boolean {
  if (!expectedSecret || !providedKey) return false;
  const expected = Buffer.from(expectedSecret);
  const provided = Buffer.from(String(providedKey));
  if (expected.length !== provided.length) return false;
  return nodeCrypto.timingSafeEqual(expected, provided);
}
