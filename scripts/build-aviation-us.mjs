// Collects the SIGMETs and AIRMETs in force over the United States into one small file, with the outlines their issuer drew.
// They come from NOAA's Aviation Weather Center data API, which a web page is not allowed to read directly,
// so the scheduled job (.github/workflows/mto.yml) runs this beside the MTO stations.
// Run by hand: node scripts/build-aviation-us.mjs [output file]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'out/aviation-us.json');
const now = Date.now();
const API = 'https://aviationweather.gov/api/data/';
const get = async (what) => {
  const res = await fetch(`${API}${what}?format=geojson`, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'MTOSTATIONS collector (github.com/snorwx/MTOSTATIONS)' } });
  if (!res.ok) throw new Error(`${what} answered ${res.status}`);
  return (await res.json()).features ?? [];
};

const SIGMET = { CONVECTIVE: 'Thunderstorms', TURB: 'Severe turbulence', ICE: 'Severe icing', ICING: 'Severe icing', IFR: 'Low ceiling and visibility', 'MTN OBSCN': 'Mountains obscured', ASH: 'Volcanic ash', VA: 'Volcanic ash', TS: 'Thunderstorms', TC: 'Tropical cyclone', MTW: 'Severe mountain wave', DS: 'Dust storm', SS: 'Sand storm' };
const AIRMET = {
  IFR: 'Low ceiling and visibility',
  MT_OBSC: 'Mountains obscured',
  'TURB-HI': 'Moderate turbulence, high levels',
  'TURB-LO': 'Moderate turbulence, low levels',
  ICE: 'Moderate icing',
  LLWS: 'Low-level wind shear',
  SFC_WND: 'Strong surface wind',
  M_FZLVL: 'Multiple freezing levels',
};
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const feet = (n) => `${Math.round(n).toLocaleString('en-US')} ft`;
const span = (lo, hi) => (lo != null && hi != null ? `${lo ? feet(lo) : 'Surface'} to ${feet(hi)}` : hi != null ? `Tops to ${feet(hi)}` : lo != null ? `Above ${feet(lo)}` : '');
/** outlines as rings of [lon, lat], rounded */
const rings = (g) => (g?.type === 'Polygon' ? [g.coordinates[0]] : g?.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : []).map((r) => r.map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)]));

const [domestic, graphical, international] = await Promise.allSettled([get('airsigmet'), get('gairmet'), get('isigmet')]);
if (domestic.status === 'rejected' && graphical.status === 'rejected') throw domestic.reason;
const items = [];

for (const f of domestic.status === 'fulfilled' ? domestic.value : []) {
  const p = f.properties;
  if (p.airSigmetType !== 'SIGMET') continue;
  const convective = p.hazard === 'CONVECTIVE' || p.hazard === 'CONVECTIVE SIGMET';
  items.push({
    id: `s-${p.seriesId}-${p.validTimeFrom}`.replace(/\s+/g, ''),
    kind: convective ? 'Convective SIGMET' : 'SIGMET',
    series: p.seriesId ?? '',
    hazard: convective ? 'Thunderstorms' : (SIGMET[p.hazard] ?? p.hazard),
    from: Date.parse(p.validTimeFrom),
    to: Date.parse(p.validTimeTo),
    levels: span(p.altitudeLow1 ?? p.altitudeLow2, p.altitudeHi2 ?? p.altitudeHi1),
    moving: p.movementSpd ? `Moving ${COMPASS[Math.round(((p.movementDir + 180) % 360) / 45) % 8]} at ${p.movementSpd} kt` : '',
    area: 'United States',
    text: p.rawAirSigmet ?? '',
    rings: rings(f.geometry),
  });
}

// the snapshot each graphical AIRMET gives is good until the next one, three hours on
for (const f of graphical.status === 'fulfilled' ? graphical.value : []) {
  const p = f.properties;
  if (!AIRMET[p.hazard] || p.forecast !== 0) continue;
  const lo = p.base === 'SFC' ? 0 : p.base === 'FZL' ? (p.fzlbase === 'SFC' ? 0 : +p.fzlbase * 100) : p.base ? +p.base * 100 : null;
  items.push({
    id: `g-${p.hazard}-${p.tag}-${p.validTime}`,
    kind: 'AIRMET',
    series: `${p.product} ${p.tag}`,
    hazard: AIRMET[p.hazard],
    from: Date.parse(p.issueTime),
    to: Date.parse(p.validTime) + 3 * 3600_000,
    levels: p.top ? span(Number.isNaN(lo) ? null : lo, +p.top * 100) + (p.base === 'FZL' ? ', from the freezing level' : '') : '',
    moving: '',
    area: 'United States',
    text: p.dueTo ? `Due to ${p.dueTo.toLowerCase()}.` : '',
    rings: rings(f.geometry),
  });
}

// Alaska, Hawaii and the oceans the United States looks after come as international SIGMETs
for (const f of international.status === 'fulfilled' ? international.value : []) {
  const p = f.properties;
  if (!/^(K|PA|PH|PG)/.test(p.icaoId ?? '')) continue;
  items.push({
    id: `i-${p.firId}-${p.seriesId}-${p.validTimeFrom}`.replace(/\s+/g, ''),
    kind: 'SIGMET',
    series: p.seriesId ?? '',
    hazard: [p.qualifier && SIGMET[p.hazard] ? null : p.qualifier, SIGMET[p.hazard] ?? p.hazard].filter(Boolean).join(' '),
    from: Date.parse(p.validTimeFrom),
    to: Date.parse(p.validTimeTo),
    levels: span(p.base, p.top),
    moving: p.dir && +p.spd ? `Moving ${p.dir} at ${p.spd} kt` : '',
    area: (p.firName ?? '').replace(/^[A-Z]{4} /, ''),
    text: p.rawSigmet ?? '',
    rings: rings(f.geometry),
  });
}

const live = items.filter((m) => m.rings.length && m.from <= now + 600_000 && m.to > now);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ time: now, items: live }));
console.log(`${live.length} SIGMETs and AIRMETs in force over the United States`);
