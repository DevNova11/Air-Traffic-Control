'use client';

import { useMemo, useState } from 'react';
import { ALERT_KINDS, RULE_PREFIX } from '@/lib/alerts';
import { altColor, fmtAlt, fmtClock, fmtSpeed, POSITION_SOURCES } from '@/lib/format';
import { bboxArea, creditCost, isValidBBox, REGIONS, sameBBox } from '@/lib/geo';
import { currentViewBBox } from '@/lib/mapView';
import { trackAltitudeM } from '@/lib/tracks';
import type { AlertKind, AlertRule, BBox, Track } from '@/lib/types';
import { selectFilteredTracks, useTraffic } from '@/store/traffic';
import { Group, Icon, Row, Segmented, Select, Switch } from './ui';

type Tab = 'aircraft' | 'region' | 'filters' | 'alerts';

const TITLES: Record<Tab, string> = {
  aircraft: 'Aircraft',
  region: 'Region',
  filters: 'Filters',
  alerts: 'Alerts',
};

export default function Sidebar() {
  const [tab, setTab] = useState<Tab>('aircraft');
  const open = useTraffic((s) => s.sidebarOpen);
  const unread = useTraffic((s) => s.unreadAlerts);

  const choose = (t: Tab) => {
    setTab(t);
    if (t === 'alerts') useTraffic.getState().markAlertsRead();
  };

  return (
    <aside className={`sidebar glass ${open ? '' : 'hidden'}`} aria-hidden={!open}>
      <div className="sidebar-head">
        <h1 className="sidebar-title">{TITLES[tab]}</h1>
        <Segmented<Tab>
          value={tab}
          onChange={choose}
          options={[
            { value: 'aircraft', label: 'Aircraft' },
            { value: 'region', label: 'Region' },
            { value: 'filters', label: 'Filters' },
            {
              value: 'alerts',
              label: (
                <>
                  Alerts
                  {unread > 0 && tab !== 'alerts' && <span className="count-badge">{unread}</span>}
                </>
              ),
            },
          ]}
        />
      </div>
      <div className="sidebar-body">
        {tab === 'aircraft' && <AircraftTab />}
        {tab === 'region' && <RegionTab />}
        {tab === 'filters' && <FiltersTab />}
        {tab === 'alerts' && <AlertsTab />}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------

type SortKey = 'callsign' | 'altitude' | 'speed' | 'seen';
const LIST_LIMIT = 300;

function AircraftTab() {
  const tracks = useTraffic((s) => s.tracks);
  const filters = useTraffic((s) => s.filters);
  const selectedId = useTraffic((s) => s.selectedId);
  const { setFilters, select } = useTraffic.getState();
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
    <>
      <label className="search">
        <Icon name="search" size={16} />
        <input
          value={filters.query}
          placeholder="Callsign, ICAO24 or squawk"
          onChange={(e) => setFilters({ query: e.target.value })}
          aria-label="Search aircraft"
        />
        {filters.query && (
          <button className="clear" onClick={() => setFilters({ query: '' })} aria-label="Clear search">
            <Icon name="close" size={10} />
          </button>
        )}
      </label>

      <div className="list-meta">
        <span>
          {rows.length > LIST_LIMIT ? `${LIST_LIMIT} of ${rows.length.toLocaleString()}` : `${rows.length.toLocaleString()} aircraft`}
        </span>
        <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort by">
          <option value="callsign">Sort by Callsign</option>
          <option value="altitude">Sort by Altitude</option>
          <option value="speed">Sort by Speed</option>
          <option value="seen">Sort by Last Update</option>
        </Select>
      </div>

      {rows.length === 0 ? (
        <div className="group-body empty">No aircraft match.</div>
      ) : (
        <div className="group-body">
          {rows.slice(0, LIST_LIMIT).map((t) => {
            const alt = trackAltitudeM(t.latest);
            const color = altColor(alt, t.latest.onGround);
            return (
              <Row
                key={t.icao24}
                className={`ac-cell ${t.icao24 === selectedId ? 'selected' : ''} ${t.status}`}
                onClick={() => select(t.icao24)}
              >
                <span className="ac-glyph" style={{ background: color, color: t.status === 'stale' ? color : undefined }}>
                  <Icon name="airplane" size={16} className="" />
                </span>
                <span className="ac-main">
                  <span className="ac-title">{t.latest.callsign ?? t.icao24.toUpperCase()}</span>
                  <span className="ac-sub">
                    {t.status === 'stale' ? 'Stale · ' : ''}
                    {t.latest.originCountry}
                  </span>
                </span>
                <span className="ac-side">
                  <span>{fmtAlt(alt, t.latest.onGround)}</span>
                  <span className="ac-side-sub">{fmtSpeed(t.latest.velocity)}</span>
                </span>
              </Row>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function RegionTab() {
  const region = useTraffic((s) => s.region);
  const setRegion = useTraffic((s) => s.setRegion);
  const [custom, setCustom] = useState<BBox>(region.bbox);
  const [error, setError] = useState<string | null>(null);

  const applyCustom = (b: BBox, name = 'Custom Area') => {
    if (!isValidBBox(b)) {
      setError('Latitude must be −90…90, longitude −180…180, and each minimum below its maximum.');
      return;
    }
    setError(null);
    setCustom(b);
    setRegion({ id: `custom-${Date.now()}`, name, bbox: b });
  };

  const isPreset = REGIONS.some((r) => sameBBox(r.bbox, region.bbox));

  return (
    <>
      <Group
        header="Monitored Region"
        footer="Only aircraft inside this region are requested. Larger regions cost more OpenSky credits per request."
      >
        {REGIONS.map((r) => (
          <Row
            key={r.id}
            onClick={() => {
              setCustom(r.bbox);
              setRegion(r);
            }}
          >
            <span className="row-label">{r.name}</span>
            <span className="row-detail">{creditCost(r.bbox)} cr</span>
            <span style={{ width: 18 }}>{sameBBox(r.bbox, region.bbox) && <Icon name="check" size={18} className="check" />}</span>
          </Row>
        ))}
        {!isPreset && (
          <Row>
            <span className="row-label">{region.name}</span>
            <span className="row-detail">{creditCost(region.bbox)} cr</span>
            <Icon name="check" size={18} className="check" />
          </Row>
        )}
      </Group>

      <button
        className="filled-button"
        onClick={() => {
          const b = currentViewBBox();
          if (b) applyCustom(b, 'Map View');
        }}
      >
        <Icon name="location" size={17} />
        Monitor Current Map View
      </button>

      <Group header="Custom Bounds" footer={error ? <span className="error-text">{error}</span> : undefined}>
        {(['lamin', 'lamax', 'lomin', 'lomax'] as const).map((k) => (
          <Row key={k} label={{ lamin: 'Latitude min', lamax: 'Latitude max', lomin: 'Longitude min', lomax: 'Longitude max' }[k]}>
            <input
              type="number"
              step="0.1"
              value={custom[k]}
              onChange={(e) => setCustom({ ...custom, [k]: Number(e.target.value) })}
              aria-label={k}
            />
          </Row>
        ))}
        <Row className="button-cell" onClick={() => applyCustom(custom)}>
          Apply Bounds
        </Row>
      </Group>

      <Group header="Current">
        <Row label="Area" detail={`${Math.round(bboxArea(region.bbox)).toLocaleString()} sq°`} />
        <Row label="Cost per request" detail={`${creditCost(region.bbox)} credit${creditCost(region.bbox) > 1 ? 's' : ''}`} />
      </Group>

      <SimulateGroup />
    </>
  );
}

function SimulateGroup() {
  const simulate = useTraffic((s) => s.simulate);
  return (
    <Group header="Resilience Testing" footer="Injected at the proxy. No OpenSky credits are spent while a simulation is active.">
      <Row label="Mode">
        <Select value={simulate} onChange={(e) => useTraffic.getState().setSimulate(e.target.value as typeof simulate)}>
          <option value="">Normal</option>
          <option value="outage">OpenSky outage</option>
          <option value="ratelimit">Rate limit (429)</option>
          <option value="recorded">Recorded data</option>
          <option value="down">Proxy failure</option>
        </Select>
      </Row>
    </Group>
  );
}

// ---------------------------------------------------------------------------

function numOrNull(v: string): number | null {
  return v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v);
}

function FiltersTab() {
  const filters = useTraffic((s) => s.filters);
  const tracks = useTraffic((s) => s.tracks);
  const showTrails = useTraffic((s) => s.showTrails);
  const { setFilters, resetFilters, setShowTrails } = useTraffic.getState();
  const countries = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tracks.values()) m.set(t.latest.originCountry, (m.get(t.latest.originCountry) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [tracks]);

  const num = (key: 'minAltFt' | 'maxAltFt' | 'minSpeedKt' | 'maxSpeedKt', placeholder: string) => (
    <input
      type="number"
      placeholder={placeholder}
      value={filters[key] ?? ''}
      onChange={(e) => setFilters({ [key]: numOrNull(e.target.value) })}
      aria-label={key}
    />
  );

  return (
    <>
      <Group header="Aircraft">
        <Row label="Country">
          <Select value={filters.country} onChange={(e) => setFilters({ country: e.target.value })}>
            <option value="">All</option>
            {countries.map(([c, n]) => (
              <option key={c} value={c}>
                {c} ({n})
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Position source">
          <Select value={filters.positionSource} onChange={(e) => setFilters({ positionSource: Number(e.target.value) })}>
            <option value={-1}>Any</option>
            {POSITION_SOURCES.map((p, i) => (
              <option key={p} value={i}>
                {p}
              </option>
            ))}
          </Select>
        </Row>
      </Group>

      <Group header="Altitude (ft)">
        <Row label="Minimum">{num('minAltFt', 'None')}</Row>
        <Row label="Maximum">{num('maxAltFt', 'None')}</Row>
      </Group>

      <Group header="Ground Speed (kt)">
        <Row label="Minimum">{num('minSpeedKt', 'None')}</Row>
        <Row label="Maximum">{num('maxSpeedKt', 'None')}</Row>
      </Group>

      <Group header="Display" footer="Stale aircraft have an outdated position or are temporarily missing from the feed.">
        <Row label="Aircraft on ground">
          <Switch checked={filters.showOnGround} onChange={(v) => setFilters({ showOnGround: v })} label="Show aircraft on ground" />
        </Row>
        <Row label="Stale aircraft">
          <Switch checked={filters.showStale} onChange={(v) => setFilters({ showStale: v })} label="Show stale aircraft" />
        </Row>
        <Row label="Trails">
          <Switch checked={showTrails} onChange={setShowTrails} label="Show trails for all aircraft" />
        </Row>
      </Group>

      <Group>
        <Row className="button-cell destructive" onClick={resetFilters}>
          Reset Filters
        </Row>
      </Group>
    </>
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
    <>
      <Group header="Rules" footer="Each rule fires once when an aircraft starts matching it.">
        {rules.length === 0 && <div className="empty">No rules.</div>}
        {rules.map((r) => (
          <Row key={r.id} className="rule-cell">
            <span className="rule-main" title={meta(r.kind).label}>
              <span className="rule-title">{r.kind === 'enter-zone' ? `Enters ${r.label}` : meta(r.kind).short}</span>
              <span className="rule-sub">
                {meta(r.kind).needsValue ? (
                  <>
                    {RULE_PREFIX[r.kind]}
                    <input
                      type="number"
                      value={r.value}
                      onChange={(e) => update(r.id, { value: Number(e.target.value) })}
                      aria-label="Threshold"
                    />
                    {meta(r.kind).unit}
                  </>
                ) : r.kind === 'squawk-emergency' ? (
                  '7500 · 7600 · 7700'
                ) : (
                  'Area of the map when created'
                )}
              </span>
            </span>
            <Switch checked={r.enabled} onChange={(v) => update(r.id, { enabled: v })} label={`Enable ${meta(r.kind).label}`} />
            <button className="mini-button" onClick={() => setAlertRules(rules.filter((x) => x.id !== r.id))} aria-label="Delete rule">
              <Icon name="trash" size={16} />
            </button>
          </Row>
        ))}
      </Group>

      <Group
        header="New Rule"
        footer={kind === 'enter-zone' ? 'The zone is the area currently visible on the map.' : undefined}
      >
        <Row label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value as AlertKind)}>
            {ALERT_KINDS.map((a) => (
              <option key={a.kind} value={a.kind}>
                {a.short}
              </option>
            ))}
          </Select>
        </Row>
        {meta(kind).needsValue && (
          <Row label={`Threshold (${meta(kind).unit})`}>
            <input type="number" value={value} onChange={(e) => setValue(e.target.value)} aria-label="New rule threshold" />
          </Row>
        )}
        <Row className="button-cell" onClick={add}>
          Add Rule
        </Row>
      </Group>

      <Group
        header="Recent"
        action={
          events.length > 0 && (
            <button className="link mini-link" onClick={clearAlerts} style={{ border: 'none', background: 'none', color: 'var(--blue)', fontSize: 13, padding: 0 }}>
              Clear
            </button>
          )
        }
      >
        {events.length === 0 && <div className="empty">No alerts yet.</div>}
        {events.slice(0, 50).map((e) => (
          <Row key={e.id} className="event-cell" onClick={() => select(e.icao24)}>
            <span className="event-top">
              <b>{e.callsign ?? e.icao24.toUpperCase()}</b>
              <span className="muted tabular">{fmtClock(e.at)}</span>
            </span>
            <span className="event-msg">{e.message}</span>
          </Row>
        ))}
      </Group>
    </>
  );
}
