'use client';

import { useEffect } from 'react';
import { fmtAge, fmtClock } from '@/lib/format';
import { useTraffic } from '@/store/traffic';

const SPEEDS = [1, 4, 8, 16, 32];

/**
 * Replays the snapshots this session has collected (and any restored from the
 * offline cache), interpolating aircraft between frames.
 */
export default function ReplayBar() {
  const frames = useTraffic((s) => s.frames);
  const replay = useTraffic((s) => s.replay);
  const offset = useTraffic((s) => s.clockOffsetSec);
  const setReplay = useTraffic((s) => s.setReplay);

  // Advance the replay clock while playing.
  useEffect(() => {
    if (!replay.active || !replay.playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (ts: number) => {
      const s = useTraffic.getState();
      const end = s.frames[s.frames.length - 1]?.t ?? 0;
      const t = s.replay.t + ((ts - last) / 1000) * s.replay.speed;
      last = ts;
      if (t >= end) {
        s.setReplay({ t: end, playing: false });
        return;
      }
      s.setReplay({ t });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [replay.active, replay.playing]);

  if (frames.length < 2) {
    return (
      <div className="replay-bar compact">
        <span className="muted">Replay becomes available after two updates ({frames.length}/2 collected)</span>
      </div>
    );
  }

  const start = frames[0].t;
  const end = frames[frames.length - 1].t;
  const toWall = (t: number) => (t - offset) * 1000;

  if (!replay.active) {
    return (
      <div className="replay-bar compact">
        <button className="btn" onClick={() => setReplay({ active: true, playing: true, t: start })}>
          ▶ Replay
        </button>
        <span className="muted">
          {frames.length} snapshots · last {fmtAge(end - start)}
        </span>
      </div>
    );
  }

  return (
    <div className="replay-bar">
      <button className="btn" onClick={() => setReplay({ playing: !replay.playing, t: replay.t >= end ? start : replay.t })}>
        {replay.playing ? '❚❚' : '▶'}
      </button>
      <input
        className="replay-range"
        type="range"
        min={start}
        max={end}
        step={1}
        value={replay.t}
        onChange={(e) => setReplay({ t: Number(e.target.value), playing: false })}
      />
      <span className="mono">{fmtClock(toWall(replay.t))}</span>
      <select value={replay.speed} onChange={(e) => setReplay({ speed: Number(e.target.value) })}>
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      <button className="btn" onClick={() => setReplay({ active: false, playing: false })}>
        Back to live
      </button>
    </div>
  );
}
