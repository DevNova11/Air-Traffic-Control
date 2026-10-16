'use client';

import { create } from 'zustand';
import { DEFAULT_RULES, evaluateAlerts } from '@/lib/alerts';
import { DEFAULT_REGION, sameBBox } from '@/lib/geo';
import { idbGet, idbSet, lsGet, lsSet } from '@/lib/idb';
import { DEFAULT_FILTERS, FRAME_LIMIT, matchesFilters, mergeSnapshot, pruneToRegion, refreshStatuses, toFrame } from '@/lib/tracks';
import type { AlertEvent, AlertRule, DataSource, Filters, Frame, Region, StatesResponse, Track } from '@/lib/types';

export type Phase = 'idle' | 'loading' | 'live' | 'degraded' | 'error' | 'offline';

export interface ConnectionStatus {
  phase: Phase;
  source: DataSource | 'offline-cache' | null;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  nextPollAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  warning: string | null;
  rateLimitRemaining: number | null;
  retryAfterSec: number | null;
  creditCost: number | null;
  suggestedIntervalMs: number | null;
  authenticated: boolean;
  requestsMade: number;
  lastDiff: { entered: number; left: number; lost: number; updated: number; outOfOrder: number } | null;
}

/** 'auto' follows the proxy's budget-aware suggestion; a number is a fixed interval in ms. */
export type PollMode = 'auto' | number;

interface ReplayState {
  active: boolean;
  playing: boolean;
  t: number;
  speed: number;
}

interface TrafficState {
  region: Region;
  tracks: Map<string, Track>;
  /** OpenSky time of the newest snapshot ingested. */
  snapshotTime: number | null;
  /** OpenSky clock minus wall clock (seconds) — maps "now" onto the data's timeline. */
  clockOffsetSec: number;
  /** How far the newest snapshot lags behind real time (seconds). */
  feedLagSec: number;
  frames: Frame[];
  status: ConnectionStatus;
  pollMode: PollMode;
  offlineMode: boolean;
  /** Failure mode injected at the proxy, for demonstrating resilience ('' = none). */
  simulate: '' | 'outage' | 'ratelimit' | 'recorded' | 'down';
  filters: Filters;
  selectedId: string | null;
  follow: boolean;
  showTrails: boolean;
  replay: ReplayState;
  alertRules: AlertRule[];
  alertEvents: AlertEvent[];
  activeAlerts: Set<string>;
  unreadAlerts: number;
  hydrated: boolean;
  /** Incremented to ask the poller for an immediate refresh. */
  refreshToken: number;

  setRegion: (r: Region) => void;
  ingest: (snap: StatesResponse, receivedAt: number) => void;
  patchStatus: (p: Partial<ConnectionStatus>) => void;
  setPollMode: (m: PollMode) => void;
  setOfflineMode: (v: boolean) => void;
  setSimulate: (v: TrafficState['simulate']) => void;
  setFilters: (p: Partial<Filters>) => void;
  resetFilters: () => void;
  select: (id: string | null) => void;
  setFollow: (v: boolean) => void;
  setShowTrails: (v: boolean) => void;
  setReplay: (p: Partial<ReplayState>) => void;
  setAlertRules: (rules: AlertRule[]) => void;
  clearAlerts: () => void;
  markAlertsRead: () => void;
  hydrate: () => Promise<void>;
  requestRefresh: () => void;
}

const PERSIST_KEY = 'snapshot-v2';
/** Warn when the newest OpenSky snapshot is older than this. */
const FEED_LAG_WARN_SEC = 60;
const PERSIST_HISTORY = 60;

interface Persisted {
  savedAt: number;
  region: Region;
  snapshotTime: number;
  clockOffsetSec: number;
  tracks: Track[];
  frames: Frame[];
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const s = useTraffic.getState();
    // Only real observations go into the offline cache (not recordings or the cache itself).
    if (s.snapshotTime === null || s.status.source === 'offline-cache' || s.status.source === 'recorded') return;
    const data: Persisted = {
      savedAt: Date.now(),
      region: s.region,
      snapshotTime: s.snapshotTime,
      clockOffsetSec: s.clockOffsetSec,
      tracks: [...s.tracks.values()].map((t) => ({ ...t, history: t.history.slice(-PERSIST_HISTORY) })),
      frames: s.frames,
    };
    void idbSet(PERSIST_KEY, data);
  }, 1500);
}

export const useTraffic = create<TrafficState>()((set, get) => ({
  region: DEFAULT_REGION,
  tracks: new Map(),
  snapshotTime: null,
  clockOffsetSec: 0,
  feedLagSec: 0,
  frames: [],
  status: {
    phase: 'idle',
    source: null,
    lastSuccessAt: null,
    lastAttemptAt: null,
    nextPollAt: null,
    consecutiveFailures: 0,
    lastError: null,
    warning: null,
    rateLimitRemaining: null,
    retryAfterSec: null,
    creditCost: null,
    suggestedIntervalMs: null,
    authenticated: false,
    requestsMade: 0,
    lastDiff: null,
  },
  pollMode: 'auto',
  offlineMode: false,
  simulate: '',
  filters: DEFAULT_FILTERS,
  selectedId: null,
  follow: false,
  showTrails: false,
  replay: { active: false, playing: false, t: 0, speed: 8 },
  alertRules: DEFAULT_RULES,
  alertEvents: [],
  activeAlerts: new Set(),
  unreadAlerts: 0,
  hydrated: false,
  refreshToken: 0,

  setRegion: (region) => {
    const s = get();
    if (sameBBox(region.bbox, s.region.bbox)) return;
    const tracks = pruneToRegion(s.tracks, region.bbox);
    lsSet('region', region);
    set({
      region,
      tracks,
      // Snapshots for the old region are no longer comparable.
      snapshotTime: null,
      frames: [],
      replay: { ...s.replay, active: false, playing: false },
      selectedId: s.selectedId && tracks.has(s.selectedId) ? s.selectedId : null,
    });
  },

  ingest: (snap, receivedAt) => {
    let s = get();
    // Recorded data lives on a different (older) timeline than live data. When the
    // proxy switches between them, start a fresh timeline instead of mixing the two.
    const isRecorded = snap.meta.source === 'recorded';
    const wasRecorded = s.status.source === 'recorded';
    if (s.snapshotTime !== null && isRecorded !== wasRecorded && s.status.source !== null) {
      set({ tracks: new Map(), frames: [], snapshotTime: null, replay: { ...s.replay, active: false, playing: false } });
      s = get();
    }
    // Ignore responses older than what we already have (e.g. a delayed reply or stale cache).
    if (s.snapshotTime !== null && snap.time < s.snapshotTime) {
      set({ status: { ...s.status, warning: 'Ignored an out-of-date response' } });
      return;
    }
    const duplicate = s.snapshotTime === snap.time && s.status.source !== 'offline-cache';
    // Live data is on the real unix clock (corrected for client clock skew via the proxy's clock);
    // a recording is replayed as if it were captured just now.
    const clockOffsetSec = isRecorded ? snap.time - receivedAt / 1000 : (snap.meta.serverTime - receivedAt) / 1000;
    const nowSec = receivedAt / 1000 + clockOffsetSec;
    const feedLagSec = Math.max(0, nowSec - snap.time);
    const lagging = !isRecorded && feedLagSec > FEED_LAG_WARN_SEC;
    const metaStatus: Partial<ConnectionStatus> = {
      source: snap.meta.source,
      warning:
        snap.meta.warning ??
        (lagging ? `OpenSky feed is ${Math.round(feedLagSec / 60)} min behind — positions are outdated` : null),
      rateLimitRemaining: snap.meta.rateLimitRemaining,
      retryAfterSec: snap.meta.retryAfterSec,
      creditCost: snap.meta.creditCost,
      suggestedIntervalMs: snap.meta.suggestedIntervalMs,
      authenticated: snap.meta.authenticated,
      phase: (snap.meta.source === 'live' || snap.meta.source === 'cache') && !lagging ? 'live' : 'degraded',
      lastSuccessAt: receivedAt,
      consecutiveFailures: 0,
      lastError: null,
    };
    if (duplicate) {
      // Same snapshot again (proxy cache / recording): nothing moved, don't count a missed poll.
      set({
        tracks: refreshStatuses(s.tracks, nowSec),
        clockOffsetSec,
        feedLagSec,
        status: { ...s.status, ...metaStatus },
      });
      return;
    }

    const res = mergeSnapshot(s.tracks, snap, s.region.bbox, receivedAt, nowSec);
    const frames = s.frames.filter((f) => f.t < snap.time).slice(-(FRAME_LIMIT - 1));
    frames.push(toFrame(snap.time, res.tracks));

    const { events, active } = evaluateAlerts(s.alertRules, res.tracks, s.activeAlerts, receivedAt);

    set({
      tracks: res.tracks,
      snapshotTime: snap.time,
      clockOffsetSec,
      feedLagSec,
      frames,
      activeAlerts: active,
      alertEvents: events.length ? [...events.reverse(), ...s.alertEvents].slice(0, 200) : s.alertEvents,
      unreadAlerts: s.unreadAlerts + events.length,
      status: {
        ...s.status,
        ...metaStatus,
        lastDiff: { entered: res.entered, left: res.left, lost: res.lost, updated: res.updated, outOfOrder: res.outOfOrder },
      },
    });
    schedulePersist();
  },

  patchStatus: (p) => set({ status: { ...get().status, ...p } }),
  setPollMode: (pollMode) => {
    lsSet('pollMode', pollMode);
    set({ pollMode });
  },
  setOfflineMode: (offlineMode) => set({ offlineMode }),
  setSimulate: (simulate) => set({ simulate, refreshToken: get().refreshToken + 1 }),
  setFilters: (p) => set({ filters: { ...get().filters, ...p } }),
  resetFilters: () => set({ filters: DEFAULT_FILTERS }),
  select: (selectedId) => set({ selectedId, follow: selectedId ? get().follow : false }),
  setFollow: (follow) => set({ follow }),
  setShowTrails: (showTrails) => set({ showTrails }),
  setReplay: (p) => set({ replay: { ...get().replay, ...p } }),
  setAlertRules: (alertRules) => {
    lsSet('alertRules', alertRules);
    // Evaluate right away against the aircraft we already have. Conditions that were
    // already active for an unchanged rule stay active (no duplicate events).
    const s = get();
    const ids = new Set(alertRules.map((r) => JSON.stringify(r)));
    const keep = new Set(
      [...s.activeAlerts].filter((k) => {
        const rule = s.alertRules.find((r) => k.startsWith(`${r.id}:`));
        return rule && ids.has(JSON.stringify(rule));
      }),
    );
    const { events, active } = evaluateAlerts(alertRules, s.tracks, keep, Date.now());
    set({
      alertRules,
      activeAlerts: active,
      alertEvents: events.length ? [...events.reverse(), ...s.alertEvents].slice(0, 200) : s.alertEvents,
      unreadAlerts: s.unreadAlerts + events.length,
    });
  },
  clearAlerts: () => set({ alertEvents: [], unreadAlerts: 0 }),
  markAlertsRead: () => set({ unreadAlerts: 0 }),
  requestRefresh: () => set({ refreshToken: get().refreshToken + 1 }),

  /** Restore preferences and the last session's aircraft so the map is useful before (or without) the network. */
  hydrate: async () => {
    const region = lsGet<Region | null>('region', null);
    const pollMode = lsGet<PollMode>('pollMode', 'auto');
    const alertRules = lsGet<AlertRule[] | null>('alertRules', null);
    set({ ...(region ? { region } : {}), pollMode, ...(alertRules ? { alertRules } : {}) });

    const saved = await idbGet<Persisted>(PERSIST_KEY);
    const s = get();
    if (saved && sameBBox(saved.region.bbox, s.region.bbox) && s.snapshotTime === null) {
      const tracks = new Map(saved.tracks.map((t) => [t.icao24, { ...t, status: 'stale' as const, hydrated: true }]));
      set({
        tracks,
        frames: saved.frames,
        snapshotTime: saved.snapshotTime,
        clockOffsetSec: saved.clockOffsetSec,
        status: { ...s.status, source: 'offline-cache', lastSuccessAt: saved.savedAt },
      });
    }
    set({ hydrated: true });
  },
}));

// ---------------------------------------------------------------------------
// Derived data (memoised on store references so the 15 fps canvas loop stays cheap)

let memoTracks: Map<string, Track> | null = null;
let memoFilters: Filters | null = null;
let memoResult: Track[] = [];

export function selectFilteredTracks(s: Pick<TrafficState, 'tracks' | 'filters'>): Track[] {
  if (s.tracks !== memoTracks || s.filters !== memoFilters) {
    memoTracks = s.tracks;
    memoFilters = s.filters;
    memoResult = [];
    for (const t of s.tracks.values()) if (matchesFilters(t, s.filters)) memoResult.push(t);
  }
  return memoResult;
}

/** Current time on the OpenSky clock. */
export function dataNowSec(s: Pick<TrafficState, 'clockOffsetSec'>): number {
  return Date.now() / 1000 + s.clockOffsetSec;
}
