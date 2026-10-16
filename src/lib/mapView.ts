import type { Map as LeafletMap } from 'leaflet';
import type { BBox } from './types';

/** The map registers itself here so non-map components can read the current view without importing Leaflet. */
export function getMap(): LeafletMap | null {
  return (window as unknown as { __atcMap?: LeafletMap }).__atcMap ?? null;
}

/** Current map view as a bbox (used by "use current view" buttons). */
export function currentViewBBox(): BBox | null {
  const map = getMap();
  if (!map) return null;
  const b = map.getBounds();
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    lamin: Math.max(-90, r(b.getSouth())),
    lomin: Math.max(-180, r(b.getWest())),
    lamax: Math.min(90, r(b.getNorth())),
    lomax: Math.min(180, r(b.getEast())),
  };
}
