import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';
import * as R from '../src/retrofit.js';
import * as D from '../src/schoolday.js';

const std = () => E.getPreset('standard28').params;
const INTERVENTION_KEYS = new Set(['crBoxes', 'hepaUnits', 'merv13', 'uvgi', 'windowMode', 'windowOpen']);

// ---------- Retrofit scenario catalog ----------

test('157. the comparator ships a baseline plus five deterministic interventions', () => {
  assert.equal(R.RETROFIT_SCENARIOS.length, 6);
  assert.equal(R.RETROFIT_SCENARIOS[0].id, 'baseline');
  assert.equal(R.RETROFIT_SCENARIOS[0].isBaseline, true);
  const named = R.RETROFIT_SCENARIOS.filter((s) => !s.isBaseline);
  assert.equal(named.length, 5);
  assert.equal(new Set(R.RETROFIT_SCENARIOS.map((s) => s.id)).size, 6);
});

test('158. every scenario has a unique id, a name and a disclosure note', () => {
  for (const s of R.RETROFIT_SCENARIOS) {
    assert.ok(/^[a-z0-9-]+$/.test(s.id), s.id);
    assert.ok(s.name.length > 4, s.id);
    assert.ok(s.short.length > 0, s.id);
    assert.ok(s.note.length > 10, s.id);
  }
});

test('159. scenario overrides only touch intervention fields', () => {
  for (const s of R.RETROFIT_SCENARIOS) {
    for (const key of Object.keys(s.overrides)) assert.ok(INTERVENTION_KEYS.has(key), `${s.id}.${key}`);
  }
});

test('160. RETROFIT_IDS mirrors the catalog in order', () => {
  assert.deepEqual([...R.RETROFIT_IDS], R.RETROFIT_SCENARIOS.map((s) => s.id));
});

test('161. getRetrofitScenario resolves each id and returns null otherwise', () => {
  for (const s of R.RETROFIT_SCENARIOS) assert.equal(R.getRetrofitScenario(s.id), s);
  assert.equal(R.getRetrofitScenario('nope'), null);
  assert.equal(R.getRetrofitScenario(''), null);
  assert.equal(R.getRetrofitScenario(undefined), null);
});

test('162. the named interventions are the expected deterministic overrides', () => {
  const byId = Object.fromEntries(R.RETROFIT_SCENARIOS.map((s) => [s.id, s.overrides]));
  assert.deepEqual(byId['cr-box-2'], { crBoxes: 2 });
  assert.deepEqual(byId['merv13-upgrade'], { merv13: true });
  assert.deepEqual(byId['hepa-400'], { hepaUnits: 2 });
  assert.deepEqual(byId['cross-vent'], { windowMode: 'cross', windowOpen: 0.5 });
  assert.deepEqual(byId['school-package'], { crBoxes: 2, windowMode: 'single', windowOpen: 0.25 });
});

// ---------- resolveRetrofit ----------

test('163. baseline resolution strips interventions but keeps the room', () => {
  const p = R.resolveRetrofit({ ...std(), crBoxes: 3, uvgi: true, windowMode: 'cross', windowOpen: 1 }, 'baseline');
  assert.equal(p.windowMode, 'closed');
  assert.equal(p.windowOpen, 0);
  assert.equal(p.crBoxes, 0);
  assert.equal(p.hepaUnits, 0);
  assert.equal(p.merv13, false);
  assert.equal(p.uvgi, false);
  assert.equal(p.students, 28);
  assert.equal(p.mechOA, 180);
  assert.equal(p.volume, 210);
});

test('164. custom resolution returns the room exactly as configured', () => {
  const p = R.resolveRetrofit({ ...std(), crBoxes: 2, windowMode: 'single', windowOpen: 0.4 }, 'custom');
  assert.equal(p.crBoxes, 2);
  assert.equal(p.windowMode, 'single');
  assert.equal(p.windowOpen, 0.4);
});

test('165. a named resolution applies overrides on the as-is room', () => {
  const p = R.resolveRetrofit({ ...std(), crBoxes: 4, windowMode: 'cross', windowOpen: 1 }, 'cr-box-2');
  assert.equal(p.crBoxes, 2);
  assert.equal(p.windowMode, 'closed');
  assert.equal(p.windowOpen, 0);
  assert.equal(p.mechOA, 180);
});

test('166. an unknown id falls back to the configured room', () => {
  const p = R.resolveRetrofit({ ...std(), hepaUnits: 2 }, 'does-not-exist');
  assert.equal(p.hepaUnits, 2);
});

test('167. resolution is idempotent and normalized', () => {
  const once = R.resolveRetrofit(std(), 'school-package');
  const twice = R.resolveRetrofit(std(), 'school-package');
  assert.deepEqual(twice, once);
  assert.equal(once.windowOpen, 0.25);
});

// ---------- Annualized cost model ----------

test('168. the cost model constants are disclosed and positive', () => {
  const m = R.ANNUAL_COST_MODEL;
  assert.equal(m.currency, 'USD');
  assert.ok(m.electricityPricePerKwh > 0);
  assert.ok(m.occupiedHoursPerYear > 0);
  for (const spec of Object.values(m.devices)) {
    assert.ok(spec.capital > 0 && spec.lifeYears > 0 && spec.consumablesPerYear >= 0 && spec.watts > 0);
  }
  assert.ok(m.note.length > 10);
});

test('169. the do-nothing baseline costs nothing per year', () => {
  assert.equal(R.annualizedCost(R.resolveRetrofit(std(), 'baseline')), 0);
  assert.equal(R.annualizedCost({ windowMode: 'cross', windowOpen: 1 }), 0);
});

test('170. annualized cost decomposes exactly into capital, consumables and electricity', () => {
  const m = R.ANNUAL_COST_MODEL;
  const energy = (w) => (w / 1000) * m.electricityPricePerKwh * m.occupiedHoursPerYear;
  const expected = 2 * (m.devices.crBox.capital / m.devices.crBox.lifeYears + m.devices.crBox.consumablesPerYear + energy(35));
  assert.ok(Math.abs(R.annualizedCost({ crBoxes: 2 }) - expected) < 1e-9);
});

test('171. merv13 annualized cost uses its own line item', () => {
  const m = R.ANNUAL_COST_MODEL;
  const energy = (40 / 1000) * m.electricityPricePerKwh * m.occupiedHoursPerYear;
  const expected = m.devices.merv13.capital / m.devices.merv13.lifeYears + m.devices.merv13.consumablesPerYear + energy;
  assert.ok(Math.abs(R.annualizedCost({ merv13: true }) - expected) < 1e-9);
});

test('172. combined devices sum their individual annualized costs', () => {
  const total = R.annualizedCost({ crBoxes: 1, hepaUnits: 1, merv13: true, uvgi: true });
  const parts = R.annualizedCost({ crBoxes: 1 }) + R.annualizedCost({ hepaUnits: 1 })
    + R.annualizedCost({ merv13: true }) + R.annualizedCost({ uvgi: true });
  assert.ok(Math.abs(total - parts) < 1e-9);
});

test('173. annualized cost scales linearly with device count', () => {
  const one = R.annualizedCost({ crBoxes: 1 });
  const three = R.annualizedCost({ crBoxes: 3 });
  assert.ok(Math.abs(three - 3 * one) < 1e-9);
});

test('174. window settings and cadrScale never change the annualized cost', () => {
  const a = R.annualizedCost({ crBoxes: 2 });
  const b = R.annualizedCost({ crBoxes: 2, windowMode: 'cross', windowOpen: 1, cadrScale: 0 });
  const c = R.annualizedCost({ crBoxes: 2, cadrScale: 5 });
  assert.equal(a, b);
  assert.equal(a, c);
});

test('175. zero electricity price leaves capital and consumables only', () => {
  const model = { ...R.ANNUAL_COST_MODEL, electricityPricePerKwh: 0 };
  const d = R.ANNUAL_COST_MODEL.devices;
  const expected = 85 / 5 + 24;
  assert.ok(Math.abs(R.annualizedCost({ crBoxes: 1 }, model) - expected) < 1e-9);
  assert.ok(d.crBox.watts > 0);
});

test('176. zero occupied hours removes the energy term', () => {
  const model = { ...R.ANNUAL_COST_MODEL, occupiedHoursPerYear: 0 };
  const expected = 85 / 5 + 24;
  assert.ok(Math.abs(R.annualizedCost({ crBoxes: 1 }, model) - expected) < 1e-9);
});

// ---------- PM2.5 clearance ----------

test('177. PM2.5 90% clearance equals ln(10) over the total removal rate', () => {
  const p = { ...std(), hepaUnits: 1 };
  const vent = E.ventilationRates(p);
  const equip = E.equipment(p);
  const rate = (vent.qInfiltration + vent.qNatural + 180 + equip.pmCADR) / 210;
  assert.ok(Math.abs(R.pmClearance90Min(p) - (Math.LN10 * 60) / rate) < 1e-9);
});

test('178. clearance time falls monotonically with added filtration', () => {
  const times = [0, 1, 2, 4].map((hepaUnits) => R.pmClearance90Min({ ...std(), hepaUnits }));
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] < times[i - 1]);
});

test('179. a sealed room never clears a particle pulse', () => {
  const sealed = { mechOA: 0, infiltrationACH: 0, windowMode: 'closed', windowOpen: 0, crBoxes: 0, hepaUnits: 0, merv13: false, uvgi: false };
  assert.equal(R.pmClearance90Min(sealed), Infinity);
});

test('180. clearance matches the simulated pulse decay within one step', () => {
  const p = { ...std(), outdoorPM: 0, pmStart: 80, hepaUnits: 1, sampleMin: 1, stepMin: 1 };
  const run = E.simulate(p);
  const idx = run.pm.findIndex((v) => v <= 8);
  const exact = R.pmClearance90Min(p);
  assert.ok(idx > 0);
  assert.ok(Math.abs(run.times[idx] - exact) <= 1.5, `${run.times[idx]} vs ${exact}`);
});

// ---------- Steady-state CO2 ----------

test('181. steady-state CO2 is outdoor plus source over exchange', () => {
  const p = std();
  const vent = E.ventilationRates(p);
  const q = vent.qNatural + 180 + vent.qInfiltration;
  const expected = 420 + (28 * 18 * 1000 / 210) / (q / 210);
  assert.ok(Math.abs(R.steadyStateCo2(p) - expected) < 1e-9);
});

test('182. steady-state CO2 falls monotonically with outdoor airflow', () => {
  const vals = [0, 100, 300, 700].map((mechOA) => R.steadyStateCo2({ ...std(), mechOA }));
  for (let i = 1; i < vals.length; i += 1) assert.ok(vals[i] < vals[i - 1]);
});

test('183. a sealed room has no finite steady state', () => {
  const sealed = { ...std(), mechOA: 0, infiltrationACH: 0, windowMode: 'closed', windowOpen: 0 };
  assert.equal(R.steadyStateCo2(sealed), Infinity);
});

test('184. an empty room approaches the outdoor concentration', () => {
  assert.ok(Math.abs(R.steadyStateCo2({ ...std(), students: 0 }) - 420) < 1e-9);
});

test('185. the long-run simulated final approaches the reported steady state', () => {
  const p = { ...std(), mechOA: 300 };
  const run = E.simulate({ ...p, durationMin: 2880, sampleMin: 120, schedule: [{ start: 0, end: 2880, occupancy: 1 }] });
  assert.ok(Math.abs(run.metrics.co2Final - R.steadyStateCo2(p)) < 0.5);
});

// ---------- Compliance verdict ----------

test('186. the verdict covers all four pass and fail combinations', () => {
  assert.deepEqual(R.complianceVerdict({ ecaACH: 6, co2Peak: 700 }), {
    eachOk: true, co2Ok: true, label: 'Meets CDC eACH and CO2 guides',
  });
  assert.equal(R.complianceVerdict({ ecaACH: 6, co2Peak: 900 }).label, 'Meets eACH only');
  assert.equal(R.complianceVerdict({ ecaACH: 4, co2Peak: 700 }).label, 'Meets CO2 guide only');
  assert.equal(R.complianceVerdict({ ecaACH: 4, co2Peak: 900 }).label, 'Below both guides');
});

test('187. boundary values obey the guides exactly', () => {
  assert.equal(R.complianceVerdict({ ecaACH: 5, co2Peak: 799.9 }).eachOk, true);
  assert.equal(R.complianceVerdict({ ecaACH: 4.99, co2Peak: 799.9 }).eachOk, false);
  assert.equal(R.complianceVerdict({ ecaACH: 6, co2Peak: 800 }).co2Ok, false);
  assert.equal(R.complianceVerdict({ ecaACH: 6, co2Peak: 799.999 }).co2Ok, true);
});

test('188. non-finite metrics fail both verdict parts', () => {
  const v = R.complianceVerdict({ ecaACH: NaN, co2Peak: Infinity });
  assert.equal(v.eachOk, false);
  assert.equal(v.co2Ok, false);
  assert.equal(v.label, 'Below both guides');
});

// ---------- evaluateRetrofit ----------

test('189. an evaluated row carries every comparator metric', () => {
  const row = R.evaluateRetrofit(R.resolveRetrofit(std(), 'cr-box-2'));
  for (const key of ['ecaACH', 'ecaTotal', 'steadyStateCo2', 'co2Peak', 'co2Mean', 'pmMean', 'pmClearance90Min', 'riskFinal', 'baselineRisk', 'riskReduction', 'annualCost', 'riskPer100', 'upfrontCost', 'watts', 'dBA', 'oaPerPersonLps']) {
    assert.ok(key in row, key);
  }
  assert.ok(row.verdict && typeof row.verdict.label === 'string');
});

test('190. row eACH matches the engine equivalent clean airflow', () => {
  const p = R.resolveRetrofit(std(), 'hepa-400');
  const row = R.evaluateRetrofit(p);
  const m = E.analyticMetrics(p).metrics;
  assert.equal(row.ecaACH, m.ecaACH);
  assert.equal(row.ecaTotal, m.ecaTotal);
});

test('191. row risk cut matches the closed-window baseline definition', () => {
  const p = { ...std(), infectious: 1 };
  const baseRisk = E.analyticMetrics(E.baselineParams(p)).metrics.riskFinal;
  const row = R.evaluateRetrofit(R.resolveRetrofit(p, 'merv13-upgrade'), baseRisk);
  const m = E.analyticMetrics(R.resolveRetrofit(p, 'merv13-upgrade')).metrics;
  assert.ok(Math.abs(row.riskReduction - ((baseRisk - m.riskFinal) / baseRisk) * 100) < 1e-9);
});

test('192. the baseline row reports zero risk cut', () => {
  const row = R.evaluateRetrofit(R.resolveRetrofit(std(), 'baseline'));
  assert.equal(row.riskReduction, 0);
});

test('193. risk cut per $100 divides by annualized hundreds', () => {
  const p = { ...std(), infectious: 1 };
  const row = R.evaluateRetrofit(R.resolveRetrofit(p, 'cr-box-2'));
  assert.ok(Math.abs(row.riskPer100 - row.riskReduction / (row.annualCost / 100)) < 1e-9);
});

test('194. a free improvement reports infinite risk cut per $100', () => {
  const p = { ...std(), infectious: 1 };
  const row = R.evaluateRetrofit(R.resolveRetrofit(p, 'cross-vent'));
  assert.equal(row.annualCost, 0);
  assert.equal(row.riskPer100, Infinity);
  assert.ok(row.riskReduction > 0);
});

test('195. no cost and no improvement reports zero, not infinity', () => {
  const p = { ...std(), infectious: 1 };
  const row = R.evaluateRetrofit(R.resolveRetrofit(p, 'baseline'));
  assert.equal(row.annualCost, 0);
  assert.equal(row.riskPer100, 0);
});

test('196. steady-state and clearance on a row equal the standalone helpers', () => {
  const p = R.resolveRetrofit(std(), 'school-package');
  const row = R.evaluateRetrofit(p);
  assert.equal(row.steadyStateCo2, R.steadyStateCo2(p));
  assert.equal(row.pmClearance90Min, R.pmClearance90Min(p));
});

// ---------- retrofitComparison ----------

test('197. the comparison lists baseline, five named, custom and a budget pick', () => {
  const cmp = R.retrofitComparison(std());
  const ids = cmp.rows.map((r) => r.id);
  assert.deepEqual(ids.slice(0, 7), ['baseline', 'cr-box-2', 'merv13-upgrade', 'hepa-400', 'cross-vent', 'school-package', 'custom']);
  assert.ok(cmp.best && cmp.best.id === 'best-under-budget');
});

test('198. baseline risk matches the analytic do-nothing solve', () => {
  const p = { ...std(), infectious: 1 };
  const cmp = R.retrofitComparison(p);
  const expected = E.analyticMetrics(E.baselineParams(p)).metrics.riskFinal;
  assert.equal(cmp.baselineRisk, expected);
});

test('199. every comparator row eACH matches a direct engine solve', () => {
  const cmp = R.retrofitComparison(std());
  for (const row of cmp.rows) {
    const resolved = row.id === 'custom' ? E.normalizeParams(std()) : R.resolveRetrofit(std(), row.id);
    const m = E.analyticMetrics(resolved).metrics;
    assert.ok(Math.abs(row.ecaACH - m.ecaACH) < 1e-9, row.id);
    assert.ok(Math.abs(row.co2Peak - m.co2Peak) < 1e-6, row.id);
    assert.ok(Math.abs(row.riskFinal - m.riskFinal) < 1e-9, row.id);
  }
});

test('200. the custom row mirrors the configured room', () => {
  const p = { ...std(), crBoxes: 1, windowMode: 'single', windowOpen: 0.5 };
  const cmp = R.retrofitComparison(p);
  const custom = cmp.rows.find((r) => r.id === 'custom');
  const direct = R.evaluateRetrofit(p);
  assert.equal(custom.ecaACH, direct.ecaACH);
  assert.equal(custom.co2Peak, direct.co2Peak);
  assert.equal(custom.annualCost, direct.annualCost);
});

test('201. the comparison is byte-for-byte deterministic', () => {
  const a = R.retrofitComparison(std());
  const b = R.retrofitComparison(std());
  assert.deepEqual(a.rows.map((r) => [r.id, r.ecaACH, r.co2Peak, r.riskReduction, r.annualCost]), b.rows.map((r) => [r.id, r.ecaACH, r.co2Peak, r.riskReduction, r.annualCost]));
});

test('202. a zero budget produces no optimizer pick', () => {
  const cmp = R.retrofitComparison(std(), { budget: 0 });
  assert.equal(cmp.best, null);
});

test('203. a funded budget yields an optimizer pick on the exact frontier', () => {
  const cmp = R.retrofitComparison(std(), { budget: 1200 });
  assert.ok(cmp.best);
  assert.ok(cmp.best.optimizerLabel.length > 0);
  const opt = E.optimizeRetrofits(std(), 1200);
  assert.equal(cmp.best.optimizerLabel, opt.recommended.label);
});

test('204. every named intervention improves eACH over the as-is baseline', () => {
  const cmp = R.retrofitComparison(std());
  const baseline = cmp.rows[0];
  for (const row of cmp.rows.slice(1, 6)) {
    assert.ok(row.ecaACH > baseline.ecaACH, row.id);
  }
});

test('205. comparison verdicts are coherent with their own metrics', () => {
  const cmp = R.retrofitComparison(std());
  for (const row of cmp.rows) {
    const v = R.complianceVerdict({ ecaACH: row.ecaACH, co2Peak: row.co2Peak });
    assert.equal(row.verdict.label, v.label, row.id);
    assert.equal(row.verdict.eachOk, row.ecaACH >= 5);
    assert.equal(row.verdict.co2Ok, row.co2Peak < 800);
  }
});

test('206. comparator works on every preset with finite rows', async (t) => {
  for (const preset of E.PRESETS) {
    await t.test(preset.id, () => {
      const cmp = R.retrofitComparison(preset.params);
      assert.ok(Number.isFinite(cmp.baselineRisk));
      for (const row of cmp.rows) {
        assert.ok(Number.isFinite(row.ecaACH) && Number.isFinite(row.co2Peak), `${row.id}`);
        assert.ok(Number.isFinite(row.annualCost) && row.annualCost >= 0, row.id);
        assert.ok(row.riskReduction >= -1e-6 && row.riskReduction <= 100.000001, row.id);
      }
      assert.equal(cmp.rows[0].riskReduction, 0);
    });
  }
});

test('207. describeOverrides renders each intervention type', () => {
  assert.equal(R.describeOverrides({}), 'no added devices');
  assert.match(R.describeOverrides({ crBoxes: 2 }), /2 fan boxes/);
  assert.match(R.describeOverrides({ crBoxes: 1 }), /1 fan box(?!es)/);
  assert.match(R.describeOverrides({ hepaUnits: 2 }), /2 HEPA/);
  assert.match(R.describeOverrides({ merv13: true }), /MERV-13/);
  assert.match(R.describeOverrides({ uvgi: true }), /UVGI/);
  assert.match(R.describeOverrides({ windowMode: 'cross', windowOpen: 0.5 }), /cross windows 50%/);
});

test('208. effectiveACH equals the engine ecaACH', () => {
  const p = { ...std(), crBoxes: 2, merv13: true };
  assert.ok(Math.abs(R.effectiveACH(p) - E.analyticMetrics(p).metrics.ecaACH) < 1e-9);
});

// ---------- School day schedule ----------

test('209. the school day is 450 minutes of contiguous coverage', () => {
  const s = D.SCHOOL_DAY_SCHEDULE;
  assert.equal(s.length, 14);
  assert.equal(s[0].start, 0);
  assert.equal(s[s.length - 1].end, D.SCHOOL_DAY_MINUTES);
  assert.equal(D.SCHOOL_DAY_MINUTES, 450);
  for (let i = 1; i < s.length; i += 1) assert.equal(s[i].start, s[i - 1].end, `gap before block ${i}`);
});

test('210. schedule blocks carry labels and occupancy fractions', () => {
  for (const b of D.SCHOOL_DAY_SCHEDULE) {
    assert.ok(b.label.length > 0);
    assert.ok(b.occupancy >= 0 && b.occupancy <= 1, b.label);
  }
  const labels = D.SCHOOL_DAY_SCHEDULE.map((b) => b.label);
  assert.ok(labels.includes('Lunch') && labels.includes('Recess') && labels.includes('Dismissal'));
  assert.equal(D.SCHOOL_DAY_SCHEDULE.filter((b) => b.occupancy === 1).length, 7);
});

test('211. schoolDayClock renders wall-clock labels from 8:00 AM', () => {
  assert.equal(D.schoolDayClock(0), '8:00 AM');
  assert.equal(D.schoolDayClock(60), '9:00 AM');
  assert.equal(D.schoolDayClock(160), '10:40 AM');
  assert.equal(D.schoolDayClock(255), '12:15 PM');
  assert.equal(D.schoolDayClock(300), '1:00 PM');
  assert.equal(D.schoolDayClock(360), '2:00 PM');
  assert.equal(D.schoolDayClock(450), '3:30 PM');
});

test('212. CO2 thresholds are the 800 and 1000 ppm guides', () => {
  assert.deepEqual([...D.CO2_THRESHOLDS], [800, 1000]);
});

// ---------- Exact threshold exceedance ----------

test('213. a sealed room gives exact linear-rise threshold minutes', () => {
  const p = {
    students: 28, volume: 210, outdoorCO2: 420, co2Generation: 18,
    mechOA: 0, infiltrationACH: 0, windowMode: 'closed', windowOpen: 0,
    co2Start: 420, durationMin: 450,
    schedule: [{ start: 0, end: 450, occupancy: 1 }],
  };
  const ex = D.co2ThresholdExceedance(p);
  // Rise rate: 28*18*1000/210 = 2400 ppm/h = 40 ppm/min. 800 at 9.5, 1000 at 14.5.
  assert.ok(Math.abs(ex.minutes[800] - (450 - 9.5)) < 1e-6, ex.minutes[800]);
  assert.ok(Math.abs(ex.minutes[1000] - (450 - 14.5)) < 1e-6, ex.minutes[1000]);
  assert.equal(ex.intervals[800].length, 1);
  assert.ok(Math.abs(ex.intervals[800][0][0] - 9.5) < 1e-6);
});

test('214. a fully below-threshold day counts zero minutes', () => {
  const p = { ...std(), students: 0, durationMin: 60, schedule: [{ start: 0, end: 60, occupancy: 0 }] };
  const ex = D.co2ThresholdExceedance(p);
  assert.equal(ex.minutes[800], 0);
  assert.equal(ex.minutes[1000], 0);
  assert.equal(ex.intervals[800].length, 0);
});

test('215. a fully above-threshold day counts every minute', () => {
  const p = {
    ...std(), mechOA: 0, infiltrationACH: 0, co2Start: 2000, students: 28,
    durationMin: 60, schedule: [{ start: 0, end: 60, occupancy: 1 }],
  };
  const ex = D.co2ThresholdExceedance(p, [800]);
  assert.equal(ex.minutes[800], 60);
});

test('216. a decaying room counts only the above-threshold head of the day', () => {
  // Strong exchange pulls a 2000 ppm start toward outdoor; one crossing.
  const p = {
    ...std(), mechOA: 2000, co2Start: 2000, students: 0,
    durationMin: 450, schedule: [{ start: 0, end: 450, occupancy: 0 }],
  };
  const ex = D.co2ThresholdExceedance(p, [800]);
  const vent = E.ventilationRates(p);
  const rate = (2000 + vent.qInfiltration) / 210;
  const tc = (-Math.log((800 - 420) / (2000 - 420)) / rate) * 60;
  assert.ok(Math.abs(ex.minutes[800] - tc) < 1e-6, `${ex.minutes[800]} vs ${tc}`);
  assert.equal(ex.intervals[800].length, 1);
  assert.ok(Math.abs(ex.intervals[800][0][1] - tc) < 1e-6);
});

test('217. exceedance minutes are always ordered by threshold', () => {
  for (const preset of E.PRESETS) {
    const ex = D.co2ThresholdExceedance({ ...preset.params, schedule: D.SCHOOL_DAY_SCHEDULE, durationMin: 450 });
    assert.ok(ex.minutes[800] >= ex.minutes[1000] - 1e-9, preset.id);
  }
});

test('218. crossing intervals are sorted, inside the day and non-overlapping', () => {
  const ex = D.co2ThresholdExceedance({ ...std(), schedule: D.SCHOOL_DAY_SCHEDULE, durationMin: 450 });
  for (const th of [800, 1000]) {
    let prevEnd = -1;
    for (const [a, b] of ex.intervals[th]) {
      assert.ok(a >= prevEnd - 1e-9 && a >= -1e-9 && b <= 450 + 1e-9 && b > a);
      prevEnd = b;
    }
    const total = ex.intervals[th].reduce((s, [a, b]) => s + (b - a), 0);
    assert.ok(Math.abs(total - ex.minutes[th]) < 1e-9, `threshold ${th}`);
  }
});

test('219. the day peak equals the largest span end with its clock time', () => {
  const ex = D.co2ThresholdExceedance({ ...std(), schedule: D.SCHOOL_DAY_SCHEDULE, durationMin: 450 });
  const run = E.simulate({ ...std(), schedule: D.SCHOOL_DAY_SCHEDULE, durationMin: 450, sampleMin: 1, stepMin: 1 });
  assert.ok(Math.abs(ex.peak - run.metrics.co2Peak) < 0.5);
  assert.ok(ex.peakTime > 0 && ex.peakTime <= 450);
});

test('220. custom threshold lists are honored', () => {
  const p = { ...std(), schedule: D.SCHOOL_DAY_SCHEDULE, durationMin: 450 };
  const ex = D.co2ThresholdExceedance(p, [600, 900, 1500]);
  assert.deepEqual(Object.keys(ex.minutes).map(Number), [600, 900, 1500]);
  assert.ok(ex.minutes[600] >= ex.minutes[900] && ex.minutes[900] >= ex.minutes[1500]);
});

test('221. exceedance matches sampled counting within one sampling step', () => {
  const p = { ...std(), schedule: D.SCHOOL_DAY_SCHEDULE, durationMin: 450, sampleMin: 1, stepMin: 1 };
  const run = E.simulate(p);
  const ex = D.co2ThresholdExceedance(p);
  const sampled = run.co2.filter((v) => v > 800).length; // 1-minute sampling
  assert.ok(Math.abs(ex.minutes[800] - sampled) <= 2, `${ex.minutes[800]} vs ${sampled}`);
});

test('222. exceedance on a boundary-aligned start counts correctly', () => {
  const p = {
    ...std(), co2Start: 800, mechOA: 0, infiltrationACH: 0,
    durationMin: 30, schedule: [{ start: 0, end: 30, occupancy: 1 }],
  };
  const ex = D.co2ThresholdExceedance(p, [800]);
  // Starting exactly at 800 and rising: the whole span is above 800 except the initial instant.
  assert.ok(ex.minutes[800] > 29.999, ex.minutes[800]);
});

// ---------- schoolDayReport ----------

test('223. the report runs the school schedule for before and after', () => {
  const rep = D.schoolDayReport(std(), 'school-package');
  assert.equal(rep.schedule, D.SCHOOL_DAY_SCHEDULE);
  assert.equal(rep.minutes, 450);
  assert.equal(rep.startLabel, '8:00 AM');
  assert.equal(rep.endLabel, '3:30 PM');
  assert.equal(rep.before.times[0], 0);
  assert.equal(rep.after.times.at(-1), 450);
  assert.equal(rep.before.times.length, rep.after.times.length);
});

test('224. the before curve is the as-is room and after applies the retrofit', () => {
  const rep = D.schoolDayReport(std(), 'school-package');
  const beforeM = rep.metrics.before;
  const direct = E.simulate({ ...E.baselineParams(std()), schedule: D.SCHOOL_DAY_SCHEDULE, durationMin: 450 });
  assert.ok(Math.abs(beforeM.co2Peak - direct.metrics.co2Peak) < 0.01);
  assert.ok(rep.metrics.after.ecaACH > beforeM.ecaACH);
});

test('225. custom id equals passing the configured params', () => {
  const p = { ...std(), crBoxes: 2 };
  const a = D.schoolDayReport(p, 'custom');
  const b = D.schoolDayReport(p, E.normalizeParams({ ...p }));
  assert.deepEqual(a.after.co2, b.after.co2);
});

test('226. a resolved params object is accepted as the after scenario', () => {
  const resolved = R.resolveRetrofit(std(), 'cross-vent');
  const a = D.schoolDayReport(std(), 'cross-vent');
  const b = D.schoolDayReport(std(), resolved);
  assert.deepEqual(a.after.co2, b.after.co2);
});

test('227. per-period peaks cover all fourteen blocks', () => {
  const rep = D.schoolDayReport(std(), 'school-package');
  assert.equal(rep.periods.length, 14);
  for (const per of rep.periods) {
    assert.ok(per.co2BeforePeak >= 420 - 1e-6, per.label);
    assert.ok(Number.isFinite(per.co2AfterPeak), per.label);
    assert.ok(per.clockStart.length > 0);
  }
});

test('228. an effective retrofit never raises the day peak', () => {
  const rep = D.schoolDayReport(std(), 'school-package');
  assert.ok(rep.exceedance.after.peak <= rep.exceedance.before.peak + 1e-6);
  assert.ok(rep.exceedance.after.minutes[800] <= rep.exceedance.before.minutes[800] + 1e-9);
});

test('229. aerosol series are finite, nonnegative and reduced by filtration', () => {
  const rep = D.schoolDayReport({ ...std(), infectious: 1 }, 'hepa-400');
  for (const v of rep.after.quanta) assert.ok(Number.isFinite(v) && v >= 0);
  const afterMean = rep.after.quanta.reduce((s, v) => s + v, 0) / rep.after.quanta.length;
  const beforeMean = rep.before.quanta.reduce((s, v) => s + v, 0) / rep.before.quanta.length;
  assert.ok(afterMean < beforeMean);
});

test('230. the report is deterministic across calls', () => {
  const a = D.schoolDayReport(std(), 'school-package');
  const b = D.schoolDayReport(std(), 'school-package');
  assert.deepEqual(a.after.co2, b.after.co2);
  assert.deepEqual(a.exceedance.after.minutes, b.exceedance.after.minutes);
});

test('231. recess and lunch dips appear in the before curve', () => {
  const rep = D.schoolDayReport(std(), 'custom');
  const at = (times, arr, t) => arr[times.findIndex((x) => Math.abs(x - t) < 1.5)];
  const endP3 = at(rep.before.times, rep.before.co2, 160);
  const endRecess = at(rep.before.times, rep.before.co2, 175);
  assert.ok(endRecess < endP3, `${endRecess} vs ${endP3}`);
  const endP4 = at(rep.before.times, rep.before.co2, 225);
  const endLunch = at(rep.before.times, rep.before.co2, 255);
  assert.ok(endLunch < endP4);
});

test('232. an empty classroom keeps CO2 near the outdoor level all day', () => {
  const rep = D.schoolDayReport({ ...std(), students: 0, co2Start: 420 }, 'custom');
  assert.ok(rep.exceedance.before.minutes[800] === 0);
  assert.ok(Math.max(...rep.before.co2) < 430);
});

// ---------- schoolDaySvg ----------

test('233. the SVG builds a labeled chart for the school day', () => {
  const rep = D.schoolDayReport(std(), 'school-package');
  const svg = D.schoolDaySvg(rep);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('viewBox="0 0 1000 380"'));
  assert.ok(svg.includes('8:00 AM'));
  assert.ok(svg.includes('3:30 PM'));
  assert.ok(svg.includes('CO2 800 ppm'));
  assert.ok(svg.includes('CO2 1000 ppm'));
  assert.ok(svg.includes('Lunch') && svg.includes('Recess') && svg.includes('Dismissal'));
  assert.ok(svg.endsWith('</svg>'));
});

test('234. the SVG contains no external references or script', () => {
  const svg = D.schoolDaySvg(D.schoolDayReport(std(), 'school-package'));
  assert.ok(!/href=|src=|xlink|<script|onload=|javascript:/i.test(svg));
});

test('235. the SVG is deterministic and free of NaN text', () => {
  const rep = D.schoolDayReport(std(), 'school-package');
  const a = D.schoolDaySvg(rep);
  const b = D.schoolDaySvg(rep);
  assert.equal(a, b);
  assert.ok(!a.includes('NaN') && !a.includes('Infinity'));
});

test('236. threshold exceedance bands appear only where minutes exceed', () => {
  const rep = D.schoolDayReport(std(), 'custom');
  const svg = D.schoolDaySvg(rep);
  const bands = (svg.match(/opacity="0\.55"/g) || []).length;
  const intervalCount = rep.exceedance.before.intervals[800].length + rep.exceedance.before.intervals[1000].length
    + rep.exceedance.after.intervals[800].length + rep.exceedance.after.intervals[1000].length;
  assert.equal(bands, intervalCount);
});

test('237. a below-threshold day draws no exceedance bands', () => {
  const rep = D.schoolDayReport({ ...std(), students: 0 }, 'custom');
  const svg = D.schoolDaySvg(rep);
  assert.ok(!svg.includes('opacity="0.55"'));
});

test('238. curves draw both before and after series with distinct strokes', () => {
  const svg = D.schoolDaySvg(D.schoolDayReport(std(), 'school-package'));
  const paths = (svg.match(/<path /g) || []).length;
  assert.equal(paths, 4);
  assert.ok(svg.includes('stroke-dasharray="7,5"'));
});

test('239. SVG labels escape HTML in block names', () => {
  const rep = D.schoolDayReport(std(), 'custom');
  rep.schedule = [{ start: 0, end: 450, label: '<b>X</b>', occupancy: 0.1 }];
  const ex = D.co2ThresholdExceedance({ ...std(), schedule: rep.schedule, durationMin: 450 });
  rep.exceedance = { before: ex, after: ex };
  const svg = D.schoolDaySvg(rep);
  assert.ok(!svg.includes('<b>X</b>'));
  assert.ok(svg.includes('&lt;b&gt;'));
});
