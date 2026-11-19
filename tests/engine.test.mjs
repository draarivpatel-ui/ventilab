import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';

const CONSTANT_DAY = [{ start: 0, end: 1440, label: 'Constant', occupancy: 1 }];
const base = { ...E.DEFAULTS, schedule: CONSTANT_DAY, durationMin: 360, stepMin: 1, sampleMin: 6 };

test('1. RK4 CO2 matches closed form with RMSE far below 0.05 percent', () => {
  const result = E.verifyAnalytics(base);
  assert.ok(result.passed);
  assert.ok(result.co2RmsePercent < 0.05, `CO2 RMSE ${result.co2RmsePercent}%`);
  assert.ok(result.co2RmsePpm < 0.01, `CO2 RMSE ${result.co2RmsePpm} ppm`);
});

test('2. exponential approach reaches 63.2 percent after one time constant', () => {
  const v = E.verifyAnalytics(base);
  assert.ok(Math.abs(v.approachFraction - 0.632) < 0.01, `approach ${v.approachFraction}`);
  assert.ok(Math.abs(v.timeConstantHours - 210 / 180) < 1e-9);
});

test('3. zero ventilation gives a strictly linear CO2 rise', () => {
  const p = { ...base, mechOA: 0, windowMode: 'closed', infiltrationACH: 0, students: 10, stepMin: 5 };
  const run = E.simulate(p);
  const expected = (10 * 18 * 1000 / 210) * 6;
  assert.ok(Math.abs(run.metrics.co2Final - (420 + expected)) < 1e-6);
  assert.ok(Math.abs(run.co2[2] - run.co2[1] - (run.co2[1] - run.co2[0])) < 1e-6);
});

test('4. steady state equals source divided by air-change rate', () => {
  const p = { ...base, mechOA: 360, students: 20 };
  const run = E.simulate({ ...p, durationMin: 2880, sampleMin: 60 });
  const expected = 420 + (20 * 18 * 1000 / 210) / (360 / 210);
  assert.ok(Math.abs(run.metrics.co2Final - expected) < 0.01);
});

test('5. CO2 decreases monotonically when occupants leave', () => {
  const run = E.simulate({ ...base, mechOA: 300, students: 0, co2Start: 1400 });
  for (let i = 1; i < run.co2.length; i += 1) assert.ok(run.co2[i] <= run.co2[i - 1] + 1e-9);
  assert.ok(run.metrics.co2Final > base.outdoorCO2);
});

test('6. schedule occupancy changes the CO2 slope at period boundaries', () => {
  const scheduled = E.simulate({ ...E.DEFAULTS, durationMin: 120, stepMin: 1, sampleMin: 10 });
  const full = E.simulate({ ...E.DEFAULTS, schedule: [{ start: 0, end: 1440, occupancy: 1 }], durationMin: 50, stepMin: 1, sampleMin: 10 });
  assert.ok(scheduled.co2[5] >= 0);
  assert.ok(full.co2[5] > scheduled.co2[5] - 50);
  assert.equal(E.occupancyAt(55, E.DEFAULTS), 0.25);
  assert.equal(E.occupancyAt(120, E.DEFAULTS), 0.1);
});

test('7. single-sided and cross ventilation both increase outdoor airflow', () => {
  const closed = E.ventilationRates({ ...base });
  const single = E.ventilationRates({ ...base, windowMode: 'single', windowOpen: 1 });
  const cross = E.ventilationRates({ ...base, windowMode: 'cross', windowOpen: 1 });
  assert.equal(closed.qNatural, 0);
  assert.ok(single.qNatural > 0);
  assert.ok(cross.qNatural > single.qNatural * 1.5);
  assert.ok(Number.isFinite(single.qStack));
});

test('8. wind and stack combine by root-sum-square', () => {
  const v = E.ventilationRates({ ...base, windowMode: 'cross', windowOpen: 0.5 });
  assert.ok(Math.abs(v.qNatural - Math.hypot(v.qWind, v.qStack)) < 1e-9);
});

test('9. Wells-Riley probability is monotonic in infectious count', () => {
  const p0 = E.wellsRileyProbability(1, { ...base, infectious: 0 });
  const p1 = E.wellsRileyProbability(1, { ...base, infectious: 0.0001 });
  const p2 = E.wellsRileyProbability(1, { ...base, infectious: 0.0002 });
  assert.equal(p0, 0);
  assert.ok(p1 > 0 && p2 > p1);
  assert.ok(p2 < 1);
});

test('10. Wells-Riley probability is monotonic in dose and mask efficiency', () => {
  const p = { ...base, infectious: 0.0001 };
  const low = E.wellsRileyProbability(0.5, p);
  const high = E.wellsRileyProbability(2, p);
  const masked = E.wellsRileyProbability(2, { ...p, maskEfficiency: 0.7 });
  assert.ok(high > low);
  assert.ok(masked < high);
  assert.ok(Math.abs(masked - (1 - (1 - high) ** 0.3)) < 1e-12);
});

test('11. integrated quanta integral matches the closed-form solution', () => {
  const p = { ...base, windowMode: 'cross', windowOpen: 1, crBoxes: 1, hepaUnits: 1, merv13: true, uvgi: true };
  const run = E.simulate(p);
  const expected = E.quantaIntegralAnalytic(6, p);
  assert.ok(Math.abs(run.integral.at(-1) - expected) / expected < 1e-7);
});

test('12. added CADR always lowers accumulated dose', () => {
  const p = { ...base, windowMode: 'closed', mechOA: 100, infectious: 1 };
  const withFilter = E.simulate({ ...p, hepaUnits: 2 });
  const without = E.simulate(p);
  assert.ok(withFilter.integral.at(-1) < without.integral.at(-1));
  assert.ok(E.wellsRileyProbability(withFilter.integral.at(-1), p) < E.wellsRileyProbability(without.integral.at(-1), p));
});

test('13. PM2.5 filtration ODE matches closed form', () => {
  const v = E.verifyAnalytics(base);
  assert.ok(v.pmRmseUg < 1e-6);
  assert.ok(v.pmRatio > 0 && v.pmRatio < 1);
});

test('14. PM2.5 steady ratio rises when filtration is removed', () => {
  const p = { ...base, outdoorPM: 180, hepaUnits: 2, crBoxes: 1 };
  const filtered = E.pmSteadyRatio(p);
  const bare = E.pmSteadyRatio({ ...p, hepaUnits: 0, crBoxes: 0 });
  assert.ok(bare > filtered);
  assert.ok(E.simulate(p).metrics.pmMean < E.simulate({ ...p, hepaUnits: 0, crBoxes: 0 }).metrics.pmMean);
});

test('15. wildfire preset keeps indoor PM2.5 below outdoor level', () => {
  const p = E.getPreset('wildfire-smoke').params;
  const run = E.simulate(p);
  assert.equal(p.outdoorPM, 180);
  assert.ok(run.metrics.pmMean < 180);
  assert.ok(run.metrics.pmMean > 0);
});

test('16. outdoor-to-indoor PM ratio equals the analytic steady-state ratio', () => {
  const p = { ...base, outdoorPM: 50, durationMin: 2880, sampleMin: 120 };
  const run = E.simulate(p);
  assert.ok(Math.abs(run.metrics.pmFinal / 50 - E.pmSteadyRatio(p)) < 1e-6);
});

test('17. Pareto dominance requires one strict improvement and no regression', () => {
  const a = { cost: 10, watts: 10, dBA: 10, co2Peak: 10, pmMean: 10, riskRemaining: 10 };
  const b = { ...a, cost: 11 };
  const c = { ...a, watts: 9 };
  assert.equal(E.dominates(a, b), true);
  assert.equal(E.dominates(b, a), false);
  assert.equal(E.dominates(a, c), false);
  assert.equal(E.dominates(a, { ...a }), false);
});

test('18. Pareto frontier removes every dominated point', () => {
  const points = [
    { cost: 20, watts: 10, dBA: 10, co2Peak: 10, pmMean: 10, riskRemaining: 5 },
    { cost: 20, watts: 20, dBA: 20, co2Peak: 20, pmMean: 20, riskRemaining: 20 },
    { cost: 10, watts: 10, dBA: 10, co2Peak: 10, pmMean: 10, riskRemaining: 10 },
  ];
  const frontier = E.paretoFrontier(points);
  assert.equal(frontier.length, 2);
  assert.ok(frontier.some((p) => p.cost === 10));
  assert.ok(frontier.some((p) => p.cost === 20 && p.riskRemaining === 5));
  assert.ok(!frontier.some((p) => p.watts === 20));
});

test('19. frontier members never dominate one another', () => {
  const frontier = E.optimizeRetrofits(E.getPreset('standard28').params).frontier;
  assert.ok(frontier.length > 1);
  for (const a of frontier) {
    for (const b of frontier) {
      if (a !== b) assert.equal(E.dominates(a, b), false);
    }
  }
});

test('20. budget constraint excludes expensive options', () => {
  const p = E.getPreset('standard28').params;
  const low = E.optimizeRetrofits(p, 0);
  assert.ok(low.affordable.length > 0);
  assert.ok(low.affordable.every((s) => s.cost === 0));
  assert.ok(E.optimizeRetrofits(p, 5000).affordable.length > low.affordable.length);
});

test('21. optimization completes in a bounded number of exact evaluations', () => {
  const t0 = performance.now();
  const result = E.optimizeRetrofits(E.getPreset('standard28').params);
  const ms = performance.now() - t0;
  assert.equal(result.all.length, 120);
  assert.ok(ms < 3000, `optimizer took ${ms} ms`);
});

test('22. zero and extreme inputs stay finite and clamped', () => {
  const empty = E.simulate({ students: -10, volume: -5, outdoorPM: NaN, durationMin: 1e9 });
  assert.ok(empty.co2.every(Number.isFinite));
  assert.ok(empty.pm.every(Number.isFinite));
  const p = E.normalizeParams({ students: -10, volume: -5, studentsRaw: undefined, windowOpen: 9 });
  assert.equal(p.students, 0);
  assert.equal(p.volume, 10);
  assert.equal(p.windowOpen, 1);
});

test('23. share codec round-trips allowlisted state', () => {
  const original = { ...E.getPreset('wildfire-smoke').params, presetId: 'wildfire-smoke' };
  const hash = E.encodeShare(original);
  assert.ok(hash.startsWith('#v=1&'));
  const decoded = E.decodeShare(hash);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.state.outdoorPM, 180);
  assert.equal(decoded.state.students, 26);
  assert.equal(decoded.state.presetId, 'wildfire-smoke');
  assert.deepEqual(E.decodeShare(E.encodeShare(decoded.state)).state, decoded.state);
});

test('24. hostile and malformed hashes are rejected without throwing', () => {
  const hostile = [
    '#v=1&s=28<script>alert(1)</script>',
    '#v=1&s=28&onclick=alert(1)',
    '#v=1&__proto__=x',
    '#v=2&s=28',
    '#v=1&s=28&s=29',
    '#v=1&s=999999',
    '#v=1&s=1e9',
    '#v=1&s=-5',
    '#v=1&mode=javascript:alert(1)',
    '#v=1&open=101',
    `#v=1&${'a'.repeat(700)}`,
    '#v=1&merv=true',
    '#v=1&s=28&co2=420&pm=12&x=1',
  ];
  for (const hash of hostile) assert.equal(E.decodeShare(hash).ok, false, hash);
  assert.equal(E.decodeShare(null).ok, false);
  assert.equal(E.decodeShare('').ok, false);
});

test('25. escapeHtml neutralizes every dangerous HTML character', () => {
  const escaped = E.escapeHtml(`<script>"&'</script>`);
  assert.equal(escaped, '&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;');
  assert.ok(!escaped.includes('<'));
});

test('26. presets are labeled as synthetic reference models', () => {
  assert.equal(E.PRESETS.length, 5);
  for (const preset of E.PRESETS) {
    assert.match(preset.note, /Synthetic reference model/);
    assert.ok(Number.isFinite(E.simulate(preset.params).metrics.co2Peak));
  }
});

test('27. fixtures are deterministic across repeated calls', () => {
  const a = E.simulate(E.getPreset('crowded-lab').params);
  const b = E.simulate(E.getPreset('crowded-lab').params);
  assert.deepEqual(a.co2, b.co2);
  assert.deepEqual(a.pm, b.pm);
  assert.deepEqual(a.integral, b.integral);
});

test('28. masks do not change CO2 but do change Wells-Riley risk', () => {
  const p = { ...E.getPreset('standard28').params, infectious: 1 };
  const unmasked = E.evaluateScenario({ ...p, maskEfficiency: 0 });
  const masked = E.evaluateScenario({ ...p, maskEfficiency: 0.7 });
  assert.ok(Math.abs(unmasked.metrics.co2Peak - masked.metrics.co2Peak) < 1e-9);
  assert.ok(masked.metrics.riskFinal < unmasked.metrics.riskFinal);
});

test('29. RK4 stays finite and accurate under stiff high-ACH small-room cross-ventilation', () => {
  for (const volume of [80, 100, 120, 140]) {
    for (const windSpeed of [6, 8]) {
      const p = {
        ...E.getPreset('standard28').params,
        volume,
        windSpeed,
        windowMode: 'cross',
        windowOpen: 1.0,
        mechOA: 0,
        stepMin: 2,
        infectious: 1,
      };
      const out = E.evaluateScenario(p);
      assert.ok(Number.isFinite(out.metrics.co2Peak) && out.metrics.co2Peak >= p.outdoorCO2);
      assert.ok(Number.isFinite(out.metrics.pmMean) && out.metrics.pmMean >= 0);
      assert.ok(Number.isFinite(out.metrics.riskFinal) && out.metrics.riskFinal >= 0 && out.metrics.riskFinal <= 100);
      const opt = E.optimizeRetrofits(p, 1200);
      assert.ok(opt.frontier.length > 0 && opt.frontier.length < opt.all.length);
    }
  }
});
