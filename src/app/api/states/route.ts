import { NextRequest, NextResponse } from 'next/server';
import { isValidBBox } from '@/lib/geo';
import { getStates, ProxyError, proxyStats, type SimulationMode } from '@/lib/opensky-server';

const SIMULATIONS: SimulationMode[] = ['outage', 'ratelimit', 'recorded', 'down'];

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/states?lamin=&lomin=&lamax=&lomax=
 * Thin proxy in front of OpenSky's /states/all. See src/lib/opensky-server.ts.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;

  if (p.has('stats')) return NextResponse.json(proxyStats());

  const bbox = {
    lamin: Number(p.get('lamin')),
    lomin: Number(p.get('lomin')),
    lamax: Number(p.get('lamax')),
    lomax: Number(p.get('lomax')),
  };
  if (!isValidBBox(bbox)) {
    return NextResponse.json({ error: 'Invalid bounding box' }, { status: 400 });
  }

  const sim = p.get('simulate') as SimulationMode | null;
  const simulate = sim && SIMULATIONS.includes(sim) ? sim : undefined;

  try {
    const data = await getStates(bbox, simulate);
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const status = err instanceof ProxyError ? err.status : 502;
    const retryAfterSec = err instanceof ProxyError ? err.retryAfterSec : null;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upstream failure', retryAfterSec },
      {
        status,
        headers: retryAfterSec ? { 'Retry-After': String(retryAfterSec) } : undefined,
      },
    );
  }
}
