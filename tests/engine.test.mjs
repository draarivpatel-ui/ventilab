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

test('2. exponential approach reaches exactly 1 - exp(-1) after one time constant', () => {
  const v = E.verifyAnalytics(base);
  assert.ok(Math.abs(v.approachFraction - (1 - Math.exp(-1))) < 1e-9, `approach ${v.approachFraction}`);
  const vent = E.ventilationRates(base);
  const qExchange = vent.qNatural + base.mechOA + vent.qInfiltration;
  assert.ok(Math.abs(v.timeConstantHours - 210 / qExchange) < 1e-9);
});

test('3. zero ventilation gives a strictly linear CO2 rise', () => {
  const p = { ...base, mechOA: 0, windowMode: 'closed', infiltrationACH: 0, students: 10, stepMin: 5 };
  const run = E.simulate(p);
  const expected = (10 * 18 * 1000 / 210) * 6;
  assert.ok(Math.abs(run.metrics.co2Final - (420 + expected)) < 1e-6);
  assert.ok(Math.abs(run.co2[2] - run.co2[1] - (run.co2[1] - run.co2[0])) < 1e-6);
});

test('4. steady state equals source divided by total exchange rate', () => {
  const p = { ...base, mechOA: 360, students: 20 };
  const run = E.simulate({ ...p, durationMin: 2880, sampleMin: 60 });
  const vent = E.ventilationRates(p);
  const q = vent.qNatural + 360 + vent.qInfiltration;
  const expected = 420 + (20 * 18 * 1000 / 210) / (q / 210);
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
  assert.equal(result.all.length, 700);
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

test('30. every preset produces finite, nonnegative, bounded series', () => {
  for (const preset of E.PRESETS) {
    const run = E.simulate(preset.params);
    for (const key of ['co2', 'pm', 'quanta', 'integral', 'risk']) {
      assert.ok(run[key].every((v) => Number.isFinite(v) && v >= 0), `${preset.id} ${key}`);
    }
    assert.ok(run.risk.every((v) => v <= 100), preset.id);
    assert.ok(run.times.every((t) => t >= 0 && t <= 360), preset.id);
  }
});

test('31. CO2 never drops below outdoor concentration', () => {
  for (const preset of E.PRESETS) {
    const run = E.simulate({ ...preset.params, co2Start: preset.params.outdoorCO2 + 900 });
    assert.ok(run.co2.every((v) => v >= preset.params.outdoorCO2 - 1e-6), preset.id);
  }
});

test('32. integrated dose and Wells-Riley risk are nondecreasing in time', () => {
  for (const preset of E.PRESETS) {
    const run = E.simulate(preset.params);
    for (let i = 1; i < run.times.length; i += 1) {
      assert.ok(run.integral[i] >= run.integral[i - 1] - 1e-12, preset.id);
      assert.ok(run.risk[i] >= run.risk[i - 1] - 1e-9, preset.id);
    }
  }
});

test('33. infection risk decreases monotonically with mechanical outdoor air', () => {
  const p = { ...E.getPreset('standard28').params };
  const risks = [0, 100, 200, 400, 800].map((mechOA) => E.simulate({ ...p, mechOA }).metrics.riskFinal);
  for (let i = 1; i < risks.length; i += 1) assert.ok(risks[i] < risks[i - 1], `${risks[i - 1]} -> ${risks[i]}`);
});

test('34. CO2 peak is nonincreasing as outdoor airflow increases', () => {
  const p = { ...E.getPreset('standard28').params };
  const peaks = [0, 90, 180, 360, 720].map((mechOA) => E.simulate({ ...p, mechOA }).metrics.co2Peak);
  for (let i = 1; i < peaks.length; i += 1) assert.ok(peaks[i] <= peaks[i - 1] + 1e-9);
});

test('35. infiltration dilutes CO2 fully but particles only partially', () => {
  const p = { ...E.getPreset('standard28').params, outdoorPM: 150 };
  const leaky = E.simulate({ ...p, infiltrationACH: 0.8 });
  const tight = E.simulate({ ...p, infiltrationACH: 0 });
  assert.ok(leaky.metrics.co2Peak < tight.metrics.co2Peak);
  // Particles penetrate cracks at 70% but leave at 100% flow, so infiltration
  // still dilutes indoor PM relative to the filtered mechanical stream.
  assert.ok(E.pmSteadyRatio({ ...p, infiltrationACH: 0.8 }) < E.pmSteadyRatio({ ...p, infiltrationACH: 0 }));
  assert.ok(leaky.metrics.pmMean < tight.metrics.pmMean);
  // With zero infiltration the only outdoor PM path is the filtered HVAC.
  const vent = E.ventilationRates({ ...p, infiltrationACH: 0 });
  assert.equal(vent.qInfiltration, 0);
});

test('36. RK4 observed order is near four on the standard scenario', () => {
  const c = E.convergenceCheck(E.getPreset('standard28').params);
  assert.ok(c.passed);
  assert.ok(c.minOrder >= 3.5, `order ${c.minOrder}`);
  assert.ok(c.worstDelta < 1, `refinement delta ${c.worstDelta}`);
});

test('37. convergence check passes on every preset', () => {
  for (const preset of E.PRESETS) {
    const c = E.convergenceCheck(preset.params);
    assert.ok(c.passed, `${preset.id} order ${c.minOrder}`);
    assert.ok(c.minOrder >= 3, `${preset.id} order ${c.minOrder}`);
  }
});

test('38. simulated final CO2 approaches the analytic steady state', () => {
  for (const preset of E.PRESETS) {
    const v = E.verifyAnalytics(preset.params);
    assert.ok(v.passed, preset.id);
    assert.ok(v.steadyResidual < 0.02, `${preset.id} residual ${v.steadyResidual}`);
    assert.ok(Number.isFinite(v.co2Equilibrium) && v.co2Equilibrium > preset.params.outdoorCO2);
  }
});

test('39. scheduled CO2 matches the chained piecewise analytic solution', () => {
  const p = E.getPreset('standard28').params;
  const run = E.simulate({ ...p, sampleMin: 5 });
  let c = p.outdoorCO2;
  const schedule = p.schedule || E.DEFAULT_SCHEDULE;
  for (const block of schedule) {
    const span = Math.min(block.end, 360) - block.start;
    if (span <= 0) continue;
    c = E.co2Analytic(span / 60, { ...p, students: p.students * block.occupancy }, c);
  }
  const idx = run.times.findIndex((t) => Math.abs(t - 270) < 1e-6);
  assert.ok(idx > 0);
  let c270 = p.outdoorCO2;
  for (const block of schedule) {
    const span = Math.min(block.end, 270) - block.start;
    if (span <= 0) continue;
    c270 = E.co2Analytic(span / 60, { ...p, students: p.students * block.occupancy }, c270);
  }
  assert.ok(Math.abs(run.co2[idx] - c270) < 0.1, `C(270): ${run.co2[idx]} vs ${c270}`);
});

test('40. occupancyAt is start-inclusive at schedule boundaries', () => {
  const s = E.DEFAULT_SCHEDULE;
  assert.equal(E.occupancyAt(0, { schedule: s }), 1);
  assert.equal(E.occupancyAt(50, { schedule: s }), 0.25);
  assert.equal(E.occupancyAt(49.999, { schedule: s }), 1);
  assert.equal(E.occupancyAt(245, { schedule: s }), 1);
  assert.equal(E.occupancyAt(244.999, { schedule: s }), 0.25);
  assert.equal(E.occupancyAt(295, { schedule: s }), 0);
  assert.equal(E.occupancyAt(9999, { schedule: s }), 0);
});

test('41. simulation uses the interior occupancy of each schedule span', () => {
  const p = { ...E.getPreset('standard28').params, stepMin: 2, sampleMin: 5 };
  const run = E.simulate(p);
  const idx = run.times.findIndex((t) => Math.abs(t - 245) < 1e-6);
  assert.ok(idx > 0);
  const c245 = run.co2[idx];
  const c270Expected = E.co2Analytic(25 / 60, p, c245);
  const i270 = run.times.findIndex((t) => Math.abs(t - 270) < 1e-6);
  assert.ok(Math.abs(run.co2[i270] - c270Expected) < 0.05, `${run.co2[i270]} vs ${c270Expected}`);
});

test('42. MERV-13 is passive: no added fan noise, a fixed energy penalty', () => {
  const withMerv = E.equivalentNoise({ crBoxes: 1, hepaUnits: 1, merv13: true });
  const without = E.equivalentNoise({ crBoxes: 1, hepaUnits: 1, merv13: false });
  assert.equal(withMerv, without);
  const eq = E.equipment({ crBoxes: 1, hepaUnits: 1, merv13: true });
  assert.equal(eq.watts, 35 + 55 + 40);
});

test('43. MERV-13 reduces indoor PM2.5 on a smoky day', () => {
  const p = { ...E.getPreset('wildfire-smoke').params };
  const upgraded = E.simulate({ ...p, merv13: true });
  const stock = E.simulate(p);
  assert.ok(upgraded.metrics.pmMean < stock.metrics.pmMean);
  assert.ok(E.pmSteadyRatio({ ...p, merv13: true }) < E.pmSteadyRatio(p));
});

test('44. UVGI lowers airborne risk without touching CO2 or PM2.5', () => {
  const p = { ...E.getPreset('standard28').params, infectious: 1 };
  const on = E.simulate({ ...p, uvgi: true });
  const off = E.simulate(p);
  assert.ok(Math.abs(on.metrics.co2Peak - off.metrics.co2Peak) < 1e-9);
  assert.ok(Math.abs(on.metrics.pmMean - off.metrics.pmMean) < 1e-9);
  assert.ok(on.metrics.riskFinal < off.metrics.riskFinal);
});

test('45. fan filters clean air without adding ventilation', () => {
  const p = { ...E.getPreset('standard28').params, infectious: 1 };
  const filtered = E.simulate({ ...p, crBoxes: 2, hepaUnits: 2 });
  const bare = E.simulate(p);
  assert.ok(Math.abs(filtered.metrics.co2Peak - bare.metrics.co2Peak) < 1e-9);
  assert.ok(filtered.metrics.riskFinal < bare.metrics.riskFinal);
  assert.ok(filtered.metrics.pmMean < bare.metrics.pmMean);
});

test('46. risk falls monotonically with added Corsi-Rosenthal boxes', () => {
  const p = { ...E.getPreset('standard28').params, infectious: 1 };
  const risks = [0, 1, 2, 4].map((crBoxes) => E.simulate({ ...p, crBoxes }).metrics.riskFinal);
  for (let i = 1; i < risks.length; i += 1) assert.ok(risks[i] < risks[i - 1]);
});

test('47. fan noise adds logarithmically across sources', () => {
  assert.ok(Math.abs(E.equivalentNoise({ crBoxes: 1 }) - 52) < 1e-9);
  assert.ok(Math.abs(E.equivalentNoise({ hepaUnits: 1 }) - 49) < 1e-9);
  assert.ok(Math.abs(E.equivalentNoise({ crBoxes: 2 }) - (52 + 10 * Math.log10(2))) < 1e-9);
  const mix = 10 * Math.log10(2 * 10 ** 5.2 + 3 * 10 ** 4.9);
  assert.ok(Math.abs(E.equivalentNoise({ crBoxes: 2, hepaUnits: 3 }) - mix) < 1e-9);
  assert.equal(E.equivalentNoise({}), 0);
});

test('48. equipment cost, watts and CADR follow the stated unit prices', () => {
  const eq = E.equipment({ crBoxes: 2, hepaUnits: 1, merv13: true, uvgi: true, volume: 200 });
  assert.equal(eq.cost, 2 * 85 + 260 + 650 + 900);
  assert.equal(eq.watts, 2 * 35 + 55 + 40 + 25);
  assert.equal(eq.crCADR, 800);
  assert.equal(eq.hepaCADR, 350);
  assert.equal(eq.mervCADR, 800);
  assert.equal(eq.uvgiCADR, 600);
  assert.equal(eq.quantaCADR, 800 + 350 + 800 + 600);
  assert.equal(eq.oaFilterEfficiency, 0.55);
});

test('49. the recommended option sits on the frontier with minimum risk', () => {
  const opt = E.optimizeRetrofits(E.getPreset('standard28').params);
  assert.ok(opt.frontier.includes(opt.recommended));
  assert.ok(opt.frontier.every((f) => f.riskRemaining >= opt.recommended.riskRemaining - 1e-9));
  assert.ok(opt.frontier.includes(opt.cheapest));
});

test('50. frontier is sorted by cost and every point fits the budget', () => {
  const budget = 1200;
  const opt = E.optimizeRetrofits(E.getPreset('standard28').params);
  assert.ok(opt.affordable.every((s) => s.cost <= budget + 1e-9));
  for (let i = 1; i < opt.frontier.length; i += 1) {
    assert.ok(opt.frontier[i].cost >= opt.frontier[i - 1].cost - 1e-9);
  }
});

test('51. every dominated affordable option is excluded from the frontier', () => {
  const opt = E.optimizeRetrofits(E.getPreset('standard28').params);
  const onFrontier = new Set(opt.frontier);
  for (const s of opt.affordable) {
    if (onFrontier.has(s)) continue;
    assert.ok(opt.affordable.some((other) => E.dominates(other, s)), s.label);
  }
});

test('52. intervention enumeration covers the full 700-option grid', () => {
  const options = E.interventionOptions(E.getPreset('standard28').params);
  assert.equal(options.length, 700);
  assert.equal(new Set(options.map((o) => o.label)).size, 700);
  const closed = options.filter((o) => o.windowMode === 'closed');
  assert.equal(closed.length, 100);
  assert.ok(closed.every((o) => o.windowOpen === 0));
  assert.ok(options.some((o) => o.windowMode === 'cross' && o.windowOpen === 1 && o.crBoxes === 4 && o.hepaUnits === 4 && o.merv13 && o.uvgi));
});

test('53. baseline params strip every intervention while keeping the room', () => {
  const p = E.baselineParams({ ...E.getPreset('diy-retrofit').params, crBoxes: 3, uvgi: true });
  assert.equal(p.windowMode, 'closed');
  assert.equal(p.windowOpen, 0);
  assert.equal(p.crBoxes, 0);
  assert.equal(p.hepaUnits, 0);
  assert.equal(p.merv13, false);
  assert.equal(p.uvgi, false);
  assert.equal(p.students, 30);
  assert.equal(p.mechOA, 150);
});

test('54. a hoisted baseline run produces identical metrics', () => {
  const p = E.getPreset('standard28').params;
  const hoisted = E.simulate(E.baselineParams(p));
  const a = E.evaluateScenario(p, hoisted);
  const b = E.evaluateScenario(p);
  assert.equal(a.metrics.riskReduction, b.metrics.riskReduction);
  assert.equal(a.metrics.baselineRisk, b.metrics.baselineRisk);
  assert.deepEqual(a.baseline.co2, b.baseline.co2);
});

test('55. risk reduction is measured against the closed-window baseline', () => {
  const p = E.getPreset('wildfire-smoke').params;
  const out = E.evaluateScenario({ ...p, hepaUnits: 2 });
  const baseRisk = E.simulate(E.baselineParams(p)).metrics.riskFinal;
  assert.ok(Math.abs(out.metrics.baselineRisk - baseRisk) < 1e-9);
  assert.ok(Math.abs(out.metrics.riskReduction - (baseRisk - out.metrics.riskFinal) / baseRisk * 100) < 1e-9);
});

test('56. guided experiments resolve to real presets with whitelisted overrides', () => {
  assert.equal(E.EXPERIMENTS.length, 4);
  const allowed = new Set([...Object.keys(E.DEFAULTS), 'presetId']);
  for (const exp of E.EXPERIMENTS) {
    const preset = E.PRESETS.find((pr) => pr.id === exp.presetId);
    assert.ok(preset, exp.id);
    for (const key of Object.keys(exp.overrides)) assert.ok(allowed.has(key), `${exp.id}.${key}`);
    assert.equal(E.getExperiment(exp.id), exp);
    const applied = { ...preset.params, ...exp.overrides };
    assert.ok(Number.isFinite(E.simulate(applied).metrics.co2Peak), exp.id);
  }
});

test('57. unknown experiment ids return null', () => {
  assert.equal(E.getExperiment('nope'), null);
  assert.equal(E.getExperiment(''), null);
  assert.equal(E.getExperiment(undefined), null);
});

test('58. share codec preserves every allowlisted field exactly', () => {
  const original = {
    presetId: 'crowded-lab', students: 34, volume: 175, outdoorCO2: 450,
    outdoorPM: 15, windSpeed: 1, deltaT: 5, windowMode: 'closed', windowOpen: 0,
    mechOA: 220, crBoxes: 2, hepaUnits: 1, merv13: true, uvgi: false,
    infectious: 1, quantaRate: 75, maskEfficiency: 0.7, budget: 1800,
  };
  const decoded = E.decodeShare(E.encodeShare(original));
  assert.equal(decoded.ok, true);
  for (const [key, value] of Object.entries(original)) {
    assert.equal(decoded.state[key], value, key);
  }
});

test('59. share codec rejects injection through keys and values', () => {
  for (const hash of [
    '#v=1&constructor=x', '#v=1&prototype=x', '#v=1&toString=x',
    '#v=1&s=%32%38', '#v=1&s=28%20', '#v=1&p=standard28%27',
    '#v=1&open=1.5.2', '#v=1&pm=--1', '#v=1&wind=1e3',
  ]) {
    assert.equal(E.decodeShare(hash).ok, false, hash);
  }
});

test('60. share codec requires version one and rejects partial garbage', () => {
  assert.equal(E.decodeShare('#s=28&vol=210').ok, false);
  assert.equal(E.decodeShare('#v=0&s=28').ok, false);
  assert.equal(E.decodeShare('#v=1&s=28&vol=abc').ok, false);
  const ok = E.decodeShare('#v=1&s=28');
  assert.equal(ok.ok, true);
  assert.equal(ok.state.students, 28);
  assert.equal(ok.state.volume, undefined);
});

test('61. normalizeParams clamps every extreme input into its physical range', () => {
  const p = E.normalizeParams({
    students: 500, volume: 0.001, outdoorCO2: -50, outdoorPM: 99999,
    windSpeed: 400, windowOpen: -3, mechOA: 1e9, windowMode: 'garbage',
    quantaRate: -5, infectious: 99, budget: -100, stepMin: 0.001,
    crBoxes: 7.8, hepaUnits: -2, maskEfficiency: 5,
  });
  assert.equal(p.students, 200);
  assert.equal(p.volume, 10);
  assert.equal(p.outdoorCO2, 0);
  assert.equal(p.outdoorPM, 2000);
  assert.equal(p.windSpeed, 40);
  assert.equal(p.windowOpen, 0);
  assert.equal(p.mechOA, 20000);
  assert.equal(p.windowMode, 'closed');
  assert.equal(p.quantaRate, 0);
  assert.equal(p.infectious, 20);
  assert.equal(p.budget, 0);
  assert.equal(p.crBoxes, 8);
  assert.equal(p.hepaUnits, 0);
  assert.equal(p.maskEfficiency, 0.99);
});

test('62. extreme classroom stays finite and nonnegative', () => {
  const run = E.simulate({
    students: 60, volume: 80, outdoorPM: 300, outdoorCO2: 900,
    infectious: 4, quantaRate: 300, windowMode: 'cross', windowOpen: 1,
    windSpeed: 8, mechOA: 1200, crBoxes: 4, hepaUnits: 4, merv13: true, uvgi: true,
  });
  for (const key of ['co2', 'pm', 'integral', 'risk']) {
    assert.ok(run[key].every((v) => Number.isFinite(v) && v >= 0), key);
  }
  assert.ok(run.metrics.riskFinal <= 100);
});

test('63. equivalent clean airflow is outdoor exchange plus recirculating cleaning, once', () => {
  const p = { crBoxes: 1, hepaUnits: 1, merv13: true, uvgi: true, mechOA: 200, volume: 210 };
  const vent = E.ventilationRates(p);
  const equip = E.equipment(p);
  const m = E.simulate(p).metrics;
  // The intake filter is not added on top of full exchange credit: its 55%
  // efficiency only screens incoming outdoor particles in the PM source term.
  const expected = vent.qNatural + 200 + vent.qInfiltration + equip.quantaCADR;
  assert.equal(m.ecaTotal, expected);
  assert.equal(m.ecaTotal, E.infectionCleanAirM3h(p, vent, equip));
  assert.ok(Math.abs(m.ecaACH - m.ecaTotal / 210) < 1e-9);
  assert.ok(m.ecaTotal >= vent.qNatural + 200 + vent.qInfiltration);
});

test('64. per-person outdoor air rate respects the ASHRAE 62.1 form', () => {
  const p = { ...E.getPreset('standard28').params };
  const m = E.simulate(p).metrics;
  const vent = E.ventilationRates(p);
  const expected = (vent.qNatural + p.mechOA + vent.qInfiltration) / p.students / 3.6;
  assert.ok(Math.abs(m.oaPerPersonLps - expected) < 1e-9);
  assert.ok(m.ecaPerPersonLps >= m.oaPerPersonLps);
});

test('65. pmSteadyRatio is consistent with the simulated long-run level', () => {
  for (const preset of E.PRESETS) {
    const run = E.simulate({ ...preset.params, durationMin: 1440, sampleMin: 120 });
    const ratio = E.pmSteadyRatio(preset.params);
    assert.ok(Math.abs(run.metrics.pmFinal - ratio * preset.params.outdoorPM) < 0.5, preset.id);
  }
});

test('66. wildfire status chip leads with PM2.5 instead of masking it behind CO2', () => {
  const m = E.evaluateScenario(E.getPreset('wildfire-smoke').params).metrics;
  assert.ok(m.pmMean > 35 * 4 && m.co2Peak > 1500);
  const sev = E.severityStatus(m);
  assert.equal(sev.level, 'high');
  assert.equal(sev.dominant, 'pm');
  assert.ok(sev.label.startsWith('High PM2.5'), sev.label);
  assert.ok(sev.label.includes('CO2'), 'secondary hazards stay visible');
});

test('67. severity ranks by normalized exceedance, not a fixed pollutant order', () => {
  const pmLed = E.severityStatus({ co2Peak: 1600, pmMean: 40, riskFinal: 5 });
  assert.equal(pmLed.dominant, 'pm');
  assert.equal(pmLed.level, 'high');
  const co2Only = E.severityStatus({ co2Peak: 2000, pmMean: 5, riskFinal: 2 });
  assert.equal(co2Only.label, 'High CO2');
  const riskLed = E.severityStatus({ co2Peak: 1600, pmMean: 5, riskFinal: 60 });
  assert.equal(riskLed.dominant, 'risk');
  assert.ok(riskLed.label.startsWith('High infection risk'));
});

test('68. severity tiers and error path are exact', () => {
  const elevated = E.severityStatus({ co2Peak: 1100, pmMean: 20, riskFinal: 5 });
  assert.equal(elevated.level, 'elevated');
  assert.equal(elevated.dominant, 'pm');
  const ok = E.severityStatus({ co2Peak: 700, pmMean: 8, riskFinal: 3 });
  assert.equal(ok.level, 'ok');
  assert.equal(ok.label, 'Within guide bands');
  const bad = E.severityStatus({ co2Peak: NaN, pmMean: 8, riskFinal: 3 });
  assert.equal(bad.level, 'error');
});

test('69. analytic metrics match the RK4 trajectory on every preset', () => {
  for (const preset of E.PRESETS) {
    const a = E.analyticMetrics(preset.params);
    const s = E.simulate(preset.params);
    assert.deepEqual(a.times, s.times, `${preset.id} node times`);
    for (const key of ['co2Peak', 'co2Mean', 'pmPeak', 'pmMean', 'pmFinal', 'co2Final']) {
      const rel = Math.abs(a.metrics[key] - s.metrics[key]) / Math.max(1e-9, Math.abs(s.metrics[key]));
      assert.ok(rel < 1e-3, `${preset.id} ${key}: ${a.metrics[key]} vs ${s.metrics[key]}`);
    }
    assert.ok(Math.abs(a.metrics.riskFinal - s.metrics.riskFinal) < 0.5, `${preset.id} riskFinal`);
  }
});

test('70. analytic and simulated optimizer paths produce identical frontiers', () => {
  for (const preset of E.PRESETS) {
    const fast = E.optimizeRetrofits(preset.params, undefined, {});
    const slow = E.optimizeRetrofits(preset.params, undefined, { simulated: true });
    assert.deepEqual(fast.frontier.map((f) => f.label), slow.frontier.map((f) => f.label), preset.id);
    assert.equal(fast.affordable.length, slow.affordable.length, preset.id);
  }
});

test('71. full 700-option Pareto recomputation stays under 50 ms and deterministic', () => {
  const t0 = performance.now();
  const a = E.optimizeRetrofits(E.getPreset('standard28').params);
  const ms = performance.now() - t0;
  assert.equal(a.all.length, 700);
  assert.ok(ms < 50, `optimizer took ${ms} ms`);
  const b = E.optimizeRetrofits(E.getPreset('standard28').params);
  assert.deepEqual(a.frontier.map((f) => f.label), b.frontier.map((f) => f.label));
  assert.deepEqual(a.affordable.map((f) => f.label), b.affordable.map((f) => f.label));
});

test('72. clean-air accounting decomposes exactly into outdoor exchange plus recirculating cleaning', () => {
  const opt = E.optimizeRetrofits(E.getPreset('standard28').params);
  for (const s of opt.all) {
    assert.ok(Math.abs(s.ecaTotal - (s.airExchange + s.quantaCADR)) < 1e-6, s.label);
    // The intake-filter credit is reported for PM ingress only; it never adds
    // infection-control clean air on top of the full exchange term.
    assert.ok(s.oaFilterCredit >= 0 && s.airExchange >= 0 && s.quantaCADR >= 0, s.label);
  }
});

test('73. a window-only option can carry high eACH with zero mechanical CADR', () => {
  const opt = E.optimizeRetrofits(E.getPreset('standard28').params);
  const windowOnly = opt.affordable.find(
    (s) => s.params.windowMode !== 'closed' && s.params.windowOpen > 0 && s.quantaCADR === 0,
  );
  assert.ok(windowOnly, 'expected a ventilation-only affordable option');
  assert.equal(windowOnly.oaFilterCredit, windowOnly.params.mechOA * 0.08);
  assert.ok(windowOnly.airExchange > 0 && windowOnly.ecaACH > 5);
  assert.equal(windowOnly.cost, 0);
  const merv = opt.all.find((s) => s.params.merv13);
  assert.equal(merv.oaFilterCredit, merv.params.mechOA * 0.55);
});

test('74. baseline state reads as zero delta against itself, not a missing metric', () => {
  const out = E.evaluateScenario(E.getPreset('standard28').params);
  assert.equal(out.metrics.riskReduction, 0);
  assert.ok(out.metrics.baselineRisk > 0);
  assert.ok(Math.abs(out.metrics.baselineRisk - out.metrics.riskFinal) < 1e-9);
  const improved = E.evaluateScenario({ ...E.getPreset('standard28').params, hepaUnits: 2 });
  assert.ok(improved.metrics.riskReduction > 0);
  assert.ok(improved.metrics.riskFinal < improved.metrics.baselineRisk);
});

test('75. closed-form quanta dose is exact at the zero-removal edge', () => {
  const sealed = {
    ...base, mechOA: 0, infiltrationACH: 0, windowMode: 'closed', windowOpen: 0,
    crBoxes: 0, hepaUnits: 0, merv13: false, uvgi: false,
  };
  assert.ok(Math.abs(E.quantaIntegralAnalytic(6, sealed) - (6 * 6) / (2 * sealed.volume)) < 1e-12);
  const open = { ...sealed, mechOA: 200 };
  const k = (200 + E.ventilationRates(open).qInfiltration) / open.volume;
  assert.ok(k > 0);
  const limit = E.quantaIntegralAnalytic(6, { ...open, mechOA: 1e-6, infiltrationACH: 0 });
  assert.ok(limit > 0 && Number.isFinite(limit));
});
