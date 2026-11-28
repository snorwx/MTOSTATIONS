// Collects the newest weather report (METAR or SPECI) from each Canadian aerodrome into one small file, as issued.
// They come from Environment Canada's open bulletins (the Datamart), which a web page is not allowed to read directly,
// so the scheduled job (.github/workflows/mto.yml) runs this beside the MTO stations.
// scripts/aerodromes.json gives the positions: Canadian aerodromes from OurAirports (public domain).
// Run by hand: node scripts/build-metar.mjs [output file]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { list, read, stamp } from './bulletins.mjs';

const out = resolve(process.argv[2] ?? 'out/metar.json');
const now = Date.now();
const places = JSON.parse(readFileSync(new URL('./aerodromes.json', import.meta.url), 'utf8'));

// hourly reports, and the specials issued between them
const bulletins = [...(await list('SA', 100, /^SACN\d\d$/)), ...(await list('SP', 100, /^SPCN\d\d$/))];
const texts = await read(bulletins, 'metar');

const newest = new Map();
for (const text of Object.values(texts)) {
  for (const part of text.split('=')) {
    const flat = part.replace(/\s+/g, ' ').trim();
    const m = /\b(METAR|SPECI|LWIS) (?:COR )?(C[A-Z]{3}) (\d{2})(\d{2})(\d{2})Z (.*)$/.exec(flat);
    if (!m || /^NIL\b/.test(m[6]) || !places[m[2]]) continue;
    const time = stamp(m[3], m[4], m[5], now);
    if (time > now + 600_000 || now - time > 100 * 60_000) continue;
    if ((newest.get(m[2])?.time ?? 0) >= time) continue;
    const [name, region, lon, lat] = places[m[2]];
    newest.set(m[2], { site: m[2], name, region, lon, lat, time, text: flat.slice(m.index) });
  }
}
const items = [...newest.values()].sort((a, b) => a.site.localeCompare(b.site));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ time: now, items }));
console.log(`${items.length} aerodrome weather reports over Canada, from ${bulletins.length} bulletins`);
