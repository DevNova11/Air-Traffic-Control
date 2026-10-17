'use client';

import { useEffect } from 'react';
import { fmtAge, fmtClock } from '@/lib/format';
import { useTraffic } from '@/store/traffic';
import { Icon, Select } from './ui';

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
      <div className="replay compact idle glass">
        <Icon name="replay" size={16} />
        Replay available after {2 - frames.length} more update{frames.length === 1 ? '' : 's'}
      </div>
    );
  }

  const start = frames[0].t;
  const end = frames[frames.length - 1].t;
  const toWall = (t: number) => (t - offset) * 1000;

  if (!replay.active) {
    return (
      <div className="replay compact glass">
        <button className="round-button small" onClick={() => setReplay({ active: true, playing: true, t: start })} aria-label="Start replay">
          <Icon name="play" size={14} />
        </button>
        <span>
          Replay {frames.length} updates · {fmtAge(end - start)}
        </span>
      </div>
    );
  }

  const progress = ((replay.t - start) / (end - start || 1)) * 100;

  return (
    <div className="replay glass">
      <button
        className="round-button"
        onClick={() => setReplay({ playing: !replay.playing, t: replay.t >= end ? start : replay.t })}
        aria-label={replay.playing ? 'Pause' : 'Play'}
      >
        <Icon name={replay.playing ? 'pause' : 'play'} size={16} />
      </button>
      <input
        className="range"
        type="range"
        min={start}
        max={end}
        step={1}
        value={replay.t}
        style={{ ['--p' as string]: `${progress}%` }}
        onChange={(e) => setReplay({ t: Number(e.target.value), playing: false })}
        aria-label="Replay position"
      />
      <span className="replay-time">{fmtClock(toWall(replay.t))}</span>
      <Select className="tinted compact" value={replay.speed} onChange={(e) => setReplay({ speed: Number(e.target.value) })} aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </Select>
      <button className="pill-button" onClick={() => setReplay({ active: false, playing: false })}>
        Live
      </button>
    </div>
  );
}
