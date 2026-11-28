// Collects the upper wind and temperature forecasts (FB and FD) for Canadian aerodromes into one small file, decoded.
// They come from Environment Canada's open bulletins (the Datamart), which a web page is not allowed to read directly,
// so the scheduled job (.github/workflows/mto.yml) runs this beside the MTO stations.
// scripts/aerodromes.json gives the positions (OurAirports, public domain). The forecast points that are not aerodromes are left out.
// Run by hand: node scripts/build-winds.mjs [output file]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { list, read, stamp } from './bulletins.mjs';

const out = resolve(process.argv[2] ?? 'out/winds.json');
const now = Date.now();
const places = {
  ...JSON.parse(readFileSync(new URL('./aerodromes.json', import.meta.url), 'utf8')),
  // forecast points OurAirports files under another code
  CYMV: ['Mary River Aerodrome', 'NU', -79.357, 71.324],
  CYSV: ['Saglek Airport', 'NL', -62.654, 58.474],
  CYJT: ['Stephenville Airport', 'NL', -58.553, 48.543],
};

// issued four times a day, each for use over the following day
const bulletins = [...(await list('FB', 20 * 60, /^FBCN\d\d$/)), ...(await list('FD', 20 * 60, /^FDCN\d\d$/))].filter((b) => b.issuer_code === 'CWAO');
const texts = await read(bulletins, 'winds');

/** "2413-05": from 240 degrees at 13 knots, -5 C. 9900 is light and variable; a direction past 50 carries 100 knots. */
function group(g) {
  const m = /^(\d\d)(\d\d)([+-]\d\d)?$/.exec(g);
  if (!m) return null;
  let dir = +m[1] * 10;
  let kt = +m[2];
  if (m[1] === '99') dir = -1;
  else if (dir > 500) [dir, kt] = [dir - 500, kt + 100];
  return [dir, kt, m[3] === undefined ? null : +m[3]];
}

/** site -> valid time -> the forecast, the newest issue winning */
const sites = new Map();
for (const b of [...bulletins].sort((a, c) => a.datetime.localeCompare(c.datetime))) {
  const text = texts[b.url];
  if (!text) continue;
  const issued = Date.parse(`${b.datetime}Z`) || now;
  let span = null;
  let cols = null;
  const head = /BASED ON (\d\d)(\d\d)(\d\d)Z?[\s\S]*?VALID (\d\d)(\d\d)(\d\d)Z?\s+FOR USE (\d\d)(?:\d\d)?-(\d\d)/g;
  const spans = [...text.matchAll(head)].map((m) => {
    const valid = stamp(m[4], m[5], m[6], issued);
    let from = stamp(m[4], m[7], 0, issued);
    if (from > valid) from -= 864e5;
    let to = stamp(m[4], m[8], 0, issued);
    if (to <= valid) to += 864e5;
    return { at: m.index, based: stamp(m[1], m[2], m[3], issued), valid, from, to };
  });
  let at = 0;
  for (const line of text.split('\n')) {
    const here = at;
    at += line.length + 1;
    span = spans.findLast((s) => s.at <= here) ?? span;
    if (/^\s+\d{4,5}(\s+\d{4,5})+\s*$/.test(line)) {
      cols = [...line.matchAll(/\d{4,5}/g)].map((m) => [m.index, +m[0]]);
      continue;
    }
    const m = /^([A-Z0-9]{3}) /.exec(line);
    if (!m || !span || !cols || span.to <= now) continue;
    const place = places[`C${m[1]}`];
    if (!place) continue;
    const levels = [];
    cols.forEach(([x, ft], i) => {
      const g = group(line.slice(x, cols[i + 1]?.[0] ?? line.length).trim());
      if (g) levels.push([ft, ...g]);
    });
    if (!levels.length) continue;
    if (!sites.has(m[1])) sites.set(m[1], new Map());
    sites.get(m[1]).set(span.valid, { valid: span.valid, from: span.from, to: span.to, based: span.based, levels });
  }
}

const items = [...sites.entries()]
  .map(([id, spans]) => {
    const [name, region, lon, lat] = places[`C${id}`];
    return { site: `C${id}`, name, region, lon, lat, periods: [...spans.values()].sort((a, b) => a.valid - b.valid) };
  })
  .sort((a, b) => a.site.localeCompare(b.site));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ time: now, items }));
console.log(`${items.length} upper wind forecasts over Canada, from ${bulletins.length} bulletins`);
