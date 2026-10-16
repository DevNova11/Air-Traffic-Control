'use client';

import { useNow } from '@/hooks/useNow';
import { fmtAge } from '@/lib/format';
import { selectFilteredTracks, useTraffic, type PollMode } from '@/store/traffic';

const PHASE_LABEL: Record<string, string> = {
  idle: 'Starting',
  loading: 'Connecting',
  live: 'Live',
  degraded: 'Degraded',
  error: 'No data',
  offline: 'Offline',
};

const SOURCE_LABEL: Record<string, string> = {
  live: 'OpenSky (live)',
  cache: 'OpenSky (proxy cache)',
  'stale-cache': 'Stale cache',
  recorded: 'Recorded data',
  'offline-cache': 'Saved session',
};

const POLL_OPTIONS: { value: PollMode; label: string }[] = [
  { value: 'auto', label: 'Auto (budget)' },
  { value: 10_000, label: '10 s' },
  { value: 30_000, label: '30 s' },
  { value: 60_000, label: '1 min' },
  { value: 300_000, label: '5 min' },
];

export default function StatusBar() {
  const now = useNow(1000);
  const status = useTraffic((s) => s.status);
  const total = useTraffic((s) => s.tracks.size);
  const shown = useTraffic((s) => selectFilteredTracks(s).length);
  const pollMode = useTraffic((s) => s.pollMode);
  const offlineMode = useTraffic((s) => s.offlineMode);
  const replay = useTraffic((s) => s.replay.active);
  const { setPollMode, setOfflineMode, requestRefresh } = useTraffic.getState();

  const age = status.lastSuccessAt ? (now - status.lastSuccessAt) / 1000 : null;
  const next = status.nextPollAt ? Math.max(0, (status.nextPollAt - now) / 1000) : null;
  const phase = offlineMode ? 'offline' : status.phase;
  const message = status.lastError ?? status.warning;
  const effectiveInterval = pollMode === 'auto' ? status.suggestedIntervalMs : pollMode;
  const dailyCredits =
    effectiveInterval && status.creditCost ? Math.round((86_400_000 / effectiveInterval) * status.creditCost) : null;

  return (
    <header className="statusbar">
      <div className="brand">
        <span className="brand-mark">✈</span> Airspace Monitor
      </div>

      <div className={`pill pill-${phase}`} title={status.lastError ?? undefined}>
        <span className="dot" />
        {replay ? 'Replay' : PHASE_LABEL[phase]}
      </div>

      <div className="stat">
        <span className="stat-label">Source</span>
        <span>{status.source ? SOURCE_LABEL[status.source] : '—'}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Updated</span>
        <span>{age === null ? '—' : `${fmtAge(age)} ago`}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Next poll</span>
        <span>{next === null ? (offlineMode || replay ? 'paused' : '—') : fmtAge(next)}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Aircraft</span>
        <span>
          {shown === total ? total : `${shown} / ${total}`}
          {status.lastDiff && (
            <span className="diff">
              {' '}+{status.lastDiff.entered} −{status.lastDiff.left + status.lastDiff.lost}
            </span>
          )}
        </span>
      </div>
      <div
        className="stat"
        title={
          dailyCredits !== null
            ? `At this interval and region cost (${status.creditCost} credit/request) polling uses ~${dailyCredits} credits/day. Anonymous: 400/day, registered: 4000/day.`
            : undefined
        }
      >
        <span className="stat-label">Credits left</span>
        <span>
          {status.rateLimitRemaining ?? '—'}
          {status.creditCost ? <span className="muted"> · {status.creditCost}/req</span> : null}
        </span>
      </div>

      <div className="statusbar-spacer" />

      {message && <div className={`banner ${status.lastError ? 'banner-error' : 'banner-warn'}`}>{message}</div>}

      <label className="control">
        <span className="stat-label">Poll</span>
        <select
          value={String(pollMode)}
          onChange={(e) => setPollMode(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
        >
          {POLL_OPTIONS.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
              {o.value === 'auto' && status.suggestedIntervalMs ? ` · ${fmtAge(status.suggestedIntervalMs / 1000)}` : ''}
            </option>
          ))}
        </select>
      </label>
      <button className="btn" onClick={requestRefresh} disabled={offlineMode || replay} title="Fetch now (served from the proxy cache if fresh)">
        ↻
      </button>
      <label className="toggle" title="Stop network requests and work from saved / recorded data">
        <input type="checkbox" checked={offlineMode} onChange={(e) => setOfflineMode(e.target.checked)} />
        Offline
      </label>
    </header>
  );
}
