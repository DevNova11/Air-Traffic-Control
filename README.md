# Airspace Monitor

A real-time air traffic monitoring dashboard built on the [OpenSky Network REST API](https://openskynetwork.github.io/opensky-api/rest.html).
Pick a region, watch every aircraft in it move on an interactive map, inspect each aircraft's recent track, replay what the app has
observed, and set up alerts. It keeps working when OpenSky is slow, stale, rate-limited, or down.

**Stack:** Next.js 15 (App Router) · TypeScript · Leaflet (custom canvas layer) · Zustand · IndexedDB

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

Optional, for higher rate limits (4,000 credits a day instead of 400):

```bash
cp .env.example .env.local   # then fill in OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET
```

The credentials are read only by the server-side proxy and never reach the browser.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build && npm start` | Production build |
| `npm run lint` | Type-check (`tsc --noEmit`) |
| `npm run record -- 3 12 44 0 52 16` | Record 3 OpenSky frames, 12 s apart, for a bounding box, into `data/recorded/` |

---

## Features

| # | Requirement | Where / how |
| --- | --- | --- |
| 01 | Live data from OpenSky | `/api/states` proxy → `opensky-network.org/api/states/all` (bbox query, `extended=1`) |
| 02 | Interactive map | Leaflet, Esri dark basemap, aircraft drawn on a canvas overlay, rotated to heading, coloured by altitude |
| 03 | Aircraft information | Hover tooltip; click for the detail panel: baro/geo altitude, speed, heading, vertical rate, squawk, last position, position age, source, category |
| 04 | Periodic updates without waste | Budget-aware poll interval, shared proxy cache, request coalescing, pauses when the tab is hidden, offline or replaying |
| 05 | Regions and filters | 10 preset regions, "monitor current map view", custom bounds; filter by callsign/ICAO24/squawk, country, altitude, speed, position source, on-ground, stale |
| 06 | State across updates | Tracks keyed by ICAO24, merged snapshot by snapshot; entered/left counts in the status bar |
| 07 | Failures, missing data, rate limits, stale positions | See [docs/RESILIENCE.md](docs/RESILIENCE.md) |
| 08 | Recent movement | Detail panel: observed track on the map, altitude and speed sparklines, latest observations |

Bonus features:

- **Interpolation.** Between updates each aircraft is moved by dead reckoning (great-circle destination from last position,
  ground speed and track), capped at 180 s. The selected aircraft shows the extrapolated part as a dashed line.
- **Replay.** Every snapshot is stored as a compact frame (up to 120). The replay bar scrubs or plays them at 1–32× with
  linear interpolation between frames.
- **Rendering performance.** One `<canvas>` instead of thousands of DOM markers, viewport culling, about 15 fps when idle
  (every frame while panning), memoised filtering, labels only when zoomed in. The sidebar list is capped at 300 rows.
- **Offline mode.** The last session (tracks with history, plus replay frames) is saved to IndexedDB. It is restored on load
  and kept when the network is gone. The proxy also falls back to recorded OpenSky responses.
- **Alerts.** Rules for emergency squawks (on by default), altitude above/below, speed above/below, steep descent, and entering a
  zone (the current map view, drawn in orange). Alerts are edge-triggered and appear as a toast, a badge and an event log.
- **Caching and recovery.** Fresh-TTL cache, stale-cache fallback, recorded fallback, exponential back-off with jitter, and
  `Retry-After` handling.
- **Apple-style interface.** Built to Apple's Human Interface Guidelines: a full-bleed map with floating translucent
  panels, SF typography (Inter elsewhere), system colours, segmented controls, inset grouped lists, iOS switches, an
  Apple Maps–style aircraft card, and a bottom sheet on phones. Light and dark mode, including the basemap, follow the OS.
- **Resilience testing.** In Region → *Resilience testing* you can inject an OpenSky outage, a 429, recorded data, or a proxy
  failure, without spending credits.

---

## Architecture

```
Browser                                                       Next.js server (Node)
┌──────────────────────────────────────────────┐             ┌───────────────────────────────────┐
│ usePoller ── fetch /api/states?bbox ─────────┼────────────►│ app/api/states/route.ts           │
│   (interval, back-off, visibility, abort)    │             │   validate bbox, simulate modes   │
│        │                                     │             │ lib/opensky-server.ts             │
│        ▼                                     │             │   snap bbox → cache key           │
│ Zustand store (store/traffic.ts)             │             │   fresh cache (10 s / 5 s TTL)    │
│   ingest() → lib/tracks.mergeSnapshot()      │             │   in-flight coalescing            │
│            → lib/alerts.evaluateAlerts()     │             │   OAuth2 token cache              │
│            → frames (replay)                 │             │   429 / credit tracking           │
│            → IndexedDB (offline cache)       │             │   fallback: stale cache → recorded│
│        │                                     │             └──────────────┬────────────────────┘
│        ▼                                     │                            │
│ MapView (Leaflet + canvas, rAF loop) reads   │                            ▼
│   the store directly, no React re-render     │                 opensky-network.org /states/all
│ Sidebar / StatusBar / DetailPanel / Replay   │
│   subscribe with selectors                   │
└──────────────────────────────────────────────┘
```

### Source layout

```
src/
  app/
    api/states/route.ts   GET proxy endpoint
    page.tsx              layout shell, hydrates the store, starts polling
  lib/
    opensky-server.ts     server-only OpenSky client: auth, cache, coalescing, budget, fallbacks
    tracks.ts             pure state-merging rules, dead reckoning, filters, replay frames
    alerts.ts             alert rules and edge-triggered evaluation
    replay.ts             frame interpolation
    geo.ts                regions, bbox maths, credit cost, dead-reckoning formula
    idb.ts                tiny IndexedDB / localStorage wrappers
    types.ts              shared types
  store/traffic.ts        Zustand store (single source of truth)
  hooks/usePoller.ts      request scheduling
  components/             MapView, Sidebar, StatusBar, DetailPanel, ReplayBar, Overlays
data/recorded/            recorded OpenSky responses (fallback / demo)
```

### API integration

- The browser only ever calls **`GET /api/states?lamin&lomin&lamax&lomax`** on its own origin. The proxy calls
  `https://opensky-network.org/api/states/all` with the same box and `extended=1`, which adds the aircraft category.
- OpenSky's positional arrays are turned into typed `StateVector` objects on the server. Malformed rows are dropped,
  `states: null` becomes `[]`, and callsigns are trimmed.
- **Authentication** (optional) uses OpenSky's OAuth2 client-credentials flow. The token is cached and refreshed a minute
  before expiry, and once more on a 401. Credentials come from server environment variables only.
- Every response carries a `meta` block: `source` (`live` / `cache` / `stale-cache` / `recorded`), `fetchedAt`,
  `serverTime`, `rateLimitRemaining`, `retryAfterSec`, `creditCost`, `suggestedIntervalMs`, `warning`. The UI uses these to
  explain exactly what it is showing.

### State management

One Zustand store (`src/store/traffic.ts`) holds:

- `tracks: Map<icao24, Track>`. Each `Track` has the latest `StateVector`, an observation `history` (up to 240 points),
  `firstSeen`, `lastSeen`, `lastPositionTime`, `missedPolls`, `status` (`active` / `stale`), and `carried` (fields filled
  from an earlier update).
- `frames` for replay, `region`, `filters`, `selectedId`, `alertRules` / `alertEvents`, and a `status` object describing
  the connection (phase, source, last success, next poll, failures, credits, warnings).

All merge rules live in pure functions (`lib/tracks.ts`, `lib/alerts.ts`), so the store's `ingest()` only puts them
together. A new `Map` is created on each ingest, so selectors and the memoised `selectFilteredTracks` can compare by
reference. The map's animation loop reads `useTraffic.getState()` directly, so redrawing the map never causes a
React render. Preferences (region, poll mode, alert rules) are kept in `localStorage`; the session data is kept in IndexedDB.

**How aircraft are tracked from one snapshot to the next** (`mergeSnapshot`):

| Situation | Behaviour |
| --- | --- |
| Not seen before | Added as a new track ("entered") |
| Newer position | Latest state replaced, observation appended to history |
| Same position time | State refreshed, history unchanged |
| Older position (out of order) | Ignored, but the aircraft counts as alive |
| Field is `null` (e.g. velocity) | Previous value kept and labelled *last known* in the UI |
| No position at all | Skipped and counted |
| Missing from snapshot, estimated position outside region | Removed ("left") |
| Missing from snapshot, still inside | Kept as *stale*. Removed after 2 missed polls **and** 60 s unseen ("lost") |
| Position older than 30 s (real time) | Marked *stale*: hollow icon, faded in the list |
| Restored from offline cache and not confirmed by the first live snapshot | Removed |

---

## Request limits in numbers

OpenSky charges credits per `/states/all` call by area: ≤25 sq° costs 1, ≤100 costs 2, ≤400 costs 3, anything larger 4.
Anonymous users get 400 credits a day; registered users get 4,000. The data only updates every 10 s for anonymous users
(5 s when authenticated).

A naive 10 s poll of a 3-credit region would use 25,920 credits a day, which exhausts the anonymous quota in about 22
minutes. In *Auto* mode the app spreads the remaining credits (minus a 10 % reserve) evenly until the daily reset:

```
interval = clamp(secondsUntilReset / floor(remaining × 0.9 / cost), 10 s (5 s auth), 10 min)
```

Dead reckoning keeps the aircraft moving smoothly in between. You can still choose a fixed 10 s / 30 s / 1 min / 5 min; the
status bar's *Credits left* tooltip shows the projected daily use. All details are in [docs/RESILIENCE.md](docs/RESILIENCE.md).

---

## Known limitations

- The recordings in `data/recorded` cover Central Europe (44–52°N, 0–16°E). Other regions show no aircraft in recorded
  mode. Run `npm run record` with a different box to change this.
- Dead reckoning assumes a straight track at constant speed, so turning aircraft drift until the next real update.
  This is why extrapolation is capped and stale aircraft are drawn differently.
- Replay covers what this browser has observed (up to 120 snapshots), not OpenSky's historical database.
