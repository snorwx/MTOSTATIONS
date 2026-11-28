// Collects the pilot reports (PIREPs) made over Canada in the past six hours into one small file, each with where it was.
// They come from Environment Canada's open bulletins (the Datamart), which a web page is not allowed to read directly,
// so the scheduled job (.github/workflows/mto.yml) runs this beside the MTO stations.
// A report gives its place as a latitude and longitude, or as an aerodrome, sometimes with a bearing and distance from it;
// scripts/aerodromes.json gives the aerodromes' positions (OurAirports, public domain). Reports placed any other way are left out.
// Run by hand: node scripts/build-pirep.mjs [output file]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { list, read, stamp } from './bulletins.mjs';

const out = resolve(process.argv[2] ?? 'out/pireps.json');
const now = Date.now();
const places = JSON.parse(readFileSync(new URL('./aerodromes.json', import.meta.url), 'utf8'));

const bulletins = await list('UA', 360, /^UACN\d\d$/);
const texts = await read(bulletins, 'pirep');

/** [lon, lat] of an "/OV" field, or null */
function where(ov) {
  const ll = /\b(\d{2})(\d{2})N ?(\d{2,3})(\d{2})W\b/.exec(ov);
  if (ll) return [-(+ll[3] + +ll[4] / 60), +ll[1] + +ll[2] / 60];
  const m = /^(C[A-Z]{3}|[A-Z]{3})(?: (\d{3})(\d{3}))?\b/.exec(ov);
  const at = m && (places[m[1]] ?? places[`C${m[1]}`]);
  if (!at) return null;
  let [, , lon, lat] = at;
  if (m[2]) {
    // bearing in degrees true and distance in nautical miles from the aerodrome
    const b = (+m[2] * Math.PI) / 180;
    const d = +m[3] / 60;
    lat += d * Math.cos(b);
    lon += (d * Math.sin(b)) / Math.cos((lat * Math.PI) / 180);
  }
  return [lon, lat];
}

const seen = new Set();
const items = [];
for (const b of bulletins) {
  const text = texts[b.url];
  if (!text) continue;
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = /\b(UUA|UA) (\/OV .*)$/.exec(flat);
  if (!m) continue;
  const field = (k) => new RegExp(`/${k} (.*?)(?= /[A-Z]{2} |$)`).exec(m[2])?.[1].trim();
  const at = where(field('OV') ?? '');
  const tm = /^(\d{2})(\d{2})/.exec(field('TM') ?? '');
  if (!at || !tm) continue;
  // the bulletin's own heading carries the day
  const day = /^UACN\d\d [A-Z]{4} (\d{2})/.exec(flat)?.[1];
  let time = stamp(day ?? new Date(now).getUTCDate(), tm[1], tm[2], now);
  if (time > Date.parse(b.datetime) + 3600_000) time -= 864e5;
  const report = `${m[1]} ${m[2]}`;
  // a correction repeats the report it replaces
  const key = report.replace(/ \/RM.*$/, '').replace(/\/OV \S+( \d{6})?/, '');
  if (now - time > 6 * 3600_000 || seen.has(key)) continue;
  seen.add(key);
  items.push({
    id: b.url.split('/').pop(),
    urgent: m[1] === 'UUA',
    lon: +at[0].toFixed(3),
    lat: +at[1].toFixed(3),
    time,
    over: field('OV'),
    level: field('FL'),
    aircraft: field('TP'),
    turbulence: field('TB'),
    icing: field('IC'),
    remarks: field('RM'),
    text: report,
  });
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ time: now, items }));
console.log(`${items.length} pilot reports over Canada in the past 6 h, from ${bulletins.length} bulletins`);
