'use client';

import { useEffect, useState } from 'react';
import { useNow } from '@/hooks/useNow';
import { fmtAge } from '@/lib/format';
import type { AlertEvent } from '@/lib/types';
import { selectFilteredTracks, useTraffic, type PollMode } from '@/store/traffic';
import { Icon, Select, Switch } from './ui';

const PHASE_LABEL: Record<string, string> = {
  idle: 'Starting',
  loading: 'Connecting',
  live: 'Live',
  degraded: 'Degraded',
  error: 'No Data',
  offline: 'Offline',
};

const SOURCE_LABEL: Record<string, string> = {
  live: 'OpenSky',
  cache: 'OpenSky · cached',
  'stale-cache': 'Stale cache',
  recorded: 'Recording',
  'offline-cache': 'Saved session',
};

const POLL_OPTIONS: { value: PollMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 10_000, label: 'Every 10 s' },
  { value: 30_000, label: 'Every 30 s' },
  { value: 60_000, label: 'Every minute' },
  { value: 300_000, label: 'Every 5 min' },
];

/** Floating toolbar: app title, connection status, key metrics and controls. */
export default function Toolbar() {
  const now = useNow(1000);
  const status = useTraffic((s) => s.status);
  const total = useTraffic((s) => s.tracks.size);
  const shown = useTraffic((s) => selectFilteredTracks(s).length);
  const pollMode = useTraffic((s) => s.pollMode);
  const offlineMode = useTraffic((s) => s.offlineMode);
  const replay = useTraffic((s) => s.replay.active);
  const sidebarOpen = useTraffic((s) => s.sidebarOpen);
  const { setPollMode, setOfflineMode, requestRefresh, setSidebarOpen } = useTraffic.getState();

  const age = status.lastSuccessAt ? (now - status.lastSuccessAt) / 1000 : null;
  const next = status.nextPollAt ? Math.max(0, (status.nextPollAt - now) / 1000) : null;
  const phase = replay ? 'replay' : offlineMode ? 'offline' : status.phase;
  const effectiveInterval = pollMode === 'auto' ? status.suggestedIntervalMs : pollMode;
  const dailyCredits =
    effectiveInterval && status.creditCost ? Math.round((86_400_000 / effectiveInterval) * status.creditCost) : null;
  const diff = status.lastDiff;

  return (
    <header className="toolbar glass">
      <button
        className="icon-button"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
      >
        <Icon name="sidebar" size={20} />
      </button>

      <div className="toolbar-title">
        <span className="app-icon">
          <Icon name="airplane" size={17} />
        </span>
        <span className="title-text">Airspace</span>
      </div>

      <span className={`status status-${phase}`} title={status.lastError ?? undefined}>
        <span className="dot" />
        {phase === 'replay' ? 'Replay' : PHASE_LABEL[phase]}
      </span>

      <div className="metrics">
        <div className="metric">
          <span className="metric-label">Aircraft</span>
          <span className="metric-value">
            {shown === total ? total.toLocaleString() : `${shown.toLocaleString()} of ${total.toLocaleString()}`}
            {diff && (diff.entered > 0 || diff.left + diff.lost > 0) && (
              <span className="delta">
                +{diff.entered} −{diff.left + diff.lost}
              </span>
            )}
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">Updated</span>
          <span className="metric-value">{age === null ? '—' : `${fmtAge(age)} ago`}</span>
        </div>
        <div className="metric">
          <span className="metric-label">Next</span>
          <span className="metric-value">{next === null ? (offlineMode || replay ? 'Paused' : '—') : `in ${fmtAge(next)}`}</span>
        </div>
        <div className="metric optional">
          <span className="metric-label">Source</span>
          <span className="metric-value">{status.source ? SOURCE_LABEL[status.source] : '—'}</span>
        </div>
        <div
          className="metric optional"
          title={
            dailyCredits !== null
              ? `${status.creditCost} credit(s) per request. At this interval polling uses about ${dailyCredits} credits per day (anonymous limit 400, registered 4,000).`
              : undefined
          }
        >
          <span className="metric-label">Credits</span>
          <span className="metric-value">{status.rateLimitRemaining ?? '—'}</span>
        </div>
      </div>

      <div className="spacer" />

      <label className="toolbar-control poll" title="How often to ask for new positions">
        <span className="label">Update</span>
        <Select
          className="tinted compact"
          value={String(pollMode)}
          onChange={(e) => setPollMode(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
        >
          {POLL_OPTIONS.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
              {o.value === 'auto' && status.suggestedIntervalMs ? ` (${fmtAge(status.suggestedIntervalMs / 1000)})` : ''}
            </option>
          ))}
        </Select>
      </label>

      <button
        className="icon-button"
        onClick={requestRefresh}
        disabled={offlineMode || replay}
        aria-label="Refresh now"
        title="Refresh now"
      >
        <Icon name="refresh" size={19} />
      </button>

      <div className="toolbar-control" title="Stop network requests and use saved or recorded data">
        <span className="label">Offline</span>
        <Switch checked={offlineMode} onChange={setOfflineMode} label="Offline mode" />
      </div>
    </header>
  );
}

/** Transient notifications below the toolbar: data warnings, errors and the newest alert. */
export function Notices() {
  const error = useTraffic((s) => s.status.lastError);
  const warning = useTraffic((s) => s.status.warning);
  const events = useTraffic((s) => s.alertEvents);
  const [alert, setAlert] = useState<AlertEvent | null>(null);

  useEffect(() => {
    if (!events.length) return;
    setAlert(events[0]);
    const id = setTimeout(() => setAlert(null), 6000);
    return () => clearTimeout(id);
  }, [events]);

  const message = error ?? warning;
  if (!message && !alert) return null;

  return (
    <div className="notices" aria-live="polite">
      {message && (
        <div className={`notice glass ${error ? 'error' : ''}`}>
          <Icon name="warning" size={17} />
          <span>{message}</span>
        </div>
      )}
      {alert && (
        <button className="notice glass alert" onClick={() => useTraffic.getState().select(alert.icao24)}>
          <Icon name="bell" size={17} />
          <span>
            <b>{alert.callsign ?? alert.icao24.toUpperCase()}</b> {alert.message}
          </span>
        </button>
      )}
    </div>
  );
}
