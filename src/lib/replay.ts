import type { Frame } from './types';

export interface ReplayPoint {
  id: string;
  lat: number;
  lon: number;
  track: number | null;
  alt: number | null;
  onGround: boolean;
}

const indexCache = new WeakMap<Frame, Map<string, Frame['a'][number]>>();

function indexOf(f: Frame) {
  let m = indexCache.get(f);
  if (!m) {
    m = new Map(f.a.map((row) => [row[0], row]));
    indexCache.set(f, m);
  }
  return m;
}

function lerpAngle(a: number, b: number, k: number) {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * k + 360) % 360;
}

const toPoint = (r: Frame['a'][number]): ReplayPoint => ({
  id: r[0],
  lat: r[1],
  lon: r[2],
  track: r[3] < 0 ? null : r[3],
  alt: r[4] < 0 ? null : r[4],
  onGround: r[5] === 1,
});

/** Aircraft positions at time `t`, linearly interpolated between the recorded frames around it. */
export function positionsAt(frames: Frame[], t: number): ReplayPoint[] {
  if (!frames.length) return [];
  if (t <= frames[0].t) return frames[0].a.map(toPoint);
  const last = frames[frames.length - 1];
  if (t >= last.t) return last.a.map(toPoint);

  let lo = 0;
  let hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const f0 = frames[lo];
  const f1 = frames[hi];
  const k = (t - f0.t) / (f1.t - f0.t || 1);
  const next = indexOf(f1);
  const out: ReplayPoint[] = [];
  const seen = new Set<string>();

  for (const r0 of f0.a) {
    const r1 = next.get(r0[0]);
    seen.add(r0[0]);
    if (!r1) {
      if (k < 0.5) out.push(toPoint(r0));
      continue;
    }
    const dLon = ((r1[2] - r0[2] + 540) % 360) - 180;
    out.push({
      id: r0[0],
      lat: r0[1] + (r1[1] - r0[1]) * k,
      lon: r0[2] + dLon * k,
      track: r0[3] < 0 || r1[3] < 0 ? (r1[3] < 0 ? (r0[3] < 0 ? null : r0[3]) : r1[3]) : lerpAngle(r0[3], r1[3], k),
      alt: r0[4] < 0 || r1[4] < 0 ? (r1[4] < 0 ? null : r1[4]) : r0[4] + (r1[4] - r0[4]) * k,
      onGround: (k < 0.5 ? r0[5] : r1[5]) === 1,
    });
  }
  if (k >= 0.5) for (const r1 of f1.a) if (!seen.has(r1[0])) out.push(toPoint(r1));
  return out;
}
