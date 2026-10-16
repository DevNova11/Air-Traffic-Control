// Record raw OpenSky /states/all responses for the offline / outage fallback.
//
//   node scripts/record.mjs [frames=3] [intervalSec=12] [lamin lomin lamax lomax]
//
// Uses OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET from the environment if set,
// otherwise anonymous access. Each frame costs 1–4 credits depending on area.
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

const [frames = '3', interval = '12', ...box] = process.argv.slice(2);
const [lamin, lomin, lamax, lomax] = box.length === 4 ? box : ['44', '0', '52', '16'];
const outDir = path.join(process.cwd(), 'data', 'recorded');

async function token() {
  const { OPENSKY_CLIENT_ID: id, OPENSKY_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) return null;
  const res = await fetch(
    'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
    },
  );
  if (!res.ok) throw new Error(`auth failed: ${res.status}`);
  return (await res.json()).access_token;
}

await mkdir(outDir, { recursive: true });
const t = await token();
const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;

for (let i = 1; i <= Number(frames); i++) {
  const res = await fetch(url, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);
  const body = await res.text();
  const file = path.join(outDir, `frame${i}.json`);
  await writeFile(file, body);
  const json = JSON.parse(body);
  console.log(`${file}: time=${json.time} aircraft=${json.states?.length ?? 0} credits left=${res.headers.get('x-rate-limit-remaining')}`);
  if (i < Number(frames)) await new Promise((r) => setTimeout(r, Number(interval) * 1000));
}
