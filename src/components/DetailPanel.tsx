'use client';

import { useNow } from '@/hooks/useNow';
import {
  CATEGORIES,
  fmtAge,
  fmtAlt,
  fmtClock,
  fmtCoord,
  fmtHeading,
  fmtSpeed,
  fmtVRate,
  POSITION_SOURCES,
} from '@/lib/format';
import { M_TO_FT, MS_TO_KT } from '@/lib/geo';
import { estimatePosition, trackAltitudeM } from '@/lib/tracks';
import type { Observation } from '@/lib/types';
import { dataNowSec, useTraffic } from '@/store/traffic';

function Sparkline({ data, label, unit, color }: { data: (number | null)[]; label: string; unit: string; color: string }) {
  const vals = data.filter((v): v is number => v !== null);
  if (vals.length < 2) return <div className="spark-empty">{label}: not enough observations yet</div>;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const W = 260;
  const H = 44;
  const pts = data
    .map((v, i) => (v === null ? null : `${((i / (data.length - 1)) * W).toFixed(1)},${(H - 4 - ((v - min) / span) * (H - 8)).toFixed(1)}`))
    .filter(Boolean)
    .join(' ');
  return (
    <div className="spark">
      <div className="row between">
        <span className="muted">{label}</span>
        <span className="muted">
          {Math.round(min).toLocaleString()}–{Math.round(max).toLocaleString()} {unit}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

export default function DetailPanel() {
  const now = useNow(1000);
  const id = useTraffic((s) => s.selectedId);
  const track = useTraffic((s) => (s.selectedId ? s.tracks.get(s.selectedId) : undefined));
  const follow = useTraffic((s) => s.follow);
  const offset = useTraffic((s) => s.clockOffsetSec);
  const { select, setFollow } = useTraffic.getState();

  if (!id) return null;

  if (!track) {
    return (
      <section className="detail">
        <div className="detail-head">
          <h2>{id}</h2>
          <button className="icon-btn" onClick={() => select(null)} aria-label="Close">
            ×
          </button>
        </div>
        <p className="hint">This aircraft is no longer tracked — it left the monitored region or stopped reporting.</p>
      </section>
    );
  }

  const s = track.latest;
  const nowSec = now / 1000 + offset;
  const posAge = nowSec - track.lastPositionTime;
  const contactAge = nowSec - s.lastContact;
  const [elat, elon, extrap] = estimatePosition(track, dataNowSec({ clockOffsetSec: offset }));
  const h: Observation[] = track.history;
  const carried = new Set(track.carried);
  const lk = (f: string) => (carried.has(f) ? <span className="tag" title="Missing in the latest update — last known value">last known</span> : null);

  return (
    <section className="detail">
      <div className="detail-head">
        <div>
          <h2>{s.callsign ?? s.icao24.toUpperCase()}</h2>
          <div className="muted">
            {s.icao24} · {s.originCountry}
            {s.category !== null && s.category > 1 ? ` · ${CATEGORIES[s.category]}` : ''}
          </div>
        </div>
        <button className="icon-btn" onClick={() => select(null)} aria-label="Close">
          ×
        </button>
      </div>

      <div className="row gap">
        <span className={`tag tag-${track.status}`}>{track.status === 'active' ? 'Active' : 'Stale'}</span>
        {track.missedPolls > 0 && <span className="tag tag-stale">missing from {track.missedPolls} update(s)</span>}
        {s.squawk && ['7500', '7600', '7700'].includes(s.squawk) && <span className="tag tag-alert">EMERGENCY {s.squawk}</span>}
      </div>

      <div className="kv">
        <span>Altitude (baro)</span>
        <b>
          {fmtAlt(s.baroAltitude, s.onGround)} {lk('baroAltitude')}
        </b>
        <span>Altitude (geo)</span>
        <b>{fmtAlt(s.geoAltitude)}</b>
        <span>Ground speed</span>
        <b>
          {fmtSpeed(s.velocity)} {lk('velocity')}
        </b>
        <span>Heading</span>
        <b>
          {fmtHeading(s.trueTrack)} {lk('trueTrack')}
        </b>
        <span>Vertical rate</span>
        <b>{fmtVRate(s.verticalRate)}</b>
        <span>Squawk</span>
        <b>{s.squawk ?? '—'}</b>
        <span>Last position</span>
        <b>{fmtCoord(s.lat, s.lon)}</b>
        <span>Position age</span>
        <b className={posAge > 30 ? 'warn-text' : ''}>{fmtAge(posAge)}</b>
        <span>Last contact</span>
        <b>{fmtAge(contactAge)} ago</b>
        <span>Estimated now</span>
        <b>{extrap > 0 ? `${fmtCoord(elat, elon)} (+${Math.round(extrap)}s)` : 'not extrapolated'}</b>
        <span>Source</span>
        <b>{POSITION_SOURCES[s.positionSource] ?? s.positionSource}</b>
        <span>Tracked since</span>
        <b>{fmtClock(track.firstSeen)}</b>
      </div>

      <h3>Recent movement · {h.length} observations</h3>
      {h.length > 1 && (
        <p className="muted small">
          {fmtClock((h[0].t - offset) * 1000)} → {fmtClock((h[h.length - 1].t - offset) * 1000)} (
          {fmtAge(h[h.length - 1].t - h[0].t)})
        </p>
      )}
      <Sparkline label="Altitude" unit="ft" color="#f472b6" data={h.map((o) => (o.alt === null ? null : o.alt * M_TO_FT))} />
      <Sparkline label="Speed" unit="kt" color="#38bdf8" data={h.map((o) => (o.vel === null ? null : o.vel * MS_TO_KT))} />

      <div className="obs-table">
        {h
          .slice(-6)
          .reverse()
          .map((o) => (
            <div key={o.t} className="obs-row">
              <span>{fmtClock((o.t - offset) * 1000)}</span>
              <span>{fmtAlt(o.alt, o.onGround)}</span>
              <span>{fmtSpeed(o.vel)}</span>
              <span>{fmtHeading(o.track)}</span>
            </div>
          ))}
      </div>

      <label className="toggle">
        <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
        Follow on map
      </label>
      <p className="hint small">
        The solid line on the map is the observed track; the dashed segment is the dead-reckoned estimate since the last
        report. Alt: {fmtAlt(trackAltitudeM(s), s.onGround)}.
      </p>
    </section>
  );
}
