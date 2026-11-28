// Collects the newest aerodrome forecast (TAF) for each Canadian aerodrome into one small file, with where each one is.
// They come from Environment Canada's open bulletins (the Datamart), which a web page is not allowed to read directly,
// so the scheduled job (.github/workflows/mto.yml) runs this beside the MTO stations.
// scripts/aerodromes.json gives the positions: Canadian aerodromes from OurAirports (public domain).
// Run by hand: node scripts/build-taf.mjs [output file]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'out/taf.json');
const now = Date.now();
const places = JSON.parse(readFileSync(new URL('./aerodromes.json', import.meta.url), 'utf8'));
// forecasts come out every six hours and run for up to thirty
const since = new Date(now - 13 * 3600_000).toISOString().slice(0, 19) + 'Z';
const API = 'https://api.weather.gc.ca/collections/bulletins-realtime/items?f=json&type=FT&issuer_code=CWAO&limit=500&sortby=-datetime';

// a bulletin never changes once issued, so the ones read earlier in this run of the job are kept
const keptAt = join(tmpdir(), 'taf-bulletins.json');
const kept = existsSync(keptAt) ? JSON.parse(readFileSync(keptAt, 'utf8')) : {};

const bulletins = [];
for (let offset = 0; offset < 3000; offset += 500) {
  const res = await fetch(`${API}&datetime=${since}/..&offset=${offset}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`bulletin list answered ${res.status}`);
  const page = ((await res.json()).features ?? []).map((f) => f.properties).filter((p) => /^FTCN\d\d$/.test(p.ttaaii));
  bulletins.push(...page);
  if (page.length < 400) break;
}

const texts = {};
const queue = bulletins.slice();
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      if (kept[b.url] === undefined) {
        // one bulletin that will not load must not cost the rest; it is tried again next round
        try {
          const res = await fetch(b.url, { signal: AbortSignal.timeout(30_000) });
          if (!res.ok) continue;
          kept[b.url] = await res.text();
        } catch {
          continue;
        }
      }
      texts[b.url] = kept[b.url];
    }
  }),
);
writeFileSync(keptAt, JSON.stringify(texts));

/** ddhhmm, or ddhh, in the month around now */
function stamp(dd, hh, mm = 0) {
  const d = new Date(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), +dd, +hh, +mm);
  if (t - now > 15 * 864e5) t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, +dd, +hh, +mm);
  if (now - t > 15 * 864e5) t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, +dd, +hh, +mm);
  return t;
}

const newest = new Map();
for (const text of Object.values(texts)) {
  // one bulletin can carry several forecasts, each ending in "="
  for (const part of text.split('=')) {
    const flat = part.replace(/\s+/g, ' ').trim();
    const m = /\bTAF (?:(AMD|COR) )?(C[A-Z]{3}) (\d{2})(\d{2})(\d{2})Z (\d{2})(\d{2})\/(\d{2})(\d{2}) (.*)$/.exec(flat);
    if (!m || /\bNIL\b|\bCNL\b/.test(m[10].slice(0, 12))) continue;
    const [, , site, dd, hh, mm, fd, fh, td, th] = m;
    const issued = stamp(dd, hh, mm);
    const to = stamp(td, th);
    if (to <= now || issued > now + 600_000 || !places[site]) continue;
    if ((newest.get(site)?.issued ?? 0) >= issued) continue;
    const [name, region, lon, lat] = places[site];
    // the forecast as its issuer laid it out: one change group to a line
    const lines = flat
      .slice(flat.indexOf('TAF '))
      .replace(/ (FM\d{6}|BECMG \d{4}\/\d{4}|RMK )/g, '\n$1')
      .trim();
    newest.set(site, { site, name, region, lon, lat, issued, from: stamp(fd, fh), to, text: lines });
  }
}
const items = [...newest.values()].sort((a, b) => a.site.localeCompare(b.site));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ time: now, items }));
console.log(`${items.length} aerodrome forecasts in force over Canada, from ${bulletins.length} bulletins since ${since}`);
