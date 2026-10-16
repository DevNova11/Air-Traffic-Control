import type { BBox, Region } from './types';

export const REGIONS: Region[] = [
  { id: 'ch', name: 'Switzerland', bbox: { lamin: 45.8, lomin: 5.9, lamax: 47.8, lomax: 10.5 } },
  { id: 'ceu', name: 'Central Europe', bbox: { lamin: 44, lomin: 0, lamax: 52, lomax: 16 } },
  { id: 'uk', name: 'UK & Ireland', bbox: { lamin: 49.8, lomin: -10.7, lamax: 59, lomax: 2 } },
  { id: 'india-s', name: 'South India', bbox: { lamin: 8, lomin: 74, lamax: 16, lomax: 82 } },
  { id: 'india', name: 'India', bbox: { lamin: 6, lomin: 68, lamax: 36, lomax: 98 } },
  { id: 'gulf', name: 'Gulf', bbox: { lamin: 22, lomin: 46, lamax: 30, lomax: 58 } },
  { id: 'us-ne', name: 'US Northeast', bbox: { lamin: 38, lomin: -80, lamax: 45, lomax: -69 } },
  { id: 'us-w', name: 'US West Coast', bbox: { lamin: 32, lomin: -124, lamax: 42, lomax: -114 } },
  { id: 'japan', name: 'Japan', bbox: { lamin: 30, lomin: 129, lamax: 46, lomax: 146 } },
  { id: 'world', name: 'Whole world', bbox: { lamin: -90, lomin: -180, lamax: 90, lomax: 180 } },
];

export const DEFAULT_REGION = REGIONS[1];

export const M_TO_FT = 3.28084;
export const MS_TO_KT = 1.943844;
export const MS_TO_FPM = 196.8504;

const EARTH_RADIUS_M = 6_371_000;

export function bboxArea(b: BBox): number {
  return (b.lamax - b.lamin) * (b.lomax - b.lomin);
}

/**
 * OpenSky charges credits per /states/all request by the area queried
 * (square degrees): <=25 → 1, <=100 → 2, <=400 → 3, larger/global → 4.
 */
export function creditCost(b: BBox): number {
  const area = bboxArea(b);
  if (area <= 25) return 1;
  if (area <= 100) return 2;
  if (area <= 400) return 3;
  return 4;
}

export function inBBox(b: BBox, lat: number, lon: number): boolean {
  return lat >= b.lamin && lat <= b.lamax && lon >= b.lomin && lon <= b.lomax;
}

export function sameBBox(a: BBox, b: BBox): boolean {
  return a.lamin === b.lamin && a.lomin === b.lomin && a.lamax === b.lamax && a.lomax === b.lomax;
}

export function isValidBBox(b: BBox): boolean {
  return (
    [b.lamin, b.lomin, b.lamax, b.lomax].every(Number.isFinite) &&
    b.lamin >= -90 && b.lamax <= 90 && b.lomin >= -180 && b.lomax <= 180 &&
    b.lamin < b.lamax && b.lomin < b.lomax
  );
}

export function clampBBox(b: BBox): BBox {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return {
    lamin: r(Math.max(-90, b.lamin)),
    lamax: r(Math.min(90, b.lamax)),
    lomin: r(Math.max(-180, b.lomin)),
    lomax: r(Math.min(180, b.lomax)),
  };
}

/**
 * Dead reckoning: move from (lat, lon) along `trackDeg` at `speedMs` for `dtSec`
 * using the spherical destination-point formula.
 */
export function deadReckon(
  lat: number,
  lon: number,
  trackDeg: number,
  speedMs: number,
  dtSec: number,
): [number, number] {
  const d = (speedMs * dtSec) / EARTH_RADIUS_M;
  if (d === 0) return [lat, lon];
  const brg = (trackDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(brg));
  const λ2 =
    λ1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
  return [(φ2 * 180) / Math.PI, ((((λ2 * 180) / Math.PI + 540) % 360) - 180)];
}
