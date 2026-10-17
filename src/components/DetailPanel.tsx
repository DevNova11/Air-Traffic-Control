'use client';

import { useNow } from '@/hooks/useNow';
import {
  altColor,
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
import { Group, Icon, Row, Switch } from './ui';

function Chart({ data, label, unit, color }: { data: (number | null)[]; label: string; unit: string; color: string }) {
  const vals = data.filter((v): v is number => v !== null);
  if (vals.length < 2) {
    return (
      <div className="chart">
        <div className="chart-head">
          <span>{label}</span>
          <span>Waiting for more updates</span>
        </div>
      </div>
    );
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const W = 300;
  const H = 48;
  const pts: [number, number][] = [];
  data.forEach((v, i) => {
    if (v !== null) pts.push([(i / (data.length - 1)) * W, H - 4 - ((v - min) / span) * (H - 8)]);
  });
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `0,${H} ${line} ${W},${H}`;
  const id = `g-${label}`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <div className="chart">
      <div className="chart-head">
        <span>{label}</span>
        <span>
          {Math.round(min).toLocaleString()}–{Math.round(max).toLocaleString()} {unit}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.28" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#${id})`} />
        <polyline points={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <circle cx={lx} cy={ly} r="3" fill={color} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function Tile({ label, value, unit, warn }: { label: string; value: string; unit?: string; warn?: boolean }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className={`tile-value ${warn ? 'warn' : ''}`}>
        {value}
        {unit && <span className="tile-unit">{unit}</span>}
      </div>
    </div>
  );
}

/** Split "25,900 ft" into ["25,900", "ft"] for the stat tiles. */
const split = (s: string): [string, string | undefined] => {
  const i = s.lastIndexOf(' ');
  return i > 0 && !/^\d/.test(s.slice(i + 1)) ? [s.slice(0, i), s.slice(i + 1)] : [s, undefined];
};

/** Place card for the selected aircraft, modelled on Apple Maps. */
export default function DetailPanel() {
  const now = useNow(1000);
  const id = useTraffic((s) => s.selectedId);
  const track = useTraffic((s) => (s.selectedId ? s.tracks.get(s.selectedId) : undefined));
  const follow = useTraffic((s) => s.follow);
  const offset = useTraffic((s) => s.clockOffsetSec);
  const { select, setFollow } = useTraffic.getState();

  if (!id) return null;

  const close = (
    <button className="close-button" onClick={() => select(null)} aria-label="Close">
      <Icon name="close" size={14} />
    </button>
  );

  if (!track) {
    return (
      <section className="detail glass">
        <div className="detail-head">
          <span className="detail-glyph" style={{ background: 'var(--gray)' }}>
            <Icon name="airplane" size={22} />
          </span>
          <div className="detail-title">
            <h2>{id.toUpperCase()}</h2>
            <p>No longer tracked. It left the monitored region or stopped reporting.</p>
          </div>
          {close}
        </div>
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
  const lastKnown = (f: string) => (carried.has(f) ? <span className="chip tiny">last known</span> : null);
  const alt = trackAltitudeM(s);
  const emergency = s.squawk && ['7500', '7600', '7700'].includes(s.squawk);
  const [altV, altU] = split(fmtAlt(alt, s.onGround));
  const [spdV, spdU] = split(fmtSpeed(s.velocity));

  return (
    <section className="detail glass" aria-label={`Details for ${s.callsign ?? s.icao24}`}>
      <div className="detail-head">
        <span className="detail-glyph" style={{ background: altColor(alt, s.onGround) }}>
          <Icon name="airplane" size={22} />
        </span>
        <div className="detail-title">
          <h2>{s.callsign ?? s.icao24.toUpperCase()}</h2>
          <p>
            {s.originCountry}
            {s.category !== null && s.category > 1 ? ` · ${CATEGORIES[s.category]}` : ''} · {s.icao24.toUpperCase()}
          </p>
        </div>
        {close}
      </div>

      <div className="detail-body">
        <div className="chips">
          {track.status === 'active' ? <span className="chip green">Live</span> : <span className="chip orange">Stale</span>}
          {track.missedPolls > 0 && <span className="chip orange">Missing from {track.missedPolls} update{track.missedPolls > 1 ? 's' : ''}</span>}
          {s.onGround && <span className="chip">On ground</span>}
          {emergency && <span className="chip red">Squawk {s.squawk}</span>}
        </div>

        <div className="tiles">
          <Tile label="Altitude" value={altV} unit={altU} />
          <Tile label="Speed" value={spdV} unit={spdU} />
          <Tile label="Heading" value={fmtHeading(s.trueTrack)} />
        </div>

        <Group header="Flight">
          <Row label="Barometric altitude">
            <span className="row-detail">
              {fmtAlt(s.baroAltitude, s.onGround)}
              {lastKnown('baroAltitude')}
            </span>
          </Row>
          <Row label="Geometric altitude" detail={fmtAlt(s.geoAltitude)} />
          <Row label="Vertical rate" detail={fmtVRate(s.verticalRate)} />
          <Row label="Squawk" detail={s.squawk ?? '—'} />
          {(carried.has('velocity') || carried.has('trueTrack')) && (
            <Row label="Speed / heading">
              <span className="row-detail">
                {lastKnown('velocity') ?? lastKnown('trueTrack')}
              </span>
            </Row>
          )}
        </Group>

        <Group header="Position">
          <Row label="Last reported" detail={fmtCoord(s.lat, s.lon)} />
          <Row label="Position age">
            <span className={`row-detail ${posAge > 30 ? 'warn' : ''}`}>{fmtAge(posAge)}</span>
          </Row>
          <Row label="Estimated now" detail={extrap > 0 ? `+${Math.round(extrap)} s` : 'Not extrapolated'} />
          {extrap > 0 && <Row label="" detail={fmtCoord(elat, elon)} />}
          <Row label="Last contact" detail={`${fmtAge(contactAge)} ago`} />
          <Row label="Source" detail={POSITION_SOURCES[s.positionSource] ?? String(s.positionSource)} />
        </Group>

        <Group
          header={`Recent Movement · ${h.length}`}
          footer={
            h.length > 1
              ? `Observed ${fmtClock((h[0].t - offset) * 1000)} – ${fmtClock((h[h.length - 1].t - offset) * 1000)}. The map shows the observed track; the dashed segment is the estimate since the last report.`
              : `Tracked since ${fmtClock(track.firstSeen)}. The track builds up with each update.`
          }
        >
          <Chart label="Altitude" unit="ft" color="#ff375f" data={h.map((o) => (o.alt === null ? null : o.alt * M_TO_FT))} />
          <Chart label="Speed" unit="kt" color="#0a84ff" data={h.map((o) => (o.vel === null ? null : o.vel * MS_TO_KT))} />
        </Group>

        {h.length > 1 && (
          <Group header="Observations">
            {h
              .slice(-6)
              .reverse()
              .map((o) => (
                <Row key={o.t} className="obs-cell">
                  <span>{fmtClock((o.t - offset) * 1000)}</span>
                  <span>{fmtAlt(o.alt, o.onGround)}</span>
                  <span>{fmtSpeed(o.vel)}</span>
                  <span>{fmtHeading(o.track)}</span>
                </Row>
              ))}
          </Group>
        )}

        <Group>
          <Row label="Follow on map">
            <Switch checked={follow} onChange={setFollow} label="Follow on map" />
          </Row>
        </Group>
      </div>
    </section>
  );
}
