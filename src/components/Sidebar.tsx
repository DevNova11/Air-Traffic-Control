'use client';

import { useMemo, useState } from 'react';
import { ALERT_KINDS } from '@/lib/alerts';
import { altColor, fmtAlt, fmtClock, fmtSpeed, POSITION_SOURCES } from '@/lib/format';
import { bboxArea, creditCost, isValidBBox, REGIONS, sameBBox } from '@/lib/geo';
import { currentViewBBox } from '@/lib/mapView';
import { trackAltitudeM } from '@/lib/tracks';
import type { AlertKind, AlertRule, BBox, Track } from '@/lib/types';
import { selectFilteredTracks, useTraffic } from '@/store/traffic';

type Tab = 'region' | 'filters' | 'aircraft' | 'alerts';

export default function Sidebar() {
  const [tab, setTab] = useState<Tab>('aircraft');
  const [open, setOpen] = useState(true);
  const unread = useTraffic((s) => s.unreadAlerts);

  return (
    <aside className={`sidebar ${open ? '' : 'collapsed'}`}>
      <button className="sidebar-toggle" onClick={() => setOpen(!open)} aria-label="Toggle sidebar">
        {open ? '‹' : '›'}
      </button>
      {open && (
        <>
          <nav className="tabs">
            {(['region', 'filters', 'aircraft', 'alerts'] as Tab[]).map((t) => (
              <button
                key={t}
                className={`tab ${tab === t ? 'active' : ''}`}
                onClick={() => {
                  setTab(t);
                  if (t === 'alerts') useTraffic.getState().markAlertsRead();
                }}
              >
                {t[0].toUpperCase() + t.slice(1)}
                {t === 'alerts' && unread > 0 && <span className="badge">{unread}</span>}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {tab === 'region' && <RegionTab />}
            {tab === 'filters' && <FiltersTab />}
            {tab === 'aircraft' && <AircraftTab />}
            {tab === 'alerts' && <AlertsTab />}
          </div>
        </>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------

function RegionTab() {
  const region = useTraffic((s) => s.region);
  const setRegion = useTraffic((s) => s.setRegion);
  const [custom, setCustom] = useState<BBox>(region.bbox);
  const [error, setError] = useState<string | null>(null);

  const applyCustom = (b: BBox, name = 'Custom area') => {
    if (!isValidBBox(b)) {
      setError('Invalid bounds: latitude −90…90, longitude −180…180, min < max.');
      return;
    }
    setError(null);
    setCustom(b);
    setRegion({ id: `custom-${Date.now()}`, name, bbox: b });
  };

  return (
    <div className="stack">
      <p className="hint">
        Only aircraft inside the monitored region are requested. Larger regions cost more OpenSky credits per
        request.
      </p>
      <div className="region-list">
        {REGIONS.map((r) => (
          <button
            key={r.id}
            className={`region-btn ${sameBBox(r.bbox, region.bbox) ? 'active' : ''}`}
            onClick={() => {
              setCustom(r.bbox);
              setRegion(r);
            }}
          >
            <span>{r.name}</span>
            <span className="muted">{creditCost(r.bbox)} cr</span>
          </button>
        ))}
      </div>

      <button
        className="btn wide"
        onClick={() => {
          const b = currentViewBBox();
          if (b) applyCustom(b, 'Map view');
        }}
      >
        Monitor current map view
      </button>

      <fieldset className="fieldset">
        <legend>Custom bounds</legend>
        <div className="grid2">
          {(['lamin', 'lamax', 'lomin', 'lomax'] as const).map((k) => (
            <label key={k} className="field">
              <span>{{ lamin: 'Lat min', lamax: 'Lat max', lomin: 'Lon min', lomax: 'Lon max' }[k]}</span>
              <input
                type="number"
                step="0.1"
                value={custom[k]}
                onChange={(e) => setCustom({ ...custom, [k]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>
        <button className="btn wide" onClick={() => applyCustom(custom)}>
          Apply bounds
        </button>
        {error && <p className="error-text">{error}</p>}
      </fieldset>

      <SimulateControl />

      <div className="kv">
        <span>Monitoring</span>
        <b>{region.name}</b>
        <span>Area</span>
        <b>{Math.round(bboxArea(region.bbox))} sq°</b>
        <span>Cost</span>
        <b>{creditCost(region.bbox)} credit(s) / request</b>
      </div>
    </div>
  );
}

function SimulateControl() {
  const simulate = useTraffic((s) => s.simulate);
  return (
    <fieldset className="fieldset">
      <legend>Resilience testing</legend>
      <select
        value={simulate}
        onChange={(e) => useTraffic.getState().setSimulate(e.target.value as typeof simulate)}
      >
        <option value="">Normal operation</option>
        <option value="outage">Simulate OpenSky outage</option>
        <option value="ratelimit">Simulate rate limit (429)</option>
        <option value="recorded">Serve recorded data</option>
        <option value="down">Simulate proxy failure</option>
      </select>
      <p className="hint">Injected at the proxy; no OpenSky credits are spent while active.</p>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------

function numOrNull(v: string): number | null {
  return v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v);
}

function FiltersTab() {
  const filters = useTraffic((s) => s.filters);
  const tracks = useTraffic((s) => s.tracks);
  const { setFilters, resetFilters } = useTraffic.getState();
  const countries = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tracks.values()) m.set(t.latest.originCountry, (m.get(t.latest.originCountry) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [tracks]);

  return (
    <div className="stack">
      <label className="field">
        <span>Search callsign / ICAO24 / squawk</span>
        <input value={filters.query} placeholder="e.g. SWR, 4b1814, 7700" onChange={(e) => setFilters({ query: e.target.value })} />
      </label>
      <label className="field">
        <span>Origin country</span>
        <select value={filters.country} onChange={(e) => setFilters({ country: e.target.value })}>
          <option value="">All countries</option>
          {countries.map(([c, n]) => (
            <option key={c} value={c}>
              {c} ({n})
            </option>
          ))}
        </select>
      </label>
      <div className="grid2">
        <label className="field">
          <span>Min altitude (ft)</span>
          <input type="number" value={filters.minAltFt ?? ''} onChange={(e) => setFilters({ minAltFt: numOrNull(e.target.value) })} />
        </label>
        <label className="field">
          <span>Max altitude (ft)</span>
          <input type="number" value={filters.maxAltFt ?? ''} onChange={(e) => setFilters({ maxAltFt: numOrNull(e.target.value) })} />
        </label>
        <label className="field">
          <span>Min speed (kt)</span>
          <input type="number" value={filters.minSpeedKt ?? ''} onChange={(e) => setFilters({ minSpeedKt: numOrNull(e.target.value) })} />
        </label>
        <label className="field">
          <span>Max speed (kt)</span>
          <input type="number" value={filters.maxSpeedKt ?? ''} onChange={(e) => setFilters({ maxSpeedKt: numOrNull(e.target.value) })} />
        </label>
      </div>
      <label className="field">
        <span>Position source</span>
        <select value={filters.positionSource} onChange={(e) => setFilters({ positionSource: Number(e.target.value) })}>
          <option value={-1}>Any</option>
          {POSITION_SOURCES.map((p, i) => (
            <option key={p} value={i}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={filters.showOnGround} onChange={(e) => setFilters({ showOnGround: e.target.checked })} />
        Show aircraft on ground
      </label>
      <label className="toggle">
        <input type="checkbox" checked={filters.showStale} onChange={(e) => setFilters({ showStale: e.target.checked })} />
        Show stale / temporarily lost aircraft
      </label>
      <TrailsToggle />
      <button className="btn wide" onClick={resetFilters}>
        Reset filters
      </button>
    </div>
  );
}

function TrailsToggle() {
  const showTrails = useTraffic((s) => s.showTrails);
  return (
    <label className="toggle">
      <input type="checkbox" checked={showTrails} onChange={(e) => useTraffic.getState().setShowTrails(e.target.checked)} />
      Show short trails for all aircraft
    </label>
  );
}

// ---------------------------------------------------------------------------

type SortKey = 'callsign' | 'altitude' | 'speed' | 'seen';
const LIST_LIMIT = 300;

function AircraftTab() {
  const tracks = useTraffic((s) => s.tracks);
  const filters = useTraffic((s) => s.filters);
  const selectedId = useTraffic((s) => s.selectedId);
  const [sort, setSort] = useState<SortKey>('callsign');

  const rows = useMemo(() => {
    const list = selectFilteredTracks({ tracks, filters }).slice();
    const key: Record<SortKey, (t: Track) => number | string> = {
      callsign: (t) => t.latest.callsign ?? `~${t.icao24}`,
      altitude: (t) => -(trackAltitudeM(t.latest) ?? -1),
      speed: (t) => -(t.latest.velocity ?? -1),
      seen: (t) => -t.lastPositionTime,
    };
    const f = key[sort];
    list.sort((a, b) => {
      const x = f(a);
      const y = f(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return list;
  }, [tracks, filters, sort]);

  return (
    <div className="stack fill">
      <div className="row between">
        <span className="muted">
          {rows.length > LIST_LIMIT ? `Showing ${LIST_LIMIT} of ${rows.length}` : `${rows.length} aircraft`}
        </span>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="callsign">Callsign</option>
          <option value="altitude">Altitude</option>
          <option value="speed">Speed</option>
          <option value="seen">Recently updated</option>
        </select>
      </div>
      <ul className="ac-list">
        {rows.slice(0, LIST_LIMIT).map((t) => (
          <li
            key={t.icao24}
            className={`ac-row ${t.icao24 === selectedId ? 'selected' : ''} ${t.status}`}
            onClick={() => useTraffic.getState().select(t.icao24)}
          >
            <span className="swatch" style={{ background: altColor(trackAltitudeM(t.latest), t.latest.onGround) }} />
            <span className="ac-call">{t.latest.callsign ?? t.icao24}</span>
            <span className="ac-alt">{fmtAlt(trackAltitudeM(t.latest), t.latest.onGround)}</span>
            <span className="ac-spd">{fmtSpeed(t.latest.velocity)}</span>
            {t.status === 'stale' && <span className="tag">stale</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AlertsTab() {
  const rules = useTraffic((s) => s.alertRules);
  const events = useTraffic((s) => s.alertEvents);
  const { setAlertRules, clearAlerts, select } = useTraffic.getState();
  const [kind, setKind] = useState<AlertKind>('altitude-below');
  const [value, setValue] = useState('1000');

  const update = (id: string, p: Partial<AlertRule>) => setAlertRules(rules.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const meta = (k: AlertKind) => ALERT_KINDS.find((a) => a.kind === k)!;

  const add = () => {
    const rule: AlertRule = { id: `r-${Date.now()}`, kind, enabled: true, value: Number(value) || 0 };
    if (kind === 'enter-zone') {
      const zone = currentViewBBox();
      if (!zone) return;
      rule.zone = zone;
      rule.label = `Zone ${rules.filter((r) => r.kind === 'enter-zone').length + 1}`;
    }
    setAlertRules([...rules, rule]);
  };

  return (
    <div className="stack fill">
      <p className="hint">Alerts are checked on every update and fire once when an aircraft starts matching a rule.</p>
      <ul className="rule-list">
        {rules.map((r) => (
          <li key={r.id} className="rule">
            <input type="checkbox" checked={r.enabled} onChange={(e) => update(r.id, { enabled: e.target.checked })} />
            <span className="rule-label">{r.kind === 'enter-zone' ? `Enters ${r.label}` : meta(r.kind).label}</span>
            {meta(r.kind).needsValue && (
              <input
                className="rule-value"
                type="number"
                value={r.value}
                onChange={(e) => update(r.id, { value: Number(e.target.value) })}
              />
            )}
            <span className="muted">{meta(r.kind).unit}</span>
            <button className="icon-btn" onClick={() => setAlertRules(rules.filter((x) => x.id !== r.id))} aria-label="Remove rule">
              ×
            </button>
          </li>
        ))}
      </ul>
      <fieldset className="fieldset">
        <legend>New rule</legend>
        <select value={kind} onChange={(e) => setKind(e.target.value as AlertKind)}>
          {ALERT_KINDS.map((a) => (
            <option key={a.kind} value={a.kind}>
              {a.label}
            </option>
          ))}
        </select>
        {meta(kind).needsValue && (
          <label className="field">
            <span>Threshold ({meta(kind).unit})</span>
            <input type="number" value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
        )}
        {kind === 'enter-zone' && <p className="hint">The zone is the current map view. Zoom to the area first.</p>}
        <button className="btn wide" onClick={add}>
          Add rule
        </button>
      </fieldset>

      <div className="row between">
        <b>Events</b>
        {events.length > 0 && (
          <button className="link-btn" onClick={clearAlerts}>
            Clear
          </button>
        )}
      </div>
      <ul className="event-list">
        {events.length === 0 && <li className="muted">No alerts yet.</li>}
        {events.map((e) => (
          <li key={e.id} className="event" onClick={() => select(e.icao24)}>
            <span className="muted">{fmtClock(e.at)}</span> <b>{e.callsign ?? e.icao24}</b> {e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

