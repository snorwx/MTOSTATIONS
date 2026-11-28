// Collects the SIGMETs and AIRMETs in force over Canada into one small file, each with its area worked out as an outline.
// They come from Environment Canada's open bulletins (the Datamart), which a web page is not allowed to read directly,
// so the scheduled job (.github/workflows/mto.yml) runs this beside the MTO stations.
// Run by hand: node scripts/build-aviation.mjs [output file]   (AVIATION_NOW=2026-11-28T02:00Z replays an earlier moment)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'out/aviation.json');
const now = process.env.AVIATION_NOW ? Date.parse(process.env.AVIATION_NOW) : Date.now();
// a SIGMET lasts at most four hours, six for volcanic ash and tropical cyclones
const since = new Date(now - 8 * 3600_000).toISOString().slice(0, 19) + 'Z';
const until = new Date(now).toISOString().slice(0, 19) + 'Z';
const API = 'https://api.weather.gc.ca/collections/bulletins-realtime/items?f=json&issuer_code=CWAO&limit=500&sortby=-datetime';

const HAZARDS = [
  [/\bTC\b/, 'Tropical cyclone'],
  [/\bVA\b/, 'Volcanic ash'],
  [/\bRDOACT CLD\b/, 'Radioactive cloud'],
  [/\b(?:SEV|MOD|MDT) ICE \(FZRA\)/, 'icing in freezing rain'],
  [/\b(?:SEV|MOD|MDT) ICE\b/, 'icing'],
  [/\b(?:SEV|MOD|MDT) TURB\b/, 'turbulence'],
  [/\b(?:SEV|MOD|MDT) MTW\b/, 'mountain wave'],
  [/\bLLWS\b/, 'Low-level wind shear'],
  [/\bSQLN? TS(?:GR)?\b/, 'Squall line thunderstorms'],
  [/\bFRQ TS(?:GR)?\b/, 'Frequent thunderstorms'],
  [/\bEMBD TS(?:GR)?\b/, 'Embedded thunderstorms'],
  [/\bOBSC TS(?:GR)?\b/, 'Obscured thunderstorms'],
  [/\bISOLD? TS(?:GR)?\b/, 'Isolated thunderstorms'],
  [/\bOCNL TS(?:GR)?\b/, 'Occasional thunderstorms'],
  [/\bTS(?:GR)?\b/, 'Thunderstorms'],
  [/\bHVY (?:DS|SS)\b/, 'Heavy dust or sand storm'],
  [/\bSFC WI?ND\b/, 'Strong surface wind'],
  [/\bSFC VIS\b/, 'Low visibility'],
  [/\b(?:BKN|OVC) CLD\b/, 'Low cloud'],
  [/\bMT OBSC\b/, 'Mountains obscured'],
];

/** ddhhmm in the month around `near` */
function stamp(ddhhmm, near) {
  const d = new Date(near);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), +ddhhmm.slice(0, 2), +ddhhmm.slice(2, 4), +ddhhmm.slice(4, 6));
  if (t - near > 15 * 864e5) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, +ddhhmm.slice(0, 2), +ddhhmm.slice(2, 4), +ddhhmm.slice(4, 6));
  if (near - t > 15 * 864e5) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, +ddhhmm.slice(0, 2), +ddhhmm.slice(2, 4), +ddhhmm.slice(4, 6));
  return t;
}

const NM = 1852;
const R = 6371008;
const round = (p) => [+p[0].toFixed(3), +p[1].toFixed(3)];

/** The outline `nm` nautical miles around a point or a line of points, worked on a flat sheet centred on them. */
function around(points, nm) {
  const lat0 = points.reduce((s, p) => s + p[1], 0) / points.length;
  const lon0 = points.reduce((s, p) => s + p[0], 0) / points.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const flat = points.map(([lon, lat]) => [(((lon - lon0) * Math.PI) / 180) * R * k, (((lat - lat0) * Math.PI) / 180) * R]);
  const back = ([x, y]) => round([lon0 + ((x / (R * k)) * 180) / Math.PI, lat0 + ((y / R) * 180) / Math.PI]);
  const r = nm * NM;
  const arc = (c, from, to) => {
    const ring = [];
    for (let i = 0; i <= 12; i++) {
      const a = from + ((to - from) * i) / 12;
      ring.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
    return ring;
  };
  if (flat.length === 1) return arc(flat[0], 0, 2 * Math.PI).concat(arc(flat[0], 0, 2 * Math.PI).slice(13)).map(back);
  const heading = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  const side = (sign) => {
    const ring = [];
    for (let i = 0; i < flat.length; i++) {
      const before = i > 0 ? heading(flat[i - 1], flat[i]) : heading(flat[i], flat[i + 1]);
      const after = i < flat.length - 1 ? heading(flat[i], flat[i + 1]) : before;
      let turn = after - before;
      while (turn > Math.PI) turn -= 2 * Math.PI;
      while (turn < -Math.PI) turn += 2 * Math.PI;
      const mid = before + turn / 2 + (sign * Math.PI) / 2;
      const reach = r / Math.max(0.5, Math.cos(turn / 2));
      ring.push([flat[i][0] + reach * Math.cos(mid), flat[i][1] + reach * Math.sin(mid)]);
    }
    return ring;
  };
  const n = flat.length;
  const endsAt = heading(flat[n - 2], flat[n - 1]);
  const startsAt = heading(flat[0], flat[1]);
  const ring = [
    ...side(1),
    ...arc(flat[n - 1], endsAt + Math.PI / 2, endsAt - Math.PI / 2),
    ...side(-1).reverse(),
    ...arc(flat[0], startsAt - Math.PI / 2, startsAt - (3 * Math.PI) / 2),
  ];
  ring.push(ring[0]);
  return ring.map(back);
}

function parse(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const head = /\b(CZ[A-Z]{2}) (SIGMET|AIRMET) ([A-Z])(\d+) VALID (\d{6})\/(\d{6}) (\w{4})-\s*CZ[A-Z]{2} (.+?) FIR (.*?)=?$/.exec(flat);
  if (!head) return null;
  const [, fir, kind, series, number, from, to, , firName, body] = head;
  const cancels = /^CNL (?:SIGMET|AIRMET) ([A-Z])(\d+)/.exec(body);
  const item = { fir, kind, series, number: +number, from: stamp(from, now), to: stamp(to, now), firName: firName.replace(/ DOMESTIC| OCEANIC/, '') };
  if (cancels) return { ...item, cancels: cancels[1] + +cancels[2] };
  const points = [...body.matchAll(/([NS])(\d{2})(\d{2}) ([EW])(\d{3})(\d{2})/g)].map((m) =>
    round([(m[4] === 'W' ? -1 : 1) * (+m[5] + +m[6] / 60), (m[1] === 'S' ? -1 : 1) * (+m[2] + +m[3] / 60)]),
  );
  if (!points.length) return null;
  const wide = /WI (\d+)\s?NM WID LINE/.exec(body);
  const within = /WI (\d+)\s?NM OF/.exec(body);
  let ring;
  if (wide && points.length > 1) ring = around(points, +wide[1] / 2);
  else if (within) ring = around(points, +within[1]);
  else if (wide) ring = around(points, +wide[1] / 2);
  else if (points.length > 2) ring = [...points, points[0]];
  else ring = around(points, 20);
  const hazard = HAZARDS.find(([re]) => re.test(body))?.[1] ?? 'Hazard';
  const strength = /\bSEV\b/.test(body) ? 'Severe ' : /\b(?:MOD|MDT)\b/.test(body) ? 'Moderate ' : '';
  const levels = /\b(SFC\/FL\d{3}|FL\d{3}\/\d{3}|TOP (?:ABV )?FL\d{3}|\d{3,5}\/\d{3,5}FT|SFC\/\d{3,5}FT)\b/.exec(body)?.[1] ?? '';
  const moving = /\b(STNR|MOV [A-Z]{1,3} \d+KT)\b/.exec(body)?.[1] ?? '';
  const trend = /\b(NC|WKN|INTSF)$/.exec(body.replace(/ RMK.*$/, ''))?.[1] ?? '';
  return {
    ...item,
    hazard: /^[a-z]/.test(hazard) ? strength + hazard : hazard,
    seen: /\bOBS\b/.test(body) ? 'observed' : 'forecast',
    levels,
    moving,
    trend,
    text: text.trim(),
    ring,
  };
}

async function listed(type) {
  const res = await fetch(`${API}&type=${type}&datetime=${since}/${until}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`bulletin list answered ${res.status}`);
  const j = await res.json();
  // ..CN0x is the international wording, ..CN2x the same message in the domestic one
  return (j.features ?? []).map((f) => f.properties).filter((p) => /^W[SACV]CN0\d$/.test(p.ttaaii));
}

const bulletins = (await Promise.all(['WS', 'WA', 'WC', 'WV'].map(listed))).flat();
const parsed = [];
const queue = bulletins.slice();
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const res = await fetch(b.url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`bulletin answered ${res.status}`);
      const item = parse(await res.text());
      if (item) parsed.push(item);
    }
  }),
);

// a later number in a series replaces the earlier one, and a cancellation ends it
const key = (m) => `${m.fir}|${m.kind}|${m.series}`;
const latest = new Map();
for (const m of parsed) if (m.from <= now + 600_000 && (latest.get(key(m))?.number ?? -1) < m.number) latest.set(key(m), m);
const items = [...latest.values()]
  .filter((m) => !m.cancels && m.to > now)
  .map(({ number, ...m }) => ({ ...m, id: `${m.fir}-${m.kind}-${m.series}${number}`, series: m.series + number }))
  .sort((a, b) => a.id.localeCompare(b.id))
  // one hazard lying across several flight information regions is issued once for each: keep one, naming them all
  .reduce((kept, m) => {
    const twin = kept.find((k) => k.kind === m.kind && k.hazard === m.hazard && JSON.stringify(k.ring) === JSON.stringify(m.ring));
    if (twin) twin.firName += `, ${m.firName}`;
    else kept.push(m);
    return kept;
  }, []);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ time: now, items }));
console.log(`${items.length} SIGMETs and AIRMETs in force over Canada, from ${bulletins.length} bulletins since ${since}`);
