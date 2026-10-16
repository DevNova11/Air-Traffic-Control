/**
 * Pure functions that maintain aircraft state across snapshots. Kept free of
 * React/Zustand so the rules are easy to read and test.
 */
import { deadReckon, inBBox, M_TO_FT, MS_TO_KT } from './geo';
import type { BBox, Filters, Frame, Observation, StatesResponse, StateVector, Track } from './types';

/** A position older than this (relative to the snapshot time) is considered stale. */
export const STALE_POSITION_SEC = 30;
/** Drop an aircraft after missing this many consecutive snapshots… */
export const DROP_AFTER_MISSED_POLLS = 2;
/** …and not having been seen for at least this long. */
export const DROP_MIN_AGE_MS = 60_000;
/** Never dead-reckon further than this from the last real position. */
export const MAX_EXTRAPOLATION_SEC = 180;
export const HISTORY_LIMIT = 240;
export const FRAME_LIMIT = 120;

/** Fields we carry forward from the previous update when the new one omits them. */
const CARRY_FIELDS = ['callsign', 'baroAltitude', 'geoAltitude', 'velocity', 'trueTrack', 'verticalRate', 'squawk'] as const;

export interface MergeResult {
  tracks: Map<string, Track>;
  entered: number;
  left: number;
  lost: number;
  updated: number;
  outOfOrder: number;
  noPosition: number;
}

function toObservation(s: StateVector, t: number): Observation {
  return {
    t,
    lat: s.lat!,
    lon: s.lon!,
    alt: s.baroAltitude ?? s.geoAltitude,
    vel: s.velocity,
    track: s.trueTrack,
    onGround: s.onGround,
  };
}

/**
 * Merge a new snapshot into the existing tracks.
 *
 * - New aircraft are added ("entered").
 * - Known aircraft get their latest state; history is appended only when the
 *   position time advances. Older positions (out-of-order data) are ignored.
 * - Null fields are filled from the previous update and flagged in `carried`.
 * - Aircraft missing from the snapshot are kept as "stale" for a grace period
 *   (they often drop out of coverage briefly) and removed once they have missed
 *   several polls, or immediately if their estimated position is outside the region.
 */
export function mergeSnapshot(
  prev: Map<string, Track>,
  snap: StatesResponse,
  region: BBox,
  nowMs: number,
  /** Current time on the data's clock (seconds); positions older than STALE_POSITION_SEC are stale. */
  nowSec: number,
): MergeResult {
  const next = new Map<string, Track>();
  const r: MergeResult = { tracks: next, entered: 0, left: 0, lost: 0, updated: 0, outOfOrder: 0, noPosition: 0 };

  for (const s of snap.states) {
    if (s.lat === null || s.lon === null) {
      r.noPosition++;
      continue;
    }
    const posTime = s.timePosition ?? s.lastContact;
    const status = nowSec - posTime > STALE_POSITION_SEC ? 'stale' : 'active';
    const old = prev.get(s.icao24);

    if (!old) {
      next.set(s.icao24, {
        icao24: s.icao24,
        latest: s,
        history: [toObservation(s, posTime)],
        firstSeen: nowMs,
        lastSeen: nowMs,
        lastPositionTime: posTime,
        missedPolls: 0,
        status,
        carried: [],
      });
      r.entered++;
      continue;
    }

    if (posTime < old.lastPositionTime) {
      // Out-of-order (older) position: keep what we have, but the aircraft is still alive.
      next.set(s.icao24, { ...old, lastSeen: nowMs, missedPolls: 0, hydrated: false });
      r.outOfOrder++;
      continue;
    }

    const carried: string[] = [];
    const merged: StateVector = { ...s };
    for (const f of CARRY_FIELDS) {
      if (merged[f] === null && old.latest[f] !== null) {
        (merged as unknown as Record<string, unknown>)[f] = old.latest[f];
        carried.push(f);
      }
    }

    let history = old.history;
    if (posTime > old.lastPositionTime) {
      history = old.history.length >= HISTORY_LIMIT ? old.history.slice(1) : old.history.slice();
      history.push(toObservation(merged, posTime));
    }

    next.set(s.icao24, {
      ...old,
      latest: merged,
      history,
      lastSeen: nowMs,
      lastPositionTime: posTime,
      missedPolls: 0,
      status,
      carried,
      hydrated: false,
    });
    r.updated++;
  }

  const estNowSec = snap.time;
  for (const [id, old] of prev) {
    if (next.has(id)) continue;
    // Restored-from-cache aircraft that the first live snapshot doesn't confirm are dropped.
    if (old.hydrated) {
      r.lost++;
      continue;
    }
    const [lat, lon] = estimatePosition(old, estNowSec);
    if (!inBBox(region, lat, lon)) {
      r.left++;
      continue;
    }
    const missedPolls = old.missedPolls + 1;
    if (missedPolls >= DROP_AFTER_MISSED_POLLS && nowMs - old.lastSeen >= DROP_MIN_AGE_MS) {
      r.lost++;
      continue;
    }
    next.set(id, { ...old, missedPolls, status: 'stale' });
  }

  return r;
}

/** Re-evaluate position freshness without new data (e.g. the feed repeated the same snapshot). */
export function refreshStatuses(tracks: Map<string, Track>, nowSec: number): Map<string, Track> {
  let changed = false;
  const next = new Map<string, Track>();
  for (const [id, t] of tracks) {
    const status = t.missedPolls > 0 || nowSec - t.lastPositionTime > STALE_POSITION_SEC ? 'stale' : 'active';
    if (status !== t.status) changed = true;
    next.set(id, status === t.status ? t : { ...t, status });
  }
  return changed ? next : tracks;
}

/** Remove tracks outside a (new) region. */
export function pruneToRegion(tracks: Map<string, Track>, region: BBox): Map<string, Track> {
  const next = new Map<string, Track>();
  for (const [id, t] of tracks) {
    if (t.latest.lat !== null && t.latest.lon !== null && inBBox(region, t.latest.lat, t.latest.lon)) next.set(id, t);
  }
  return next;
}

/**
 * Estimated position at `atSec` (OpenSky clock) by dead reckoning from the last
 * real position using ground speed and track. Returns the last real position if
 * the aircraft is on the ground or speed/track are unknown.
 */
export function estimatePosition(t: Track, atSec: number): [number, number, number] {
  const s = t.latest;
  const lat = s.lat!;
  const lon = s.lon!;
  if (s.onGround || s.velocity === null || s.trueTrack === null || s.velocity < 1) return [lat, lon, 0];
  const dt = Math.min(MAX_EXTRAPOLATION_SEC, Math.max(0, atSec - t.lastPositionTime));
  const [elat, elon] = deadReckon(lat, lon, s.trueTrack, s.velocity, dt);
  return [elat, elon, dt];
}

export function trackAltitudeM(s: StateVector): number | null {
  return s.baroAltitude ?? s.geoAltitude;
}

export function matchesFilters(t: Track, f: Filters): boolean {
  const s = t.latest;
  if (!f.showStale && t.status === 'stale') return false;
  if (!f.showOnGround && s.onGround) return false;
  if (f.country && s.originCountry !== f.country) return false;
  if (f.positionSource >= 0 && s.positionSource !== f.positionSource) return false;
  if (f.query) {
    const q = f.query.trim().toLowerCase();
    if (q && !(s.icao24.includes(q) || (s.callsign ?? '').toLowerCase().includes(q) || (s.squawk ?? '') === q)) {
      return false;
    }
  }
  if (f.minAltFt !== null || f.maxAltFt !== null) {
    const alt = trackAltitudeM(s);
    const ft = s.onGround ? 0 : alt === null ? null : alt * M_TO_FT;
    if (ft === null) return false;
    if (f.minAltFt !== null && ft < f.minAltFt) return false;
    if (f.maxAltFt !== null && ft > f.maxAltFt) return false;
  }
  if (f.minSpeedKt !== null || f.maxSpeedKt !== null) {
    if (s.velocity === null) return false;
    const kt = s.velocity * MS_TO_KT;
    if (f.minSpeedKt !== null && kt < f.minSpeedKt) return false;
    if (f.maxSpeedKt !== null && kt > f.maxSpeedKt) return false;
  }
  return true;
}

export function toFrame(time: number, tracks: Map<string, Track>): Frame {
  const a: Frame['a'] = [];
  for (const t of tracks.values()) {
    if (t.status === 'stale' && t.missedPolls > 0) continue;
    const s = t.latest;
    const alt = trackAltitudeM(s);
    a.push([t.icao24, +s.lat!.toFixed(5), +s.lon!.toFixed(5), s.trueTrack ?? -1, alt === null ? -1 : Math.round(alt), s.onGround ? 1 : 0]);
  }
  return { t: time, a };
}

export const DEFAULT_FILTERS: Filters = {
  query: '',
  country: '',
  minAltFt: null,
  maxAltFt: null,
  minSpeedKt: null,
  maxSpeedKt: null,
  showOnGround: true,
  showStale: true,
  positionSource: -1,
};
