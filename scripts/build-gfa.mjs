// Lists the graphic area forecast (GFA) charts now current for the seven Canadian regions: which image is which, not the images.
// NAV CANADA's flight planning site names each chart by a number that changes with every issue, and a web page is not
// allowed to read that list directly, so the scheduled job (.github/workflows/mto.yml) copies the numbers here.
// The site then loads each chart straight from NAV CANADA: https://plan.navcanada.ca/weather/images/<id>.image
// Run by hand: node scripts/build-gfa.mjs [output file]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'out/gfa.json');

/** region, its name, an aerodrome inside it to ask by, and where its dot goes [lon, lat] */
const REGIONS = [
  ['GFACN31', 'Pacific', 'CYVR', -124.5, 54],
  ['GFACN32', 'Prairies', 'CYWG', -105, 53.5],
  ['GFACN33', 'Ontario and Quebec', 'CYYZ', -79, 49],
  ['GFACN34', 'Atlantic', 'CYHZ', -60, 49.5],
  ['GFACN35', 'Yukon and Northwest Territories', 'CYZF', -122, 64],
  ['GFACN36', 'Nunavut', 'CYFB', -85, 65],
  ['GFACN37', 'Arctic', 'CYRB', -95, 76],
];
const time = (s) => Date.parse(`${s}Z`);

const items = [];
for (const [region, name, site, lon, lat] of REGIONS) {
  try {
    const res = await fetch(`https://plan.navcanada.ca/weather/api/alpha/?site=${site}&image=GFA/CLDWX&image=GFA/TURBC`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const charts = { CLDWX: [], TURBC: [] };
    for (const d of (await res.json()).data) {
      const t = JSON.parse(d.text);
      if (t.geography !== region || !charts[t.sub_product]) continue;
      // the newest issue, and within it the newest drawing of each chart (an amended one replaces the first)
      const issue = t.frame_lists.reduce((a, b) => (time(b.sv) > time(a.sv) ? b : a));
      charts[t.sub_product] = issue.frames
        .filter((f) => f.images.length)
        .map((f) => {
          const image = f.images.reduce((a, b) => (b.created > a.created ? b : a));
          return { id: image.id, from: time(f.sv), to: time(f.ev), made: time(image.created) };
        })
        .sort((a, b) => a.from - b.from);
    }
    if (charts.CLDWX.length || charts.TURBC.length) items.push({ region, name, lon, lat, clouds: charts.CLDWX, icing: charts.TURBC });
  } catch (e) {
    console.log(`${region} left out this round: ${e.message}`);
  }
}
if (!items.length) throw new Error('no area forecast charts found');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ time: Date.now(), items }));
console.log(`${items.length} area forecast regions, ${items.reduce((n, i) => n + i.clouds.length + i.icing.length, 0)} charts`);
