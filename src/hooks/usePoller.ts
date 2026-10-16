'use client';

import { useEffect } from 'react';
import { useTraffic } from '@/store/traffic';
import type { StatesResponse } from '@/lib/types';

const REQUEST_TIMEOUT_MS = 20_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const REGION_DEBOUNCE_MS = 500;

/**
 * Polls /api/states for the selected region.
 *
 * Avoids unnecessary requests by:
 *  - following the proxy's budget-aware interval (or a fixed user choice)
 *  - pausing while the tab is hidden, the browser is offline, offline mode or replay is on
 *  - aborting an in-flight request when the region changes (debounced)
 *  - exponential back-off with jitter after failures, honouring Retry-After
 */
export function usePoller() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let seq = 0;
    let disposed = false;

    const store = useTraffic;

    const blocked = () => {
      const s = store.getState();
      return (
        document.visibilityState === 'hidden' || !navigator.onLine || s.offlineMode || s.replay.active || !s.hydrated
      );
    };

    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      if (disposed) return;
      store.getState().patchStatus({ nextPollAt: Date.now() + ms });
      timer = setTimeout(tick, ms);
    };

    const intervalAfterSuccess = (): number => {
      const s = store.getState();
      const suggested = s.status.suggestedIntervalMs ?? 30_000;
      const base = s.pollMode === 'auto' ? suggested : s.pollMode;
      const retry = s.status.retryAfterSec ? s.status.retryAfterSec * 1000 : 0;
      return Math.max(MIN_INTERVAL_MS, base, retry);
    };

    async function tick() {
      if (disposed) return;
      if (blocked()) {
        const s = store.getState();
        if (!navigator.onLine || s.offlineMode) s.patchStatus({ phase: 'offline', nextPollAt: null });
        else s.patchStatus({ nextPollAt: null });
        return; // resumed by the listeners below
      }

      const id = ++seq;
      controller?.abort();
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
      const { region, status, patchStatus, simulate } = store.getState();
      const b = region.bbox;
      patchStatus({
        phase: status.phase === 'idle' ? 'loading' : status.phase,
        lastAttemptAt: Date.now(),
        requestsMade: status.requestsMade + 1,
        nextPollAt: null,
      });

      try {
        const qs = new URLSearchParams({
          lamin: String(b.lamin),
          lomin: String(b.lomin),
          lamax: String(b.lamax),
          lomax: String(b.lomax),
        });
        if (simulate) qs.set('simulate', simulate);
        const res = await fetch(`/api/states?${qs}`, { signal: controller.signal, cache: 'no-store' });
        const body = await res.json().catch(() => null);
        if (id !== seq || disposed) return; // superseded by a newer request
        if (!res.ok || !body || !Array.isArray(body.states)) {
          const err = new Error(body?.error ?? `Proxy returned HTTP ${res.status}`) as Error & { retryAfter?: number };
          err.retryAfter = body?.retryAfterSec ?? Number(res.headers.get('retry-after')) ?? undefined;
          throw err;
        }
        store.getState().ingest(body as StatesResponse, Date.now());
        schedule(intervalAfterSuccess());
      } catch (e) {
        if (id !== seq || disposed) return;
        const err = e as Error & { retryAfter?: number };
        const s = store.getState();
        const failures = s.status.consecutiveFailures + 1;
        const aborted = err.name === 'AbortError';
        const backoff = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** (failures - 1));
        const wait = Math.max(backoff, (err.retryAfter || 0) * 1000) * (0.85 + Math.random() * 0.3);
        s.patchStatus({
          phase: s.tracks.size ? 'degraded' : 'error',
          consecutiveFailures: failures,
          lastError: aborted ? 'Request timed out' : err.message || 'Network error',
        });
        schedule(wait);
      } finally {
        clearTimeout(timeout);
      }
    }

    const resume = () => {
      if (!blocked() && !disposed) {
        // Only fetch immediately if the data is older than the planned interval.
        const s = store.getState();
        const age = s.status.lastAttemptAt ? Date.now() - s.status.lastAttemptAt : Infinity;
        schedule(Math.max(0, intervalAfterSuccess() - age));
      }
    };

    let regionTimer: ReturnType<typeof setTimeout> | null = null;
    const unsub = store.subscribe((s, prev) => {
      if (s.region !== prev.region) {
        controller?.abort();
        seq++;
        if (regionTimer) clearTimeout(regionTimer);
        regionTimer = setTimeout(() => schedule(0), REGION_DEBOUNCE_MS);
      } else if (
        (s.offlineMode !== prev.offlineMode || s.replay.active !== prev.replay.active || s.hydrated !== prev.hydrated) &&
        !blocked()
      ) {
        schedule(s.hydrated !== prev.hydrated ? 0 : 300);
      } else if (s.refreshToken !== prev.refreshToken && !blocked()) {
        schedule(0);
      } else if (s.pollMode !== prev.pollMode) {
        resume();
      }
    });

    const onVisibility = () => document.visibilityState === 'visible' && resume();
    const onOnline = () => schedule(0);
    const onOffline = () => {
      controller?.abort();
      store.getState().patchStatus({ phase: 'offline', nextPollAt: null });
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    if (store.getState().hydrated) schedule(0);

    return () => {
      disposed = true;
      unsub();
      controller?.abort();
      if (timer) clearTimeout(timer);
      if (regionTimer) clearTimeout(regionTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);
}
