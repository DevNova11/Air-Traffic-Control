'use client';

import { ALT_BANDS, GROUND_COLOR } from '@/lib/format';
import { useTraffic } from '@/store/traffic';

export function Legend() {
  return (
    <div className="legend glass" aria-label="Altitude legend (feet)">
      <span className="legend-item">
        <span className="dot" style={{ background: GROUND_COLOR }} /> Gnd
      </span>
      {ALT_BANDS.map((b) => (
        <span key={b.label} className="legend-item">
          <span className="dot" style={{ background: b.color }} /> {b.label}
        </span>
      ))}
      <span className="legend-item">
        <span className="dot hollow" /> Stale
      </span>
    </div>
  );
}

/** Empty / error state over the map when there is nothing to show. */
export function MapNotice() {
  const phase = useTraffic((s) => s.status.phase);
  const error = useTraffic((s) => s.status.lastError);
  const count = useTraffic((s) => s.tracks.size);
  const replay = useTraffic((s) => s.replay.active);
  if (count > 0 || replay) return null;
  if (phase === 'idle' || phase === 'loading')
    return (
      <div className="map-notice glass">
        <span className="spinner" />
        Loading Aircraft
      </div>
    );
  if (phase === 'error' || phase === 'offline')
    return (
      <div className="map-notice glass">
        {phase === 'offline' ? 'Offline' : 'Can’t Load Aircraft'}
        <span className="muted">
          {phase === 'offline' ? 'No saved data for this region.' : `${error ?? 'Unknown error'}. Retrying automatically.`}
        </span>
      </div>
    );
  if (phase === 'live' || phase === 'degraded')
    return (
      <div className="map-notice glass">
        No Aircraft
        <span className="muted">Nothing is flying in this region right now.</span>
      </div>
    );
  return null;
}
