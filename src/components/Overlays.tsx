'use client';

import { useEffect, useState } from 'react';
import { ALT_BANDS, GROUND_COLOR } from '@/lib/format';
import type { AlertEvent } from '@/lib/types';
import { useTraffic } from '@/store/traffic';

export function Legend() {
  return (
    <div className="legend">
      <div className="legend-title">Altitude (ft)</div>
      <div className="legend-row">
        <span className="swatch" style={{ background: GROUND_COLOR }} /> Ground
      </div>
      {ALT_BANDS.map((b) => (
        <div key={b.label} className="legend-row">
          <span className="swatch" style={{ background: b.color }} /> {b.label}
        </div>
      ))}
      <div className="legend-row">
        <span className="swatch hollow" /> Stale
      </div>
    </div>
  );
}

/** Shows the newest alert for a few seconds. */
export function AlertToast() {
  const events = useTraffic((s) => s.alertEvents);
  const [shown, setShown] = useState<AlertEvent | null>(null);

  useEffect(() => {
    if (!events.length) return;
    setShown(events[0]);
    const id = setTimeout(() => setShown(null), 6000);
    return () => clearTimeout(id);
  }, [events]);

  if (!shown) return null;
  return (
    <button className="toast" onClick={() => useTraffic.getState().select(shown.icao24)}>
      <b>Alert</b> {shown.callsign ?? shown.icao24} {shown.message}
    </button>
  );
}

/** Empty / error state over the map when there is nothing to show. */
export function MapNotice() {
  const phase = useTraffic((s) => s.status.phase);
  const error = useTraffic((s) => s.status.lastError);
  const count = useTraffic((s) => s.tracks.size);
  const replay = useTraffic((s) => s.replay.active);
  if (count > 0 || replay) return null;
  if (phase === 'idle' || phase === 'loading') return <div className="map-notice">Loading aircraft…</div>;
  if (phase === 'error' || phase === 'offline')
    return (
      <div className="map-notice">
        {phase === 'offline' ? 'Offline and no saved data for this region.' : `Could not load aircraft: ${error}`}
        <br />
        <span className="muted">Retrying automatically.</span>
      </div>
    );
  if (phase === 'live' || phase === 'degraded') return <div className="map-notice">No aircraft in this region right now.</div>;
  return null;
}
