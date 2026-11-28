// Collects the last three hours of mPING reports (NOAA/NSSL's crowd-sourced weather reports) into one small file.
// The mPING service only answers requests that carry a personal key, which must not be shipped inside a web page,
// so a scheduled job (.github/workflows/mto.yml) runs this with the key held as the MPING_TOKEN secret.
// Run by hand: MPING_TOKEN=... node scripts/build-mping.mjs [output file]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const token = process.env.MPING_TOKEN;
if (!token) {
  console.log('no MPING_TOKEN set, skipping mPING');
  process.exit(0);
}
const HOURS = 3;
const out = resolve(process.argv[2] ?? 'out/mping.json');
const since = new Date(Date.now() - HOURS * 3600_000).toISOString().slice(0, 19).replace('T', ' ');

const reports = [];
const kinds = {};
let url = `https://mping.ou.edu/mping/api/v2/reports?obtime_gte=${encodeURIComponent(since)}`;
for (let page = 0; url && page < 40; page++) {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json', authorization: `Token ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`mPING answered ${res.status}`);
  const j = await res.json();
  for (const r of j.results ?? []) {
    const [lon, lat] = r.geom?.coordinates ?? [];
    const time = Date.parse(r.obtime);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(time) || r.category === 'Test') continue;
    kinds[r.description_id] = [r.category, r.description];
    reports.push([r.id, +lon.toFixed(4), +lat.toFixed(4), Math.round(time / 1000), r.description_id]);
  }
  // the service hands out its next-page links as plain http
  url = j.next ? j.next.replace(/^http:/, 'https:') : null;
}
reports.sort((a, b) => b[3] - a[3]);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ time: Date.now(), hours: HOURS, kinds, reports }));
console.log(`${reports.length} mPING reports since ${since}Z`);
