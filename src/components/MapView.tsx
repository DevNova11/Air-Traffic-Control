'use client';

import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { altColor, fmtAlt, fmtSpeed } from '@/lib/format';
import { positionsAt } from '@/lib/replay';
import { estimatePosition, trackAltitudeM } from '@/lib/tracks';
import { dataNowSec, selectFilteredTracks, useTraffic } from '@/store/traffic';
import type { BBox } from '@/lib/types';

/** Aircraft silhouette pointing north, centred on the origin. */
const PLANE = new Path2D(
  'M0,-7 L1.2,-2.5 L6.5,0.6 L6.5,2 L1.2,0.8 L0.9,4.3 L2.6,5.6 L2.6,6.7 L0,5.9 L-2.6,6.7 L-2.6,5.6 L-0.9,4.3 L-1.2,0.8 L-6.5,2 L-6.5,0.6 L-1.2,-2.5 Z',
);

const FRAME_MS = 66; // ~15 fps while idle; every animation frame while the map moves
const HIT_RADIUS = 12;

const toBounds = (b: BBox): L.LatLngTuple[] => [
  [b.lamin, b.lomin],
  [b.lamax, b.lomax],
];

interface DrawItem {
  id: string;
  lat: number;
  lon: number;
  track: number | null;
  alt: number | null;
  onGround: boolean;
  stale: boolean;
  label: string | null;
}

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current!;
    const map = L.map(container, { zoomControl: true, minZoom: 2, worldCopyJump: true, attributionControl: true });
    // Esri's dark-grey canvas basemap (no API key needed) plus its label layer.
    const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
    L.tileLayer(`${esri}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
      attribution:
        'Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors · Data: <a href="https://opensky-network.org">OpenSky Network</a>',
      maxZoom: 16,
    }).addTo(map);
    L.tileLayer(`${esri}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16, pane: 'shadowPane' }).addTo(map);

    const initial = useTraffic.getState().region;
    map.fitBounds(toBounds(initial.bbox));
    const regionRect = L.rectangle(toBounds(initial.bbox), {
      color: '#38bdf8',
      weight: 1.5,
      dashArray: '6 6',
      fill: false,
      interactive: false,
    }).addTo(map);
    const zoneLayer = L.layerGroup().addTo(map);

    // Canvas overlay above the tiles; Leaflet markers would not scale to thousands of aircraft.
    const canvas = document.createElement('canvas');
    canvas.className = 'aircraft-canvas';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d')!;
    let dpr = window.devicePixelRatio || 1;
    let fitted = false;

    const resize = () => {
      const size = map.getSize();
      dpr = window.devicePixelRatio || 1;
      canvas.width = size.x * dpr;
      canvas.height = size.y * dpr;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      map.invalidateSize();
      // The container may have had no size when the map was created; fit the region once it does.
      if (!fitted && size.x > 0 && size.y > 0) {
        fitted = true;
        map.fitBounds(toBounds(useTraffic.getState().region.bbox));
      }
      dirty = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // Screen positions from the last draw, for hit-testing.
    let hitIds: string[] = [];
    let hitX = new Float32Array(0);
    let hitY = new Float32Array(0);
    let dirty = true;
    let moving = false;
    let lastDraw = 0;
    let lastFollow = 0;
    let raf = 0;

    function collect(): DrawItem[] {
      const s = useTraffic.getState();
      if (s.replay.active) {
        const allowed = new Set(selectFilteredTracks(s).map((t) => t.icao24));
        const filtering = allowed.size !== s.tracks.size;
        return positionsAt(s.frames, s.replay.t)
          .filter((p) => !filtering || allowed.has(p.id))
          .map((p) => ({ ...p, stale: false, label: s.tracks.get(p.id)?.latest.callsign ?? null }));
      }
      const now = dataNowSec(s);
      return selectFilteredTracks(s).map((t) => {
        const [lat, lon] = estimatePosition(t, now);
        return {
          id: t.icao24,
          lat,
          lon,
          track: t.latest.trueTrack,
          alt: trackAltitudeM(t.latest),
          onGround: t.latest.onGround,
          stale: t.status === 'stale',
          label: t.latest.callsign,
        };
      });
    }

    function drawTrail(points: [number, number, string][], width: number, alpha: number) {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1];
        const [x1, y1, c] = points[i];
        ctx.strokeStyle = c;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    function draw() {
      const s = useTraffic.getState();
      const size = map.getSize();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);

      const zoom = map.getZoom();
      const scale = zoom < 5 ? 0.75 : zoom < 8 ? 0.95 : 1.25;
      const bounds = map.getBounds().pad(0.1);
      const items = collect().filter((it) => bounds.contains([it.lat, it.lon]));
      const showLabels = zoom >= 8 && items.length < 400;

      // Short trails for every aircraft
      if (s.showTrails && !s.replay.active) {
        for (const it of items) {
          const t = s.tracks.get(it.id);
          if (!t || t.history.length < 2) continue;
          const pts = t.history.slice(-8).map((o) => {
            const p = map.latLngToContainerPoint([o.lat, o.lon]);
            return [p.x, p.y, altColor(o.alt, o.onGround)] as [number, number, string];
          });
          drawTrail(pts, 1.2, 0.45);
        }
      }

      // Full observed track of the selected aircraft
      const sel = s.selectedId ? s.tracks.get(s.selectedId) : undefined;
      if (sel && !s.replay.active) {
        const pts = sel.history.map((o) => {
          const p = map.latLngToContainerPoint([o.lat, o.lon]);
          return [p.x, p.y, altColor(o.alt, o.onGround)] as [number, number, string];
        });
        drawTrail(pts, 2.5, 0.95);
        for (const [x, y, c] of pts) {
          ctx.fillStyle = c;
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
        // Dashed segment from the last real position to the dead-reckoned one
        const [elat, elon, dt] = estimatePosition(sel, dataNowSec(s));
        if (dt > 0 && pts.length) {
          const e = map.latLngToContainerPoint([elat, elon]);
          const [lx, ly] = pts[pts.length - 1];
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = '#e2e8f0';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(lx, ly);
          ctx.lineTo(e.x, e.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      hitIds = new Array(items.length);
      hitX = new Float32Array(items.length);
      hitY = new Float32Array(items.length);
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'middle';

      items.forEach((it, i) => {
        const p = map.latLngToContainerPoint([it.lat, it.lon]);
        hitIds[i] = it.id;
        hitX[i] = p.x;
        hitY[i] = p.y;
        const color = altColor(it.alt, it.onGround);
        const selected = it.id === s.selectedId;
        const k = selected ? scale * 1.5 : it.onGround ? scale * 0.75 : scale;

        if (it.track === null) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3 * k, 0, Math.PI * 2);
          if (it.stale) {
            ctx.strokeStyle = color;
            ctx.stroke();
          } else {
            ctx.fillStyle = color;
            ctx.fill();
          }
        } else {
          const a = (it.track * Math.PI) / 180;
          const c = Math.cos(a) * k * dpr;
          const sn = Math.sin(a) * k * dpr;
          ctx.setTransform(c, sn, -sn, c, p.x * dpr, p.y * dpr);
          if (it.stale) {
            ctx.globalAlpha = 0.6;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1 / k;
            ctx.stroke(PLANE);
            ctx.globalAlpha = 1;
          } else {
            ctx.fillStyle = color;
            ctx.fill(PLANE);
            ctx.strokeStyle = 'rgba(2,6,23,0.8)';
            ctx.lineWidth = 0.6 / k;
            ctx.stroke(PLANE);
          }
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        if (selected) {
          ctx.strokeStyle = '#f8fafc';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
          ctx.stroke();
        }
        if ((showLabels || selected) && it.label) {
          ctx.fillStyle = selected ? '#f8fafc' : 'rgba(226,232,240,0.8)';
          ctx.fillText(it.label, p.x + 10, p.y - 8);
        }
      });

      // Follow mode
      if (sel && s.follow && !s.replay.active && performance.now() - lastFollow > 1000) {
        lastFollow = performance.now();
        const [lat, lon] = estimatePosition(sel, dataNowSec(s));
        const p = map.latLngToContainerPoint([lat, lon]);
        const c = map.getSize().divideBy(2);
        if (Math.hypot(p.x - c.x, p.y - c.y) > 20) map.panTo([lat, lon], { animate: true, duration: 0.6 });
      }
    }

    function loop(ts: number) {
      raf = requestAnimationFrame(loop);
      if (document.visibilityState === 'hidden') return;
      if (moving || dirty || ts - lastDraw >= FRAME_MS) {
        lastDraw = ts;
        dirty = false;
        draw();
      }
    }
    raf = requestAnimationFrame(loop);

    function hitTest(x: number, y: number): string | null {
      let best = -1;
      let bestD = HIT_RADIUS * HIT_RADIUS;
      for (let i = 0; i < hitIds.length; i++) {
        const dx = hitX[i] - x;
        const dy = hitY[i] - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best >= 0 ? hitIds[best] : null;
    }

    map.on('movestart', () => (moving = true));
    map.on('moveend', () => {
      moving = false;
      dirty = true;
    });
    map.on('zoomstart', () => (canvas.style.visibility = 'hidden'));
    map.on('zoomend', () => {
      canvas.style.visibility = 'visible';
      dirty = true;
    });
    map.on('click', (e: L.LeafletMouseEvent) => {
      const id = hitTest(e.containerPoint.x, e.containerPoint.y);
      useTraffic.getState().select(id);
    });
    map.on('mousemove', (e: L.LeafletMouseEvent) => {
      const tip = tooltipRef.current!;
      const id = hitTest(e.containerPoint.x, e.containerPoint.y);
      container.style.cursor = id ? 'pointer' : '';
      if (!id) {
        tip.style.display = 'none';
        return;
      }
      const t = useTraffic.getState().tracks.get(id);
      tip.style.display = 'block';
      tip.style.left = `${e.containerPoint.x + 14}px`;
      tip.style.top = `${e.containerPoint.y + 14}px`;
      tip.textContent = t
        ? `${t.latest.callsign ?? t.icao24} · ${fmtAlt(trackAltitudeM(t.latest), t.latest.onGround)} · ${fmtSpeed(t.latest.velocity)}`
        : id;
    });
    map.on('mouseout', () => tooltipRef.current && (tooltipRef.current.style.display = 'none'));

    const drawZones = (rules = useTraffic.getState().alertRules) => {
      zoneLayer.clearLayers();
      for (const r of rules) {
        if (r.kind === 'enter-zone' && r.zone && r.enabled) {
          L.rectangle(toBounds(r.zone), { color: '#f97316', weight: 1, fillOpacity: 0.06, interactive: false }).addTo(zoneLayer);
        }
      }
    };
    drawZones();

    const unsub = useTraffic.subscribe((s, prev) => {
      if (s.region !== prev.region) {
        regionRect.setBounds(L.latLngBounds(toBounds(s.region.bbox)));
        map.fitBounds(toBounds(s.region.bbox));
      }
      if (s.alertRules !== prev.alertRules) drawZones(s.alertRules);
      if (s.selectedId !== prev.selectedId && s.selectedId) {
        const t = s.tracks.get(s.selectedId);
        if (t && t.latest.lat !== null && !map.getBounds().contains([t.latest.lat, t.latest.lon!])) {
          map.panTo([t.latest.lat, t.latest.lon!]);
        }
      }
      dirty = true;
    });

    // Expose the map so the sidebar can use "current view" as a region / zone.
    (window as unknown as { __atcMap?: L.Map }).__atcMap = map;

    return () => {
      cancelAnimationFrame(raf);
      unsub();
      ro.disconnect();
      map.remove();
      canvas.remove();
      delete (window as unknown as { __atcMap?: L.Map }).__atcMap;
    };
  }, []);

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map" />
      <div ref={tooltipRef} className="map-tooltip" />
    </div>
  );
}

