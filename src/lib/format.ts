import { M_TO_FT, MS_TO_FPM, MS_TO_KT } from './geo';

export const POSITION_SOURCES = ['ADS-B', 'ASTERIX', 'MLAT', 'FLARM'];

export const CATEGORIES = [
  'No info',
  'No ADS-B category info',
  'Light',
  'Small',
  'Large',
  'High vortex large',
  'Heavy',
  'High performance',
  'Rotorcraft',
  'Glider',
  'Lighter-than-air',
  'Parachutist',
  'Ultralight',
  'Reserved',
  'UAV',
  'Space vehicle',
  'Emergency vehicle',
  'Service vehicle',
  'Point obstacle',
  'Cluster obstacle',
  'Line obstacle',
];

const dash = '—';

export const fmtAlt = (m: number | null, onGround = false) =>
  onGround ? 'Ground' : m === null ? dash : `${Math.round(m * M_TO_FT).toLocaleString()} ft`;

export const fmtSpeed = (ms: number | null) => (ms === null ? dash : `${Math.round(ms * MS_TO_KT)} kt`);

export const fmtVRate = (ms: number | null) =>
  ms === null ? dash : `${ms > 0 ? '+' : ''}${Math.round(ms * MS_TO_FPM).toLocaleString()} ft/min`;

export const fmtHeading = (deg: number | null) => (deg === null ? dash : `${Math.round(deg).toString().padStart(3, '0')}°`);

export const fmtCoord = (lat: number | null, lon: number | null) =>
  lat === null || lon === null
    ? dash
    : `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;

export function fmtAge(sec: number): string {
  if (!Number.isFinite(sec)) return dash;
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const fmtClock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** Colour by altitude band, shared by map, list and legend. */
export const ALT_BANDS: { maxFt: number; color: string; label: string }[] = [
  // Apple system colours: green, mint, yellow, orange, pink, purple
  { maxFt: 2_000, color: '#30d158', label: '<2k' },
  { maxFt: 10_000, color: '#63e6e2', label: '10k' },
  { maxFt: 20_000, color: '#ffd60a', label: '20k' },
  { maxFt: 30_000, color: '#ff9f0a', label: '30k' },
  { maxFt: 38_000, color: '#ff375f', label: '38k' },
  { maxFt: Infinity, color: '#bf5af2', label: '38k+' },
];
export const GROUND_COLOR = '#8e8e93';
export const UNKNOWN_COLOR = '#c7c7cc';

export function altColor(m: number | null, onGround: boolean): string {
  if (onGround) return GROUND_COLOR;
  if (m === null) return UNKNOWN_COLOR;
  const ft = m * M_TO_FT;
  for (const b of ALT_BANDS) if (ft < b.maxFt) return b.color;
  return ALT_BANDS[ALT_BANDS.length - 1].color;
}
