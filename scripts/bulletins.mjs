// Shared by the aviation collectors: lists Environment Canada's open bulletins (the Datamart) of one type and reads their text.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'https://api.weather.gc.ca/collections/bulletins-realtime/items?f=json&limit=2000&sortby=-datetime&properties=ttaaii,issuer_code,datetime,url';

/** The bulletins of a WMO type ("SA", "UA") issued in the past `minutes` whose heading matches. */
export async function list(type, minutes, heading) {
  const since = new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 19) + 'Z';
  const found = [];
  for (let offset = 0; offset < 20_000; offset += 2000) {
    const res = await fetch(`${API}&type=${type}&datetime=${since}/..&offset=${offset}`, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new Error(`bulletin list answered ${res.status}`);
    const page = (await res.json()).features ?? [];
    found.push(...page.map((f) => f.properties).filter((p) => heading.test(p.ttaaii)));
    if (page.length < 2000) break;
  }
  return found;
}

/**
 * The text of each bulletin, by address. A bulletin never changes once issued, so the ones read earlier in this run of
 * the job are kept under `name`; one that will not load is left out and tried again next round.
 */
export async function read(bulletins, name) {
  const keptAt = join(tmpdir(), `${name}-bulletins.json`);
  const kept = existsSync(keptAt) ? JSON.parse(readFileSync(keptAt, 'utf8')) : {};
  const texts = {};
  const queue = bulletins.slice();
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let b = queue.shift(); b; b = queue.shift()) {
        if (kept[b.url] === undefined) {
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
  return texts;
}

/** A day-of-month, hour and minute in the month around now. */
export function stamp(dd, hh, mm = 0, now = Date.now()) {
  const d = new Date(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), +dd, +hh, +mm);
  if (t - now > 15 * 864e5) t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, +dd, +hh, +mm);
  if (now - t > 15 * 864e5) t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, +dd, +hh, +mm);
  return t;
}
