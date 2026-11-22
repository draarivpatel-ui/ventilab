import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as E from '../src/engine.js';
import * as R from '../src/retrofit.js';
import * as D from '../src/schoolday.js';
import * as B from '../src/brief.js';
import * as C from '../src/roomcodec.js';
import * as T from '../src/selftest.js';
import { sha256HexSync, sha256Bytes } from '../src/sha256.js';

const std = () => E.getPreset('standard28').params;
const crypto256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const signed = (input = std()) => B.signBrief(B.engineeringBrief(input));

// ---------- Pure-JS SHA-256 ----------

test('240. SHA-256 of the empty message matches FIPS 180-4', () => {
  assert.equal(sha256HexSync(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('241. SHA-256 of "abc" matches the FIPS 180-4 known answer', () => {
  assert.equal(sha256HexSync('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('242. SHA-256 of the 56-byte FIPS vector matches', () => {
  const msg = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
  assert.equal(sha256HexSync(msg), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

const toHex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

test('243. SHA-256 of one million "a" bytes matches the long-message KAT', () => {
  const bytes = new Uint8Array(1000000).fill(97);
  assert.equal(toHex(sha256Bytes(bytes)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('244. digest output is 64 lowercase hex characters', () => {
  const out = sha256HexSync('VentiLab');
  assert.match(out, /^[0-9a-f]{64}$/);
});

test('245. the implementation is deterministic across calls', () => {
  assert.equal(sha256HexSync('deterministic'), sha256HexSync('deterministic'));
});

test('246. distinct inputs give distinct digests', () => {
  assert.notEqual(sha256HexSync('alpha'), sha256HexSync('alphb'));
  assert.notEqual(sha256HexSync('alpha'), sha256HexSync('alpha '));
});

test('247. block boundaries agree with node:crypto', async (t) => {
  const lengths = [1, 2, 3, 54, 55, 56, 57, 63, 64, 65, 119, 127, 128, 129, 255, 256, 1000, 4096];
  for (const len of lengths) {
    await t.test(`length ${len}`, () => {
      const msg = 'x'.repeat(len);
      assert.equal(sha256HexSync(msg), crypto256(msg));
    });
  }
});

test('248. UTF-8 strings agree with node:crypto', async (t) => {
  for (const msg of ['héllo wörld', '', 'emoji 🔥 ok', 'café — em dash', '\u0000nul\u0001']) {
    await t.test(JSON.stringify(msg), () => {
      assert.equal(sha256HexSync(msg), crypto256(msg));
    });
  }
});

test('249. sha256Bytes matches the text path and node:crypto on raw bytes', () => {
  const enc = new TextEncoder();
  for (const msg of ['bytes-path', '', '']) {
    const bytes = enc.encode(msg);
    assert.equal(toHex(sha256Bytes(bytes)), crypto256(msg));
    assert.equal(toHex(sha256Bytes(bytes)), sha256HexSync(msg));
  }
});

test('250. sha256Bytes handles bytes outside ASCII', () => {
  const bytes = Uint8Array.from([0xff, 0x00, 0x80, 0x7f, 0xfe, 0x01, 0x40]);
  assert.equal(toHex(sha256Bytes(bytes)), createHash('sha256').update(bytes).digest('hex'));
});

// ---------- Room bookmark codec ----------

test('251. encodeRoom emits a bounded base64url room hash', () => {
  const h = C.encodeRoom({ ...std(), presetId: 'standard28', retrofitId: 'school-package' });
  assert.ok(h.startsWith('#room='));
  assert.match(h, /^#room=[A-Za-z0-9_-]+$/);
  assert.ok(h.length <= 1200);
});

test('252. a room bookmark round-trips every mapped field', () => {
  const state = {
    presetId: 'standard28', students: 24, volume: 250, outdoorCO2: 450, outdoorPM: 12,
    windSpeed: 3.5, deltaT: -4, windowMode: 'single', windowOpen: 0.4, mechOA: 300,
    infectious: 2, quantaRate: 50, maskEfficiency: 0.5, crBoxes: 2, hepaUnits: 1,
    merv13: true, uvgi: false, budget: 800, retrofitId: 'cr-box-2',
  };
  const res = C.decodeRoom(C.encodeRoom(state));
  assert.ok(res.ok);
  assert.equal(res.state.students, 24);
  assert.equal(res.state.volume, 250);
  assert.equal(res.state.outdoorCO2, 450);
  assert.equal(res.state.outdoorPM, 12);
  assert.equal(res.state.windSpeed, 3.5);
  assert.equal(res.state.deltaT, -4);
  assert.equal(res.state.windowMode, 'single');
  assert.equal(res.state.windowOpen, 0.4);
  assert.equal(res.state.mechOA, 300);
  assert.equal(res.state.infectious, 2);
  assert.equal(res.state.quantaRate, 50);
  assert.equal(res.state.maskEfficiency, 0.5);
  assert.equal(res.state.crBoxes, 2);
  assert.equal(res.state.hepaUnits, 1);
  assert.equal(res.state.merv13, true);
  assert.equal(res.state.uvgi, false);
  assert.equal(res.state.budget, 800);
  assert.equal(res.state.retrofitId, 'cr-box-2');
});

test('253. every preset id round-trips through the codec', async (t) => {
  for (const preset of E.PRESETS) {
    await t.test(preset.id, () => {
      const res = C.decodeRoom(C.encodeRoom({ ...preset.params, presetId: preset.id }));
      assert.ok(res.ok);
      assert.equal(res.state.presetId, preset.id);
      assert.equal(res.state.students, preset.params.students);
      assert.equal(res.state.volume, preset.params.volume);
    });
  }
});

test('254. every comparator retrofit id round-trips', async (t) => {
  for (const id of ['custom', ...R.RETROFIT_IDS, 'best-under-budget']) {
    await t.test(id, () => {
      const res = C.decodeRoom(C.encodeRoom({ ...std(), presetId: 'standard28', retrofitId: id }));
      assert.ok(res.ok);
      assert.equal(res.state.retrofitId, id);
    });
  }
});

test('255. encoding is deterministic', () => {
  const s = { ...std(), presetId: 'standard28', retrofitId: 'hepa-400' };
  assert.equal(C.encodeRoom(s), C.encodeRoom(s));
});

test('256. the decoded window percentage becomes a fraction', () => {
  const res = C.decodeRoom(C.encodeRoom({ ...std(), windowOpen: 0.25 }));
  assert.ok(res.ok);
  assert.equal(res.state.windowOpen, 0.25);
});

test('257. decodeRoom works with or without the leading hash', () => {
  const h = C.encodeRoom({ ...std(), students: 30 });
  const withHash = C.decodeRoom(h);
  const without = C.decodeRoom(h.slice(1));
  assert.ok(withHash.ok && without.ok);
  assert.equal(without.state.students, 30);
});

test('258. decodeRoom accepts a minimal version-only bookmark', () => {
  const body = Buffer.from(JSON.stringify({ v: 1 }), 'utf8').toString('base64url');
  const res = C.decodeRoom(`#room=${body}`);
  assert.ok(res.ok);
  assert.deepEqual(res.fields, ['v']);
});

const craft = (obj) => `#room=${Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')}`;

test('259. decodeRoom rejects non-string input', async (t) => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    await t.test(String(bad), () => assert.equal(C.decodeRoom(bad).ok, false));
  }
});

test('260. decodeRoom rejects hashes without the room= prefix', async (t) => {
  for (const bad of ['', '#', '#v=1&s=28', '#rooms=AAAA', 'room', '#room', 'room=', '#ROOM=AAAA']) {
    await t.test(JSON.stringify(bad), () => assert.equal(C.decodeRoom(bad).ok, false));
  }
});

test('261. decodeRoom rejects malformed base64url bodies', async (t) => {
  for (const bad of ['#room=', '#room=!', '#room=a', '#room=abc.', '#room=ab cd', '#room=++++', '#room=////']) {
    await t.test(JSON.stringify(bad), () => assert.equal(C.decodeRoom(bad).ok, false));
  }
});

test('262. decodeRoom rejects oversized payloads', () => {
  assert.equal(C.decodeRoom(`#room=${'A'.repeat(2000)}`).ok, false);
  const tooManyBytes = Buffer.alloc(810, 65).toString('base64url');
  assert.equal(C.decodeRoom(`#room=${tooManyBytes}`).ok, false);
});

test('263. decodeRoom rejects bodies that are not JSON', () => {
  const res = C.decodeRoom(`#room=${Buffer.from('not json at all', 'utf8').toString('base64url')}`);
  assert.equal(res.ok, false);
});

test('264. decodeRoom rejects non-object JSON payloads', async (t) => {
  for (const bad of ['[1,2]', '42', '"x"', 'null', 'true']) {
    await t.test(bad, () => {
      assert.equal(C.decodeRoom(`#room=${Buffer.from(bad, 'utf8').toString('base64url')}`).ok, false);
    });
  }
});

test('265. decodeRoom rejects unknown fields', async (t) => {
  for (const obj of [{ v: 1, zz: 1 }, { v: 1, students: 28 }, { v: 1, co2Peak: 5 }]) {
    await t.test(JSON.stringify(obj), () => assert.equal(C.decodeRoom(craft(obj)).ok, false));
  }
});

test('266. decodeRoom rejects prototype-polluting keys', async (t) => {
  const rawJson = ['{"v":1,"__proto__":{"x":1}}', '{"v":1,"constructor":1}', '{"v":1,"prototype":1}'];
  for (const json of rawJson) {
    await t.test(json, () => {
      const res = C.decodeRoom(`#room=${Buffer.from(json, 'utf8').toString('base64url')}`);
      assert.equal(res.ok, false);
    });
  }
});

test('267. decodeRoom enforces the version gate', async (t) => {
  for (const obj of [{ v: 2 }, { v: 0 }, { v: '1' }, { s: 28 }]) {
    await t.test(JSON.stringify(obj), () => assert.equal(C.decodeRoom(craft(obj)).ok, false));
  }
});

test('268. decodeRoom rejects out-of-range and non-integer numbers', async (t) => {
  const cases = [
    { v: 1, s: 61 }, { v: 1, s: -1 }, { v: 1, s: 28.5 },
    { v: 1, vol: 49 }, { v: 1, co2: 299 }, { v: 1, pm: 401 },
    { v: 1, open: 101 }, { v: 1, mech: 2001 }, { v: 1, inf: 6 },
    { v: 1, q: 301 }, { v: 1, mask: 96 }, { v: 1, cr: 5 },
    { v: 1, budget: 10001 }, { v: 1, dt: 26 }, { v: 1, wind: -0.5 },
  ];
  for (const obj of cases) {
    await t.test(JSON.stringify(obj), () => assert.equal(C.decodeRoom(craft(obj)).ok, false));
  }
});

test('269. decodeRoom rejects wrong types and bad enums', async (t) => {
  const cases = [
    { v: 1, s: '28' }, { v: 1, s: null }, { v: 1, s: NaN }, { v: 1, s: [] },
    { v: 1, mode: 'diagonal' }, { v: 1, mode: 2 }, { v: 1, mode: true },
    { v: 1, p: 'unknown-preset' }, { v: 1, r: 'nuclear-option' },
    { v: 1, wind: Infinity }, { v: 1, merv: 2 }, { v: 1, uvgi: -1 },
  ];
  for (const obj of cases) {
    await t.test(JSON.stringify(obj), () => assert.equal(C.decodeRoom(craft(obj)).ok, false));
  }
});

test('270. a preset plus explicit fields applies the preset first', () => {
  const res = C.decodeRoom(craft({ v: 1, p: 'standard28', s: 10 }));
  assert.ok(res.ok);
  assert.equal(res.state.presetId, 'standard28');
  assert.equal(res.state.students, 10);
  assert.equal(res.state.volume, E.getPreset('standard28').params.volume);
});

test('271. merv and uvgi decode to booleans', () => {
  const res = C.decodeRoom(craft({ v: 1, merv: 1, uvgi: 0 }));
  assert.ok(res.ok);
  assert.equal(res.state.merv13, true);
  assert.equal(res.state.uvgi, false);
});

test('272. decoded state contains only allowlisted engine keys', () => {
  const res = C.decodeRoom(C.encodeRoom({ ...std(), presetId: 'standard28', retrofitId: 'custom', evil: 'x' }));
  assert.ok(res.ok);
  const allowed = new Set(['presetId', 'students', 'volume', 'outdoorCO2', 'outdoorPM', 'windSpeed', 'deltaT', 'windowMode',
    'windowOpen', 'mechOA', 'infiltrationACH', 'infectious', 'quantaRate', 'maskEfficiency', 'crBoxes',
    'hepaUnits', 'merv13', 'uvgi', 'budget', 'retrofitId']);
  for (const key of Object.keys(res.state)) assert.ok(allowed.has(key), key);
});

test('273. decodeRoom never throws on a fuzz batch', async (t) => {
  const fuzz = ['#room=AAAA', '#room=eyJ2IjoxfQ', '#room=%%%', '#room', '##room=AAA', '#room=AAA=AAA', `#room=${'x'.repeat(1195)}`];
  for (const h of fuzz) {
    await t.test(h.slice(0, 24), () => {
      const res = C.decodeRoom(h);
      assert.equal(typeof res.ok, 'boolean');
    });
  }
});

// ---------- Engineering brief ----------

test('274. the unsigned brief carries every required section', () => {
  const b = B.engineeringBrief(std());
  for (const key of ['briefVersion', 'modelVersion', 'generator', 'scope', 'scenario', 'metrics', 'compliance', 'retrofits', 'schoolDay', 'verification', 'costModel']) {
    assert.ok(key in b, key);
  }
  assert.equal(b.briefVersion, 1);
  assert.match(b.scope, /[Ss]ynthetic/);
});

test('275. the brief is byte-for-byte deterministic', () => {
  const a = B.engineeringBrief(std());
  const b = B.engineeringBrief(std());
  assert.equal(E.canonicalJson(a), E.canonicalJson(b));
});

test('276. brief metrics equal the closed-form solve', () => {
  const b = B.engineeringBrief(std());
  const m = E.analyticMetrics(std()).metrics;
  for (const key of Object.keys(b.metrics)) {
    assert.equal(b.metrics[key], m[key], key);
  }
});

test('277. compliance flags match the guides on the standard room', () => {
  const b = B.engineeringBrief(std());
  assert.equal(b.compliance.ecaOk, b.metrics.ecaACH >= 5);
  assert.equal(b.compliance.co2Ok, b.metrics.co2Peak < 800);
  assert.equal(b.compliance.ashraeOk, b.metrics.oaPerPersonLps >= 7);
  assert.equal(b.compliance.ecaACHGuide, 5);
  assert.equal(b.compliance.co2Guide, 800);
  assert.equal(b.compliance.ashraeGuide, 7);
});

test('278. a high-airflow room can pass all three guides', () => {
  const p = { ...std(), mechOA: 1500, hepaUnits: 2, students: 20 };
  const b = B.engineeringBrief(p);
  assert.equal(b.compliance.ecaOk, true);
  assert.equal(b.compliance.co2Ok, true);
  assert.equal(b.compliance.ashraeOk, true);
});

test('279. the brief retrofit table mirrors the comparator', () => {
  const b = B.engineeringBrief(std());
  const cmp = R.retrofitComparison(std());
  assert.deepEqual(b.retrofits.map((r) => r.id), cmp.rows.map((r) => r.id));
  for (const r of b.retrofits) {
    const row = cmp.rows.find((x) => x.id === r.id);
    assert.equal(r.ecaACH, row.ecaACH, r.id);
    assert.equal(r.annualCost, row.annualCost, r.id);
  }
});

test('280. the brief school-day block mirrors the day report', () => {
  const b = B.engineeringBrief(std());
  const day = D.schoolDayReport(std(), 'custom');
  assert.equal(b.schoolDay.above800Before, day.exceedance.before.minutes[800]);
  assert.equal(b.schoolDay.above1000Before, day.exceedance.before.minutes[1000]);
  assert.equal(b.schoolDay.above800After, day.exceedance.after.minutes[800]);
  assert.equal(b.schoolDay.co2PeakBefore, day.exceedance.before.peak);
  assert.equal(b.schoolDay.minutes, 450);
});

test('281. signBrief attaches both integrity digests', () => {
  const s = signed();
  assert.equal(s.signature.algorithm, 'SHA-256');
  assert.match(s.signature.sha256, /^[0-9a-f]{64}$/);
  assert.match(s.signature.fnv1a32, /^[0-9a-f]{8}$/);
  assert.match(s.signature.role, /not a digital signature/i);
});

test('282. the SHA-256 covers the canonical payload minus the signature', () => {
  const s = signed();
  const body = { ...s };
  delete body.signature;
  assert.equal(s.signature.sha256, sha256HexSync(E.canonicalJson(body)));
  assert.equal(s.signature.fnv1a32, E.fnv1a32(E.canonicalJson(body)));
});

test('283. verifyBrief accepts a fresh signed brief', () => {
  const v = B.verifyBrief(signed());
  assert.equal(v.ok, true);
  assert.equal(v.shaOk, true);
  assert.equal(v.fnvOk, true);
  assert.match(v.detail, /intact/);
});

test('284. verifyBrief rejects tampered payloads', async (t) => {
  const mutations = [
    ['metric edit', (b) => { b.metrics.co2Peak += 1; }],
    ['scenario edit', (b) => { b.scenario.students += 1; }],
    ['retrofit edit', (b) => { b.retrofits[0].ecaACH = 99; }],
    ['school-day edit', (b) => { b.schoolDay.above800After = 0; }],
    ['compliance edit', (b) => { b.compliance.ecaOk = true; }],
    ['key removal', (b) => { delete b.metrics.riskFinal; }],
    ['key injection', (b) => { b.extra = 1; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const b = JSON.parse(JSON.stringify(signed()));
      mutate(b);
      const v = B.verifyBrief(b);
      assert.equal(v.ok, false);
      assert.match(v.detail, /mismatch/i);
    });
  }
});

test('285. a forged signature digest is rejected', () => {
  const b = JSON.parse(JSON.stringify(signed()));
  b.signature.sha256 = '0'.repeat(64);
  assert.equal(B.verifyBrief(b).ok, false);
  b.signature.sha256 = signed().signature.sha256;
  b.signature.fnv1a32 = '00000000';
  assert.equal(B.verifyBrief(b).ok, false);
});

test('286. structural defects fail verification, never throw', async (t) => {
  const cases = [
    ['null', null],
    ['array', []],
    ['string', 'x'],
    ['missing signature', (() => { const b = signed(); delete b.signature; return b; })()],
    ['string signature', (() => { const b = signed(); b.signature = 'x'; return b; })()],
    ['wrong version', (() => { const b = signed(); b.briefVersion = 2; return b; })()],
  ];
  for (const [name, obj] of cases) {
    await t.test(name, () => {
      const v = B.verifyBrief(obj);
      assert.equal(v.ok, false);
    });
  }
});

test('287. the signature block itself is excluded from the digest', () => {
  const b = signed();
  b.signature.role = 'renamed but not signed';
  assert.equal(B.verifyBrief(b).ok, true);
});

test('288. replayBrief reproduces every recorded metric', () => {
  const r = B.replayBrief(signed());
  assert.equal(r.ok, true);
  assert.equal(r.checks.length, 14);
  assert.ok(r.checks.every((c) => c.ok));
  assert.match(r.detail, /14 recorded metrics replay exactly/);
});

test('289. replayBrief flags each differing metric', () => {
  const b = signed();
  b.metrics.co2Peak += 50;
  b.metrics.ecaACH = 0;
  const r = B.replayBrief(b);
  assert.equal(r.ok, false);
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.key);
  assert.deepEqual(failed.sort(), ['co2Peak', 'ecaACH']);
});

test('290. replayBrief rejects structurally broken input without throwing', async (t) => {
  for (const [name, obj] of [['null', null], ['empty', {}], ['no scenario', { metrics: { co2Peak: 1 } }]]) {
    await t.test(name, () => {
      const r = B.replayBrief(obj);
      assert.equal(r.ok, false);
      assert.deepEqual(r.checks, []);
    });
  }
});

test('291. replay tolerates non-numeric extra recorded fields', () => {
  const b = signed();
  b.metrics.label = 'note';
  const r = B.replayBrief(b);
  assert.equal(r.checks.filter((c) => c.key !== 'label').length, 14);
});

test('292. exported JSON parses back into a verifiable brief', () => {
  const text = `${JSON.stringify(signed(), null, 2)}\n`;
  const round = JSON.parse(text);
  assert.equal(B.verifyBrief(round).ok, true);
  assert.equal(B.replayBrief(round).ok, true);
});

test('293. every preset produces a verifiable, replayable brief', async (t) => {
  for (const preset of E.PRESETS) {
    await t.test(preset.id, () => {
      const b = B.signBrief(B.engineeringBrief(preset.params));
      assert.equal(B.verifyBrief(b).ok, true);
      assert.equal(B.replayBrief(b).ok, true);
    });
  }
});

// ---------- Brief CSV ----------

test('294. the CSV export has a fixed header and CRLF line endings', () => {
  const csv = B.briefCsv(signed());
  assert.ok(csv.startsWith('section,item,measure,value,unit\r\n'));
  assert.ok(csv.endsWith('\r\n'));
  assert.ok(!csv.slice(0, -2).includes('\n') || csv.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r')));
});

test('295. the CSV covers every section including both digests', () => {
  const csv = B.briefCsv(signed());
  const b = signed();
  assert.ok(csv.includes(b.signature.sha256));
  assert.ok(csv.includes(b.signature.fnv1a32));
  const sections = new Set(csv.trim().split('\r\n').slice(1).map((l) => l.split(',')[0]));
  for (const s of ['meta', 'scenario', 'metrics', 'compliance', 'retrofit', 'schoolDay', 'verification', 'signature']) {
    assert.ok(sections.has(s), s);
  }
});

test('296. no CSV cell can execute as a spreadsheet formula', () => {
  const csv = B.briefCsv(signed());
  const rows = csv.trim().split('\r\n');
  for (const line of rows) {
    // Cells were serialized through csvCell; verify no raw cell begins with a
    // formula prefix (a leading quote mark from escaping is fine).
    for (const cell of line.split(',')) {
      const probe = cell.replace(/^"/, '').replace(/"$/, '');
      assert.ok(!/^[=+\-@]/.test(probe) || probe.startsWith("'"), cell);
    }
  }
});

test('297. the CSV is deterministic', () => {
  assert.equal(B.briefCsv(signed()), B.briefCsv(signed()));
});

test('298. retrofit CSV rows cover all seven comparator scenarios', () => {
  const csv = B.briefCsv(signed());
  const rows = csv.trim().split('\r\n').filter((l) => l.startsWith('retrofit,'));
  const ids = new Set(rows.map((l) => l.split(',')[1]));
  assert.equal(ids.size, 7);
  assert.equal(rows.length, 7 * 9);
});

// ---------- Brief Markdown ----------

test('299. the Markdown export renders all sections and the disclosure', () => {
  const b = signed();
  const md = B.briefMarkdown(b);
  assert.ok(md.startsWith('# VentiLab IAQ Engineering Brief'));
  assert.ok(md.includes('## Classroom'));
  assert.ok(md.includes('## Solved metrics'));
  assert.ok(md.includes('## Compliance verdict'));
  assert.ok(md.includes('## Retrofit comparison'));
  assert.ok(md.includes('## School day'));
  assert.ok(md.includes('## Integrity signature'));
  assert.ok(md.includes(b.signature.sha256));
  assert.ok(md.includes('not a digital signature'));
  assert.ok(md.includes('Synthetic reference classroom'));
});

test('300. the Markdown export is deterministic', () => {
  assert.equal(B.briefMarkdown(signed()), B.briefMarkdown(signed()));
});

test('301. the Markdown retrofit table has a row per comparator scenario', () => {
  const md = B.briefMarkdown(signed());
  const tableRows = md.split('\n').filter((l) => /^\| .*eACH/.test(l) === false && l.startsWith('| ') && l.includes('|') && !l.startsWith('|---') && !l.startsWith('| Scenario') && !l.startsWith('| Input') && !l.startsWith('| Metric'));
  assert.ok(tableRows.length >= 7);
});

// ---------- Self-test suite ----------

test('302. the self-test suite returns a full result record', () => {
  const st = T.selfTestSuite();
  assert.equal(typeof st.total, 'number');
  assert.equal(typeof st.passed, 'number');
  assert.equal(typeof st.ok, 'boolean');
  assert.ok(Array.isArray(st.results));
});

test('303. the suite runs exactly ten named checks', () => {
  const st = T.selfTestSuite();
  assert.equal(st.total, 10);
  assert.equal(st.results.length, 10);
  assert.equal(new Set(st.results.map((r) => r.id)).size, 10);
});

test('304. the suite covers all required physics and hygiene checks', () => {
  const ids = T.selfTestSuite().results.map((r) => r.id);
  for (const id of ['sha256-kat', 'co2-steady', 'wells-riley', 'pm-decay', 'schedule', 'csv-escape', 'brief-integrity', 'room-codec', 'comparator', 'canonical-json']) {
    assert.ok(ids.includes(id), id);
  }
});

test('305. every self-test passes on the reference classroom', () => {
  const st = T.selfTestSuite();
  assert.equal(st.passed, st.total);
  assert.equal(st.ok, true);
  for (const r of st.results) {
    assert.equal(r.pass, true, r.id);
    assert.ok(r.name.length > 0 && r.detail.length > 0, r.id);
  }
});

test('306. the suite is deterministic across runs', () => {
  const a = T.selfTestSuite();
  const b = T.selfTestSuite();
  assert.deepEqual(a.results.map((r) => [r.id, r.pass]), b.results.map((r) => [r.id, r.pass]));
});

// ---------- Cross-module integration ----------

test('307. a bookmark scenario replays to identical engine metrics', () => {
  const state = { ...std(), presetId: 'standard28', crBoxes: 2, windowMode: 'single', windowOpen: 0.5 };
  const res = C.decodeRoom(C.encodeRoom(state));
  assert.ok(res.ok);
  const a = E.analyticMetrics({ ...state }).metrics;
  const b = E.analyticMetrics({ ...E.DEFAULTS, ...res.state }).metrics;
  assert.equal(a.ecaACH, b.ecaACH);
  assert.equal(a.co2Peak, b.co2Peak);
  assert.equal(a.riskFinal, b.riskFinal);
});

test('308. a decoded bookmark produces a verifiable brief', () => {
  const res = C.decodeRoom(C.encodeRoom({ ...std(), presetId: 'standard28', crBoxes: 2 }));
  const b = B.signBrief(B.engineeringBrief(res.state));
  assert.equal(B.verifyBrief(b).ok, true);
  assert.equal(B.replayBrief(b).ok, true);
});

test('309. encode-decode-encode is a fixed point', () => {
  const s = { ...std(), presetId: 'standard28', retrofitId: 'cross-vent' };
  const h1 = C.encodeRoom(s);
  const res = C.decodeRoom(h1);
  const h2 = C.encodeRoom({ ...res.state, presetId: res.state.presetId, retrofitId: res.state.retrofitId });
  assert.equal(h1, h2);
});

test('310. the brief school-day numbers equal the module report for a preset', () => {
  const b = B.engineeringBrief(E.getPreset('rural-natural').params);
  const day = D.schoolDayReport(E.getPreset('rural-natural').params, 'custom');
  assert.equal(b.schoolDay.above1000After, day.exceedance.after.minutes[1000]);
  assert.equal(b.schoolDay.co2PeakAfter, day.exceedance.after.peak);
});

test('311. comparator rows inside the brief agree with live evaluation', () => {
  const b = B.engineeringBrief(std());
  for (const r of b.retrofits) {
    const resolved = r.id === 'custom' ? E.normalizeParams(std()) : R.resolveRetrofit(std(), r.id);
    const row = R.evaluateRetrofit(resolved);
    assert.ok(Math.abs(r.ecaACH - row.ecaACH) < 1e-9, r.id);
  }
});
