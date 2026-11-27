// Collects the latest reading from every Ontario MTO road weather station into one small file.
// Environment Canada republishes the network as one XML file per station on a server that browsers on
// other sites may not read, so a scheduled job (.github/workflows/mto.yml) runs this and publishes the result.
// Run by hand: node scripts/build-mto.mjs [output file]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = 'https://dd.weather.gc.ca';
const day = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
const text = async (url) => {
  for (let go = 0; ; go++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'MTO station collector' }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return '';
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      return await res.text();
    } catch (e) {
      if (go === 2) throw e;
    }
  }
};
const links = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
/** Runs the jobs a few at a time, to stay polite to the server. */
async function pool(items, size, job) {
  const out = [];
  let at = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (at < items.length) {
        const i = at++;
        out[i] = await job(items[i]).catch(() => null);
      }
    }),
  );
  return out;
}

const now = Date.now();
// the folder is per UTC day, so just after midnight a station's newest file is still in yesterday's
const days = [day(now), day(now - 864e5)];
const dir = (d) => `${ROOT}/${d}/WXO-DD/observations/swob-ml/partners/on-mto/${d}/`;
const lists = await Promise.all(days.map((d) => text(dir(d))));
const ids = [...new Set(lists.flatMap((html) => links(html, /href="([a-z0-9]+)\/"/g)))];
if (!ids.length) throw new Error('No MTO station folders found');

// SWOB element name -> our field; the first name present wins
const FIELDS = {
  temp: ['air_temp'],
  dew: ['dwpt_temp'],
  rh: ['rel_hum'],
  wind: ['avg_wnd_spd_10m_pst10mts', 'avg_wnd_spd_10m_pst2mts'],
  dir: ['avg_wnd_dir_10m_pst10mts', 'avg_wnd_dir_10m_pst2mts'],
  gust: ['max_wnd_gst_spd_10m_pst10mts', 'max_wnd_spd_10m_pst10mts'],
  mslp: ['mslp'],
  precip: ['pcpn_amt_pst1hr'],
  snow: ['snw_dpth'],
  vis: ['vis'],
  road: ['pvmnt_sfc_temp_1', 'pvmnt_sfc_temp'],
};

const stations = (
  await pool(ids, 12, async (id) => {
    for (let i = 0; i < days.length; i++) {
      if (!lists[i].includes(`href="${id}/"`)) continue;
      const base = `${dir(days[i])}${id}/`;
      const file = links(await text(base), /href="([^"]+swob\.xml)"/g).sort().pop();
      if (!file) continue;
      const xml = await text(base + file);
      const el = new Map(links(xml, /<element name="([^"]+)" uom="[^"]*" value="[^"]*"/g).map((n) => [n, null]));
      for (const m of xml.matchAll(/<element name="([^"]+)" uom="[^"]*" value="([^"]*)"/g)) if (el.get(m[1]) === null) el.set(m[1], m[2]);
      const time = Date.parse(el.get('date_tm') ?? '');
      const lat = +el.get('lat');
      const lon = +el.get('long');
      // a station silent for two hours is left out rather than shown with an old reading
      if (!(now - time < 2 * 3600e3) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const obs = {};
      for (const [key, names] of Object.entries(FIELDS))
        for (const n of names) {
          const v = el.get(n);
          if (v !== undefined && v !== null && v !== '' && Number.isFinite(+v)) {
            obs[key] = +v;
            break;
          }
        }
      return { id: el.get('msc_id') ?? id, name: el.get('stn_nam') ?? id, lon: +lon.toFixed(4), lat: +lat.toFixed(4), time, obs };
    }
    return null;
  })
).filter(Boolean);

if (!stations.length) throw new Error('No MTO station reported in the past two hours');
const out = resolve(process.argv[2] ?? 'out/mto.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ built: now, stations }));
console.log(`${stations.length} of ${ids.length} MTO stations written to ${out}`);
