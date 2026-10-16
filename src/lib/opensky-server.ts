/**
 * Server-side OpenSky client used by the /api/states proxy route.
 *
 * Responsibilities:
 *  - keep OAuth2 credentials on the server and cache the access token
 *  - share one fresh-response cache between all browser clients (TTL = OpenSky's data resolution)
 *  - coalesce identical concurrent requests into a single upstream call
 *  - track OpenSky's credit budget / 429 back-off and recommend a poll interval
 *  - degrade gracefully: stale cache → recorded responses → error
 *
 * Never import this file from client components.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { clampBBox, creditCost, inBBox } from './geo';
import type { BBox, DataSource, StatesResponse, StateVector } from './types';

const API_URL = 'https://opensky-network.org/api/states/all';
const TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

const UPSTREAM_TIMEOUT_MS = 12_000;
/** Serve stale cache for at most this long after a failure before falling back to recordings. */
const STALE_MAX_AGE_MS = 15 * 60_000;
const MAX_CACHE_ENTRIES = 40;
/** Keep 10% of the daily credits in reserve. */
const CREDIT_RESERVE = 0.1;
const MAX_INTERVAL_MS = 10 * 60_000;

const CLIENT_ID = process.env.OPENSKY_CLIENT_ID;
const CLIENT_SECRET = process.env.OPENSKY_CLIENT_SECRET;
const HAS_CREDENTIALS = Boolean(CLIENT_ID && CLIENT_SECRET);

/** OpenSky's time resolution: 10s anonymous, 5s authenticated. Polling faster returns the same data. */
const FRESH_TTL_MS = HAS_CREDENTIALS ? 5_000 : 10_000;

interface CacheEntry {
  time: number;
  states: StateVector[];
  fetchedAt: number;
}

interface ServerState {
  cache: Map<string, CacheEntry>;
  inflight: Map<string, Promise<CacheEntry>>;
  token: { value: string; expiresAt: number } | null;
  rate: { remaining: number | null; retryUntil: number };
  recorded: CacheEntry[] | null;
  recordedCursor: Map<string, number>;
  upstreamCalls: number;
}

// Kept on globalThis so state survives Next.js hot reloads in development.
const g = globalThis as unknown as { __openskyProxy?: ServerState };
const S: ServerState = (g.__openskyProxy ??= {
  cache: new Map(),
  inflight: new Map(),
  token: null,
  rate: { remaining: null, retryUntil: 0 },
  recorded: null,
  recordedCursor: new Map(),
  upstreamCalls: 0,
});

export class ProxyError extends Error {
  constructor(message: string, public status: number, public retryAfterSec: number | null = null) {
    super(message);
  }
}

class RateLimitError extends Error {
  constructor(public retryAfterSec: number) {
    super(`OpenSky rate limit reached, retry in ${retryAfterSec}s`);
  }
}

// ---------------------------------------------------------------------------
// Parsing

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Convert one positional state-vector array into an object, rejecting malformed rows. */
export function parseStateVector(row: unknown): StateVector | null {
  if (!Array.isArray(row) || typeof row[0] !== 'string') return null;
  const callsign = typeof row[1] === 'string' ? row[1].trim() || null : null;
  return {
    icao24: row[0].toLowerCase(),
    callsign,
    originCountry: typeof row[2] === 'string' ? row[2] : 'Unknown',
    timePosition: num(row[3]),
    lastContact: num(row[4]) ?? 0,
    lon: num(row[5]),
    lat: num(row[6]),
    baroAltitude: num(row[7]),
    onGround: row[8] === true,
    velocity: num(row[9]),
    trueTrack: num(row[10]),
    verticalRate: num(row[11]),
    geoAltitude: num(row[13]),
    squawk: typeof row[14] === 'string' ? row[14] : null,
    spi: row[15] === true,
    positionSource: num(row[16]) ?? 0,
    category: num(row[17]),
  };
}

function parseBody(body: unknown): { time: number; states: StateVector[] } {
  const b = body as { time?: unknown; states?: unknown };
  const time = num(b?.time);
  if (time === null) throw new Error('OpenSky response missing "time"');
  // OpenSky returns `states: null` when no aircraft are in the box.
  const rows = Array.isArray(b.states) ? b.states : [];
  const states: StateVector[] = [];
  for (const row of rows) {
    const s = parseStateVector(row);
    if (s) states.push(s);
  }
  return { time, states };
}

// ---------------------------------------------------------------------------
// Auth

async function getToken(force = false): Promise<string | null> {
  if (!HAS_CREDENTIALS) return null;
  if (!force && S.token && S.token.expiresAt > Date.now()) return S.token.value;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) {
    S.token = null;
    throw new Error(`OpenSky auth failed (HTTP ${res.status})`);
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  // Refresh a minute before expiry.
  S.token = { value: json.access_token, expiresAt: Date.now() + ((json.expires_in ?? 1800) - 60) * 1000 };
  return S.token.value;
}

// ---------------------------------------------------------------------------
// Upstream

/**
 * Snap the requested box outward to a 0.25° grid. Clients looking at nearly the same
 * area then share one cache entry (and one upstream request); the response is
 * filtered back down to the exact requested box.
 */
function snapBBox(b: BBox): BBox {
  const q = 0.25;
  return clampBBox({
    lamin: Math.floor(b.lamin / q) * q,
    lomin: Math.floor(b.lomin / q) * q,
    lamax: Math.ceil(b.lamax / q) * q,
    lomax: Math.ceil(b.lomax / q) * q,
  });
}

function cacheKey(b: BBox) {
  return `${b.lamin},${b.lomin},${b.lamax},${b.lomax}`;
}

async function fetchUpstream(b: BBox, retried = false): Promise<CacheEntry> {
  const url = new URL(API_URL);
  url.searchParams.set('lamin', String(b.lamin));
  url.searchParams.set('lomin', String(b.lomin));
  url.searchParams.set('lamax', String(b.lamax));
  url.searchParams.set('lomax', String(b.lomax));
  url.searchParams.set('extended', '1');

  const token = await getToken();
  S.upstreamCalls++;
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    cache: 'no-store',
  });

  const remaining = num(Number(res.headers.get('x-rate-limit-remaining') ?? NaN));
  if (remaining !== null) S.rate.remaining = remaining;

  if (res.status === 429) {
    const retry = Number(res.headers.get('x-rate-limit-retry-after-seconds')) || 60;
    S.rate.retryUntil = Date.now() + retry * 1000;
    S.rate.remaining = 0;
    throw new RateLimitError(retry);
  }
  if (res.status === 401 && token && !retried) {
    await getToken(true);
    return fetchUpstream(b, true);
  }
  if (!res.ok) throw new Error(`OpenSky returned HTTP ${res.status}`);

  const { time, states } = parseBody(await res.json());
  return { time, states, fetchedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Recorded fallback

async function loadRecorded(): Promise<CacheEntry[]> {
  if (S.recorded) return S.recorded;
  const dir = path.join(process.cwd(), 'data', 'recorded');
  const frames: CacheEntry[] = [];
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      const { time, states } = parseBody(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')));
      frames.push({ time, states, fetchedAt: time * 1000 });
    }
  } catch {
    // no recordings available
  }
  frames.sort((a, b) => a.time - b.time);
  S.recorded = frames;
  return frames;
}

/** Step through the recorded frames on each call (per region) and stay on the last one. */
async function nextRecorded(key: string): Promise<CacheEntry | null> {
  const frames = await loadRecorded();
  if (!frames.length) return null;
  const i = S.recordedCursor.get(key) ?? 0;
  S.recordedCursor.set(key, Math.min(i + 1, frames.length - 1));
  return frames[Math.min(i, frames.length - 1)];
}

// ---------------------------------------------------------------------------
// Budget

function secondsUntilUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(60, (next - now) / 1000);
}

/**
 * Spread the remaining daily credits evenly until they reset so the dashboard
 * never runs dry. Never faster than OpenSky's data resolution.
 */
function suggestedIntervalMs(cost: number): number {
  const now = Date.now();
  if (S.rate.retryUntil > now) return S.rate.retryUntil - now + 1000;
  if (S.rate.remaining === null) return HAS_CREDENTIALS ? 15_000 : 30_000;
  const usable = S.rate.remaining * (1 - CREDIT_RESERVE);
  const affordable = Math.floor(usable / cost);
  const secs = secondsUntilUtcMidnight(now);
  if (affordable <= 0) return MAX_INTERVAL_MS;
  const interval = (secs * 1000) / affordable;
  return Math.round(Math.min(MAX_INTERVAL_MS, Math.max(FRESH_TTL_MS, interval)));
}

// ---------------------------------------------------------------------------
// Public entry point

function respond(requested: BBox, cost: number, entry: CacheEntry, source: DataSource, warning?: string): StatesResponse {
  const retryAfterSec = S.rate.retryUntil > Date.now() ? Math.ceil((S.rate.retryUntil - Date.now()) / 1000) : null;
  return {
    time: entry.time,
    states: entry.states.filter((s) => s.lat !== null && s.lon !== null && inBBox(requested, s.lat, s.lon)),
    meta: {
      source,
      fetchedAt: entry.fetchedAt,
      authenticated: HAS_CREDENTIALS,
      rateLimitRemaining: S.rate.remaining,
      retryAfterSec,
      creditCost: cost,
      suggestedIntervalMs: suggestedIntervalMs(cost),
      serverTime: Date.now(),
      warning,
    },
  };
}

/**
 * Failure modes that can be injected to demonstrate resilience without spending credits:
 * - outage:    OpenSky unreachable → stale cache → recorded data
 * - ratelimit: OpenSky answers 429 → same fallback chain, plus Retry-After
 * - recorded:  serve the recorded responses directly
 * - down:      the proxy itself fails (no fallback) → client-side back-off
 */
export type SimulationMode = 'outage' | 'ratelimit' | 'recorded' | 'down';

export async function getStates(requested: BBox, simulate?: SimulationMode): Promise<StatesResponse> {
  const snapped = snapBBox(requested);
  const key = cacheKey(snapped);
  const cost = creditCost(snapped);
  const now = Date.now();
  const cached = S.cache.get(key);

  if (simulate === 'down') throw new ProxyError('Proxy unavailable (simulated)', 503, null);
  if (simulate === 'recorded') {
    const rec = await nextRecorded(key);
    if (rec) return respond(requested, cost, rec, 'recorded', 'Serving recorded data (simulated)');
  }

  if (!simulate && cached && now - cached.fetchedAt < FRESH_TTL_MS) {
    return respond(requested, cost, cached, 'cache');
  }

  const fallback = async (reason: string, retryAfterSec: number | null): Promise<StatesResponse> => {
    if (cached && Date.now() - cached.fetchedAt < STALE_MAX_AGE_MS) {
      return respond(requested, cost, cached, 'stale-cache', `${reason} — showing cached data`);
    }
    const rec = await nextRecorded(key);
    if (rec) return respond(requested, cost, rec, 'recorded', `${reason} — showing recorded data`);
    throw new ProxyError(reason, retryAfterSec ? 429 : 502, retryAfterSec);
  };

  if (simulate === 'outage') return fallback('OpenSky unreachable (simulated)', null);
  if (simulate === 'ratelimit') return fallback('Rate limited by OpenSky (simulated)', 60);

  // Respect a 429 back-off without spending another request.
  if (S.rate.retryUntil > now) {
    return fallback('Rate limited by OpenSky', Math.ceil((S.rate.retryUntil - now) / 1000));
  }

  let pending = S.inflight.get(key);
  if (!pending) {
    pending = fetchUpstream(snapped)
      .then((entry) => {
        S.cache.set(key, entry);
        S.recordedCursor.delete(key); // next outage replays the recording from the start
        if (S.cache.size > MAX_CACHE_ENTRIES) {
          const oldest = [...S.cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
          S.cache.delete(oldest[0]);
        }
        return entry;
      })
      .finally(() => S.inflight.delete(key));
    S.inflight.set(key, pending);
  }

  try {
    const entry = await pending;
    return respond(requested, cost, entry, 'live');
  } catch (err) {
    if (err instanceof RateLimitError) return fallback('Rate limited by OpenSky', err.retryAfterSec);
    const msg =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? 'OpenSky did not respond in time'
        : err instanceof Error
          ? err.message
          : 'OpenSky request failed';
    return fallback(msg, null);
  }
}

export function proxyStats() {
  return {
    authenticated: HAS_CREDENTIALS,
    upstreamCalls: S.upstreamCalls,
    cacheEntries: S.cache.size,
    rateLimitRemaining: S.rate.remaining,
    retryUntil: S.rate.retryUntil || null,
  };
}
