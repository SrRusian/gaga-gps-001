import type { NtripVersion } from '@gaga-gps/android-bridge';

// varias configuraciones NTRIP guardadas (caster/mount point puede variar por ubicacion/proyecto) -
// mismo patron que ServerProfile de @gaga-gps/client, pero exclusivo de este panel (nada mas lo usa)
export interface NtripProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  mountpoint: string;
  username: string;
  password: string;
  version: NtripVersion;
}

const NTRIP_PROFILES_KEY = 'gaga_ntrip_profiles';
const ACTIVE_NTRIP_PROFILE_KEY = 'gaga_active_ntrip_profile_id';

export function listNtripProfiles(): NtripProfile[] {
  try {
    const raw = localStorage.getItem(NTRIP_PROFILES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function upsertNtripProfile(profile: NtripProfile): void {
  const profiles = listNtripProfiles();
  const idx = profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) profiles[idx] = profile;
  else profiles.push(profile);
  localStorage.setItem(NTRIP_PROFILES_KEY, JSON.stringify(profiles));
}

export function deleteNtripProfile(id: string): void {
  const remaining = listNtripProfiles().filter((p) => p.id !== id);
  localStorage.setItem(NTRIP_PROFILES_KEY, JSON.stringify(remaining));
  if (getActiveNtripProfileId() === id) localStorage.removeItem(ACTIVE_NTRIP_PROFILE_KEY);
}

export function getActiveNtripProfileId(): string {
  return localStorage.getItem(ACTIVE_NTRIP_PROFILE_KEY) ?? '';
}

export function setActiveNtripProfileId(id: string): void {
  localStorage.setItem(ACTIVE_NTRIP_PROFILE_KEY, id);
}
