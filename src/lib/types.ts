/** Geographic bounding box in decimal degrees (WGS84). */
export interface BBox {
  lamin: number;
  lomin: number;
  lamax: number;
  lomax: number;
}

export interface Region {
  id: string;
  name: string;
  bbox: BBox;
}

/** A normalised OpenSky state vector (the API returns positional arrays). */
export interface StateVector {
  icao24: string;
  callsign: string | null;
  originCountry: string;
  /** Unix seconds of the last position update, null if no position in the last 15s. */
  timePosition: number | null;
  /** Unix seconds of the last message of any kind from the transponder. */
  lastContact: number;
  lon: number | null;
  lat: number | null;
  /** Barometric altitude in metres. */
  baroAltitude: number | null;
  onGround: boolean;
  /** Ground speed in m/s. */
  velocity: number | null;
  /** Track over ground, degrees clockwise from north. */
  trueTrack: number | null;
  /** Vertical rate in m/s. */
  verticalRate: number | null;
  /** Geometric altitude in metres. */
  geoAltitude: number | null;
  squawk: string | null;
  spi: boolean;
  /** 0 = ADS-B, 1 = ASTERIX, 2 = MLAT, 3 = FLARM */
  positionSource: number;
  category: number | null;
}

/**
 * Where a response came from:
 * - live:        fetched from OpenSky for this request
 * - cache:       served from the proxy's fresh cache (another request fetched it < TTL ago)
 * - stale-cache: OpenSky failed / rate-limited, older cached data served instead
 * - recorded:    no usable live data, recorded OpenSky responses served instead
 */
export type DataSource = 'live' | 'cache' | 'stale-cache' | 'recorded';

export interface StatesMeta {
  source: DataSource;
  /** When the proxy obtained this data from OpenSky (ms since epoch). */
  fetchedAt: number;
  authenticated: boolean;
  /** Credits left according to OpenSky's X-Rate-Limit-Remaining header. */
  rateLimitRemaining: number | null;
  /** Seconds until OpenSky accepts requests again (after a 429). */
  retryAfterSec: number | null;
  /** Credits one request for this region costs. */
  creditCost: number;
  /** Poll interval the proxy recommends so the daily credit budget lasts. */
  suggestedIntervalMs: number;
  /** Proxy wall clock when responding (ms) — lets the client measure feed lag and clock skew. */
  serverTime: number;
  warning?: string;
}

export interface StatesResponse {
  /** OpenSky snapshot time, unix seconds. */
  time: number;
  states: StateVector[];
  meta: StatesMeta;
}

/** One position observation collected by the app for an aircraft. */
export interface Observation {
  /** Position time, unix seconds (OpenSky clock). */
  t: number;
  lat: number;
  lon: number;
  alt: number | null;
  vel: number | null;
  track: number | null;
  onGround: boolean;
}

/**
 * - active: present in the latest snapshot with a fresh position
 * - stale:  present but its position is old, or missing from the latest snapshot(s)
 */
export type TrackStatus = 'active' | 'stale';

export interface Track {
  icao24: string;
  latest: StateVector;
  history: Observation[];
  /** Wall-clock ms when the app first saw this aircraft. */
  firstSeen: number;
  /** Wall-clock ms of the last snapshot that contained this aircraft. */
  lastSeen: number;
  /** Position time (OpenSky clock, seconds) of the newest accepted position. */
  lastPositionTime: number;
  /** Consecutive snapshots this aircraft has been missing from. */
  missedPolls: number;
  status: TrackStatus;
  /** Fields that were null in the latest update and carried over from an earlier one. */
  carried: string[];
  /** Restored from the offline cache, not yet confirmed by a live snapshot. */
  hydrated?: boolean;
}

/** Compact per-snapshot record of every aircraft, used for replay. */
export interface Frame {
  t: number;
  /** [icao24, lat, lon, track|-1, altitude m|-1, onGround 0/1] */
  a: [string, number, number, number, number, number][];
}

export type AlertKind =
  | 'altitude-below'
  | 'altitude-above'
  | 'speed-above'
  | 'speed-below'
  | 'vrate-below'
  | 'enter-zone'
  | 'squawk-emergency';

export interface AlertRule {
  id: string;
  kind: AlertKind;
  enabled: boolean;
  /** feet for altitude, knots for speed, ft/min for vertical rate */
  value: number;
  zone?: BBox;
  label?: string;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  icao24: string;
  callsign: string | null;
  message: string;
  at: number;
}

export interface Filters {
  query: string;
  country: string;
  minAltFt: number | null;
  maxAltFt: number | null;
  minSpeedKt: number | null;
  maxSpeedKt: number | null;
  showOnGround: boolean;
  showStale: boolean;
  /** -1 = any; otherwise an OpenSky position source. */
  positionSource: number;
}
