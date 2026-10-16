# Handling stale data, API failures and request limits

This document explains how the dashboard stays correct and usable when OpenSky data is late, incomplete, rate-limited or
unavailable. Every behaviour below can be seen in the UI. Most can be triggered on demand from **Region → Resilience
testing**, which spends no API credits.

---

## 1. Layers of defence

```
OpenSky ──► Proxy (server) ─────────────────────────────► Client (browser) ─────────────────────► UI
            • fresh cache (TTL = data resolution)          • budget-aware interval                • status pill + source
            • in-flight request coalescing                 • back-off + jitter, Retry-After       • warning / error banner
            • 429 back-off window (no upstream calls)      • pause when hidden/offline/replay     • stale styling, ages
            • fallback: stale cache → recorded → error     • ignore out-of-order snapshots        • "last known" labels
            • credit tracking → suggested interval         • offline cache (IndexedDB)            • entered/left counts
```

---

## 2. Request limits

### Credit model

| Area of request (sq°) | Credits |
| --- | --- |
| ≤ 25 | 1 |
| ≤ 100 | 2 |
| ≤ 400 | 3 |
| > 400 / global | 4 |

Daily allowance: **400** anonymous, **4,000** with an account. OpenSky reports the remaining credits in
`X-Rate-Limit-Remaining`. When they run out it answers `429` with `X-Rate-Limit-Retry-After-Seconds`.

### What the app does

1. **Doesn't poll faster than the data changes.** OpenSky refreshes state vectors every 10 s (5 s authenticated). The
   proxy caches each response for exactly that long, so extra requests (several tabs, several users, a manual refresh)
   are answered from memory with `source: "cache"` and cost nothing.
2. **Coalesces concurrent requests.** If a request for the same area is already in flight, later callers wait for that
   same promise instead of starting another upstream call.
3. **Shares cache entries between similar areas.** The requested box is snapped outward to a 0.25° grid to form the
   cache key, and the response is filtered back to the exact box. Users looking at almost the same area share one
   upstream call.
4. **Paces itself to the budget (Auto mode).** After each response the proxy computes

   ```
   usable      = remaining × 0.9            (10 % reserve)
   affordable  = floor(usable / creditCost)
   interval    = clamp(secondsUntilUtcMidnight / affordable, 10 s, 10 min)
   ```

   It returns this as `meta.suggestedIntervalMs`, and the client polls at that rate. With 380 anonymous credits, a 1-credit
   region and 12 h left, that works out to roughly a 2-minute interval. Between polls, dead reckoning keeps the map moving.
   The interval is recalculated on every response, so it speeds up when credits are plentiful and slows down when
   they're scarce.
5. **Respects 429.** On `429` the proxy records `retryUntil` and makes **no** upstream calls until then. It serves the
   fallback chain instead (section 3) and returns `retryAfterSec`, which the client folds into its next delay.
6. **Avoids pointless requests in the browser.** Polling stops while the tab is hidden (`visibilitychange`), while the
   browser is offline (`online`/`offline` events), in Offline mode and in Replay. When a region changes, any in-flight
   request is aborted and the new one is debounced (500 ms), so clicking through several presets costs one request.
7. **Shows the cost.** The status bar shows credits left and credits per request. Its tooltip shows the projected
   daily use for the current interval and region, and the Region tab shows each preset's cost.

---

## 3. API failures

### Proxy fallback chain (`src/lib/opensky-server.ts`)

| Condition | Response |
| --- | --- |
| Fresh cache hit | `source: "cache"` |
| Upstream OK | `source: "live"` |
| Upstream error / timeout (12 s) / 5xx / invalid JSON / 429 | ↓ fallback |
| …cached data younger than 15 min | `source: "stale-cache"` plus a `warning` |
| …otherwise recorded OpenSky responses exist | `source: "recorded"` plus a `warning` (frames stepped through per poll) |
| …otherwise | HTTP 502 / 429 with `{ error, retryAfterSec }` and a `Retry-After` header |

Authentication failures (401) refresh the OAuth token once and retry. Invalid bounding boxes are rejected with 400
before any upstream call.

### Client behaviour (`src/hooks/usePoller.ts`)

- Each request has a 20 s timeout via `AbortController`.
- Requests carry a sequence number. A response that arrives after a newer request was started (for example after a
  region change) is dropped.
- On failure the delay is `min(5 s × 2^(failures−1), 5 min)`, raised to at least `Retry-After`, then multiplied by a random
  jitter of 0.85–1.15 so many clients don't retry in lockstep.
- **Existing aircraft are never cleared because of an error.** The pill switches to *Degraded* (or *No data* when
  nothing has loaded yet), a red banner shows the error, and the tracks become stale through the normal ageing rules.
- When the source changes between the live timeline and the recorded one (which is older), the client starts a fresh
  timeline instead of mixing them.

### Offline

- On every successful live update the session is saved to IndexedDB (debounced): the region, tracks with their last 60
  observations, replay frames and the clock offset.
- On load the saved session is restored immediately (`source: "offline-cache"`, all aircraft marked stale). The map is
  therefore useful before the first response arrives, or without any network at all. Aircraft that the first live
  snapshot doesn't confirm are dropped.
- **Offline mode** (status bar toggle), or the browser going offline, stops all requests. Replay still works on
  the stored frames.
- Recorded responses are never written to the offline cache. It only ever holds real observations.

---

## 4. Stale, outdated and missing data

### Detecting stale data

OpenSky timestamps are unix seconds. The proxy includes `serverTime` in every response, so the client can measure two
separate things:

- **Feed lag**: `now − snapshot.time`. If the whole OpenSky snapshot is more than 60 s old, the pill turns *Degraded* and
  the banner says *"OpenSky feed is N min behind — positions are outdated"*. This happened during development: OpenSky
  kept serving the same snapshot for over 15 minutes, and the dashboard reported it correctly instead of showing "Live".
- **Per-aircraft position age**: `now − timePosition`. A position older than 30 s marks the aircraft as stale. It is
  drawn as a hollow outline, faded in the list, and the detail panel shows its *Position age* in amber.

Statuses are re-evaluated even when a poll returns the same snapshot again, so ages keep growing truthfully.

### Duplicate and out-of-order data

- A snapshot with the same `time` as the last one is treated as "no new data". The metadata is updated, but no
  missed-poll counters are incremented and no replay frame is added.
- A snapshot older than the last one is ignored entirely (for example a delayed reply).
- Inside a snapshot, an aircraft whose `timePosition` is older than the one already stored keeps its newer position.

### Missing fields

- Rows without a position are skipped and counted.
- `null` callsign, altitude, velocity, track, vertical rate or squawk are filled from the previous update and flagged
  as **last known** in the detail panel, so a single incomplete message doesn't make data disappear.
- Without velocity or track, an aircraft is not extrapolated and is drawn as a dot instead of a heading-rotated
  silhouette.

### Aircraft entering and leaving

- **Entering**: appears in a snapshot for the first time. Counted as `+N` in the status bar.
- **Leaving**: missing from a snapshot while its dead-reckoned position is outside the region. Removed at once and
  counted as `−N`.
- **Temporarily lost** (coverage gap, transponder silence): kept and drawn as stale for at least 60 s and 2 polls, then
  removed. If the aircraft reappears it continues the same track, with its history intact.
- **Region change**: tracks outside the new region are pruned immediately, the replay timeline resets and polling
  restarts for the new box.

### Dead reckoning limits

Positions are extrapolated from the last real report using ground speed and true track:

```
d      = v · Δt / R
φ₂     = asin(sin φ₁ cos d + cos φ₁ sin d cos θ)
λ₂     = λ₁ + atan2(sin θ sin d cos φ₁, cos d − sin φ₁ sin φ₂)
```

`Δt` is capped at **180 s**, so a long outage doesn't send aircraft flying off across the map. Aircraft on the ground, and
aircraft moving slower than 1 m/s, are not extrapolated.

---

## 5. Trying it yourself

| Action | What you should see |
| --- | --- |
| Region → *Simulate OpenSky outage* | Pill *Degraded*, source *Stale cache* (or *Recorded data*), amber banner |
| *Simulate rate limit (429)* | Same chain, message mentions the rate limit |
| *Serve recorded data* | Source *Recorded data*; aircraft enter and leave across 3 recorded frames; replay becomes available |
| *Simulate proxy failure* | Red banner, aircraft kept and going stale, *Next poll* growing 5 s → 10 s → 20 s … |
| Toggle *Offline* | Pill *Offline*, *Next poll: paused*, map and replay still work |
| Switch to another tab and come back | No requests while hidden; one request on return if the data is due |
| `GET /api/states?stats` | Proxy counters: upstream calls, cache entries, credits left |
