// Collects the latest reading from every Ontario MTO road weather station into one small file, and keeps a week of
// each station's readings in hist/<station>.json beside it.
// Environment Canada republishes the network as one XML file per station on a server that browsers on
// other sites may not read, so a scheduled job (.github/workflows/mto.yml) runs this and publishes the result.
// Run by hand: node scripts/build-mto.mjs [output file]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** One SWOB file as { id, name, lon, lat, time, obs }, or null when it has no usable time or place. */
function read(xml, id) {
  const el = new Map();
  for (const m of xml.matchAll(/<element name="([^"]+)" uom="[^"]*" value="([^"]*)"/g)) if (!el.has(m[1])) el.set(m[1], m[2]);
  const time = Date.parse(el.get('date_tm') ?? '');
  const lat = +el.get('lat');
  const lon = +el.get('long');
  if (!Number.isFinite(time) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const obs = {};
  for (const [key, names] of Object.entries(FIELDS))
    for (const n of names) {
      const v = el.get(n);
      if (v !== undefined && v !== '' && Number.isFinite(+v)) {
        obs[key] = +v;
        break;
      }
    }
  return { id: el.get('msc_id') ?? id, name: el.get('stn_nam') ?? id, lon: +lon.toFixed(4), lat: +lat.toFixed(4), time, obs };
}

const out = resolve(process.argv[2] ?? 'out/mto.json');
const histDir = resolve(dirname(out), 'hist');
mkdirSync(histDir, { recursive: true });
const KEEP = 7 * 864e5;
// a station with no history yet is given the past three days, one reading an hour
const BACK = 3;

/** Adds readings to a station's history file (one list per reading, oldest first) and drops what is over a week old. */
function remember(id, readings) {
  const file = resolve(histDir, `${id}.json`);
  let h = { t: [] };
  if (existsSync(file))
    try {
      h = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      h = { t: [] };
    }
  const keys = Object.keys(FIELDS);
  const rows = h.t.map((t, i) => ({ time: t, obs: Object.fromEntries(keys.flatMap((k) => (h[k]?.[i] == null ? [] : [[k, h[k][i]]]))) }));
  const seen = new Set(h.t);
  for (const r of readings)
    if (!seen.has(r.time)) {
      seen.add(r.time);
      rows.push(r);
    }
  const kept = rows.filter((r) => r.time > now - KEEP).sort((a, b) => a.time - b.time);
  const next = { t: kept.map((r) => r.time) };
  for (const k of keys) if (kept.some((r) => r.obs[k] !== undefined)) next[k] = kept.map((r) => r.obs[k] ?? null);
  writeFileSync(file, JSON.stringify(next));
}

const stations = (
  await pool(ids, 12, async (id) => {
    for (let i = 0; i < days.length; i++) {
      if (!lists[i].includes(`href="${id}/"`)) continue;
      const base = `${dir(days[i])}${id}/`;
      const file = links(await text(base), /href="([^"]+swob\.xml)"/g).sort().pop();
      if (!file) continue;
      const got = read(await text(base + file), id);
      // a station silent for two hours is left out rather than shown with an old reading
      if (!got || !(now - got.time < 2 * 3600e3)) return null;
      const past = [got];
      if (!existsSync(resolve(histDir, `${got.id}.json`)))
        for (let d = 0; d <= BACK; d++) {
          const folder = `${dir(day(now - d * 864e5))}${id}/`;
          const hourly = new Map();
          // file names start with the day and time, so the first of each hour is kept
          for (const f of links(await text(folder).catch(() => ''), /href="([^"]+swob\.xml)"/g).sort()) if (!hourly.has(f.slice(0, 13))) hourly.set(f.slice(0, 13), f);
          for (const f of hourly.values()) {
            if (f === file) continue;
            const old = read(await text(folder + f).catch(() => ''), id);
            if (old) past.push(old);
          }
        }
      remember(got.id, past);
      return got;
    }
    return null;
  })
).filter(Boolean);

if (!stations.length) throw new Error('No MTO station reported in the past two hours');
writeFileSync(out, JSON.stringify({ built: now, stations }));
console.log(`${stations.length} of ${ids.length} MTO stations written to ${out}`);
