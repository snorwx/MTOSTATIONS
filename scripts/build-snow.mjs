// Fetches the US National Ice Center's daily 1 km snow and ice analysis (IMS) for the Northern Hemisphere and
// rewrites it as runs of snow and ice along each row, which is what the site reads. Neither publisher of the
// analysis lets a web page read it directly.
//   node scripts/build-snow.mjs out/snow.bin.gz
import { createGunzip, gzipSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'snow.bin.gz';
const SIZE = 24576;

async function open() {
  // the Ice Center has each day's file hours before the archive at NSIDC
  try {
    const res = await fetch('https://usicecenter.gov/File/DownloadCurrent?pId=59');
    const name = res.headers.get('content-disposition')?.match(/IMS_v3_(\d{4})(\d{3})\d\d_1km\.asc/);
    if (res.ok && name) return { res, year: +name[1], day: +name[2] };
  } catch {}
  const year = new Date().getUTCFullYear();
  for (const y of [year, year - 1]) {
    const dir = `https://noaadata.apps.nsidc.org/NOAA/G02156/1km/${y}/`;
    const list = await fetch(dir).then((r) => (r.ok ? r.text() : ''));
    const last = [...list.matchAll(/href="(ims\d{4}(\d{3})_00UTC_1km_v[\d.]+\.asc\.gz)"/g)].pop();
    if (last) return { res: await fetch(dir + last[1]), year: y, day: +last[2] };
  }
  throw new Error('no snow and ice file found');
}

const { res, year, day } = await open();
if (!res.ok) throw new Error(`snow and ice file answered ${res.status}`);
const time = Date.UTC(year, 0, day);
if (existsSync(out)) {
  const { gunzipSync } = await import('node:zlib');
  const old = gunzipSync(readFileSync(out));
  if (old.readDoubleLE(8) === time) {
    console.log(`already have ${new Date(time).toISOString().slice(0, 10)}`);
    process.exit(0);
  }
}

// rows run south to north on the page, the file's first row being the bottom of the grid.
// A run is a start column and what begins there: 0 nothing, 1 sea or lake ice, 2 snow on land.
const first = new Uint32Array(SIZE + 1);
let starts = new Uint16Array(1 << 22);
let kinds = new Uint8Array(1 << 22);
let n = 0;
let row = 0;
const lines = createInterface({ input: Readable.fromWeb(res.body).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of lines) {
  if (line.length !== SIZE || !/^[0-4]/.test(line)) continue;
  if (row >= SIZE) throw new Error('more rows than expected');
  first[row] = n;
  let was = 0;
  for (let x = 0; x < SIZE; x++) {
    const c = line.charCodeAt(x);
    const k = c === 52 ? 2 : c === 51 ? 1 : 0;
    if (k === was) continue;
    if (n === starts.length) {
      const s = new Uint16Array(n * 2);
      s.set(starts);
      starts = s;
      const kk = new Uint8Array(n * 2);
      kk.set(kinds);
      kinds = kk;
    }
    starts[n] = x;
    kinds[n++] = was = k;
  }
  row++;
}
if (row !== SIZE) throw new Error(`expected ${SIZE} rows, got ${row}`);
first[SIZE] = n;
if (n < 100_000) throw new Error('hardly any snow or ice in the file, not publishing it');

// "IMS1", grid size, time, run count, then the three tables
const head = Buffer.alloc(24);
head.write('IMS1');
head.writeUInt32LE(SIZE, 4);
head.writeDoubleLE(time, 8);
head.writeUInt32LE(n, 16);
const body = Buffer.concat([head, Buffer.from(first.buffer), Buffer.from(starts.buffer, 0, n * 2), Buffer.from(kinds.buffer, 0, n)]);
const packed = gzipSync(body, { level: 9 });
writeFileSync(out, packed);
console.log(`${new Date(time).toISOString().slice(0, 10)}: ${n} runs, ${(packed.length / 1e6).toFixed(2)} MB`);
