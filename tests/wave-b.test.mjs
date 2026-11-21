import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';

const CONSTANT = [{ start: 0, end: 1440, label: 'Constant', occupancy: 1 }];

// ------------------------------------------------- finding 1: intake filter
// must not double-count mechanical outdoor air for infection control

test('139. filtered outdoor air adds no clean air on top of full exchange', () => {
  // Sol's probe: 100 m3 room, closed windows, zero infiltration, 100 m3/h of
  // MERV-13-filtered mechanical outdoor air, recirculation CADR disabled.
  const p = {
    volume: 100, durationMin: 60, windowMode: 'closed', windowOpen: 0,
    infiltrationACH: 0, mechOA: 100, merv13: true, cadrScale: 0,
    students: 0, schedule: CONSTANT,
  };
  const analytic = E.analyticMetrics(p).metrics;
  const simulated = E.simulate(p).metrics;
  assert.equal(analytic.ecaTotal, 100);
  assert.equal(simulated.ecaTotal, 100);
  const np = E.normalizeParams(p);
  assert.equal(E.infectionCleanAirM3h(np, E.ventilationRates(np), E.equipment(np)), 100);
  // Unit-source dose over one hour at 1 ACH is exactly exp(-1) / volume.
  assert.ok(Math.abs(analytic.dose - 0.0036787944) < 1e-10, `dose ${analytic.dose}`);
  assert.ok(Math.abs(simulated.dose - 0.0036787944) < 1e-9, `dose ${simulated.dose}`);
  assert.ok(Math.abs(E.quantaIntegralAnalytic(1, p) - 0.0036787944) < 1e-10);
});

test('140. intake filter still cuts PM ingress while dose ignores it', () => {
  const p = {
    volume: 100, durationMin: 60, windowMode: 'closed', windowOpen: 0,
    infiltrationACH: 0, mechOA: 100, cadrScale: 0, outdoorPM: 50,
    students: 0, schedule: CONSTANT,
  };
  const merv = E.analyticMetrics({ ...p, merv13: true }).metrics;
  const stock = E.analyticMetrics({ ...p, merv13: false }).metrics;
  // With recirculation disabled, infection-control clean air and unit dose
  // are identical with or without the intake filter.
  assert.equal(merv.ecaTotal, stock.ecaTotal);
  assert.equal(merv.dose, stock.dose);
  // The 55% intake filter still reduces incoming particles versus the 8%
  // stock filter, exactly where its efficiency belongs.
  assert.ok(merv.pmMean < stock.pmMean);
  assert.ok(merv.pmMean > 0);
});

// ------------------------------------------------- finding 2: exact means
// independent of chart sampling, on both solver paths

test('141. PM mean is the exact 50/e integral at any sample interval', () => {
  // Sol's probe: indoor PM starts at zero, outdoor 100 ug/m3 penetrates a
  // 1 ACH envelope at 50%, so the exact one-hour mean is 50/e.
  const p = {
    pmStart: 0, outdoorPM: 100, infiltrationFactor: 0.5, infiltrationACH: 1,
    durationMin: 60, mechOA: 0, windowMode: 'closed', windowOpen: 0,
    students: 0, schedule: CONSTANT, stepMin: 1,
  };
  const exact = 50 / Math.E;
  for (const sampleMin of [60, 30, 1]) {
    const analytic = E.analyticMetrics({ ...p, sampleMin }).metrics.pmMean;
    const simulated = E.simulate({ ...p, sampleMin }).metrics.pmMean;
    assert.ok(Math.abs(analytic - exact) < 1e-9, `sampleMin ${sampleMin}: ${analytic}`);
    assert.ok(Math.abs(simulated - exact) < 1e-6, `sampleMin ${sampleMin}: ${simulated}`);
  }
});

test('142. CO2 and PM means never move with sampleMin on a real schedule', () => {
  const p = E.getPreset('standard28').params;
  for (const key of ['co2Mean', 'pmMean']) {
    const values = [60, 30, 6, 1].map((sampleMin) => E.analyticMetrics({ ...p, sampleMin }).metrics[key]);
    // Span decomposition changes only floating-point summation rounding.
    for (const v of values) assert.ok(Math.abs(v - values[0]) / Math.abs(values[0]) < 1e-12, `${key} moved: ${values}`);
  }
  // The RK4 path reports the same continuous integral, not a node average.
  for (const key of ['co2Mean', 'pmMean']) {
    const analytic = E.analyticMetrics(p).metrics[key];
    const simulated = E.simulate(p).metrics[key];
    const rel = Math.abs(analytic - simulated) / Math.max(1e-9, Math.abs(analytic));
    assert.ok(rel < 1e-6, `${key}: ${analytic} vs ${simulated}`);
  }
});

// ------------------------------------------------- finding 3: approachFraction
// normalized by the full gap to equilibrium, N/A when undefined

test('143. approach after one tau is exactly 1 - exp(-1)', () => {
  // Sol's probe used to report 1.4010 against a six-hour denominator.
  const v = E.verifyAnalytics({ volume: 200, mechOA: 0, infiltrationACH: 0.1, windowMode: 'closed', students: 30 });
  assert.ok(Math.abs(v.timeConstantHours - 10) < 1e-9);
  assert.ok(Math.abs(v.approachFraction - (1 - Math.exp(-1))) < 1e-12, `approach ${v.approachFraction}`);
  assert.ok(v.approachFraction < 1);
  assert.ok(v.passed);
});

test('144. approach is null when exchange or net change is zero', () => {
  const sealed = E.verifyAnalytics({ volume: 200, mechOA: 0, infiltrationACH: 0, windowMode: 'closed', students: 30 });
  assert.equal(sealed.approachFraction, null);
  assert.equal(sealed.steadyResidual, null);
  assert.equal(sealed.timeConstantHours, Infinity);
  const settled = E.verifyAnalytics({
    volume: 200, mechOA: 100, infiltrationACH: 0, windowMode: 'closed',
    students: 0, outdoorCO2: 420, co2Start: 420,
  });
  assert.equal(settled.approachFraction, null);
  assert.equal(settled.steadyResidual, null);
});

// ------------------------------------------------- finding 4: replayable
// provenance and labeled fingerprints

test('145. report scenario replays the identical report and fingerprint', () => {
  const p = {
    ...E.getPreset('standard28').params,
    volume: 100, mechOA: 100, infiltrationACH: 0, windowMode: 'closed',
    schedule: CONSTANT, co2Start: 840, pmStart: 16, stepMin: 2, sampleMin: 7,
  };
  const report = E.auditReport(p);
  assert.equal(report.modelVersion, 'ventilab-model-v2');
  for (const key of ['schedule', 'co2Start', 'pmStart', 'stepMin', 'sampleMin']) {
    assert.ok(key in report.scenario, `scenario missing ${key}`);
  }
  const replay = E.auditReport(report.scenario);
  assert.equal(replay.metrics.co2Peak, report.metrics.co2Peak);
  assert.equal(replay.metrics.pmMean, report.metrics.pmMean);
  assert.equal(replay.metrics.dose, report.metrics.dose);
  assert.equal(replay.fingerprint.fnv1a32, report.fingerprint.fnv1a32);
  assert.equal(E.canonicalJson(replay), E.canonicalJson(report));
});

test('146. fingerprint is labeled as the JSON payload identifier', async () => {
  const report = E.auditReport(E.getPreset('standard28').params);
  assert.equal(report.fingerprint.algorithm, 'FNV-1a-32');
  assert.equal(report.fingerprint.role, 'JSON report payload identifier');
  const csv = E.auditCsv(report);
  assert.ok(csv.includes('FNV-1a-32 JSON report payload identifier'));
  const payloadSha = await E.sha256Hex(`${E.canonicalJson(report)}\n`);
  const csvWithSha = E.auditCsv(report, { payloadSha256: payloadSha });
  assert.ok(csvWithSha.includes(`meta,jsonPayloadSha256,SHA-256 of the canonical JSON report payload,${payloadSha}`));
  // Without the extra the CSV is unchanged and deterministic.
  assert.equal(E.auditCsv(report), csv);
});

// ------------------------------------------------- finding 5: numeric CSV

test('147. finite numbers serialize as raw numeric CSV cells', () => {
  assert.equal(E.csvCell(-10), '-10');
  assert.equal(E.csvCell(-2.5), '-2.5');
  assert.equal(E.csvCell(0), '0');
  assert.equal(E.csvCell(1e-7), '1e-7');
  // Formula protection still guards non-numeric strings.
  assert.equal(E.csvCell('-5'), "'-5");
  assert.equal(E.csvCell('=1+1'), "'=1+1");
  assert.equal(E.csvCell('@cmd'), "'@cmd");
  const csv = E.auditCsv(E.auditReport({ ...E.getPreset('standard28').params, deltaT: -10 }));
  assert.ok(csv.includes('scenario,deltaT,value,-10,'), 'deltaT row must be numeric');
  const deltaRow = csv.split('\r\n').find((l) => /delta_(low|high),-/.test(l));
  assert.ok(deltaRow, 'expected a negative sensitivity delta row');
  assert.ok(!deltaRow.includes("'-"), `apostrophe in numeric row: ${deltaRow}`);
});

// ------------------------------------------------- cross-solver agreement

test('148. both solvers share the corrected removal rate end to end', () => {
  const p = {
    ...E.getPreset('standard28').params, mechOA: 300, merv13: true,
    crBoxes: 1, hepaUnits: 1, schedule: CONSTANT,
  };
  const analytic = E.analyticMetrics(p).metrics;
  const simulated = E.simulate(p).metrics;
  const np = E.normalizeParams(p);
  const clean = E.infectionCleanAirM3h(np, E.ventilationRates(np), E.equipment(np));
  assert.equal(analytic.ecaTotal, clean);
  assert.equal(simulated.ecaTotal, clean);
  assert.ok(Math.abs(analytic.dose - simulated.dose) / analytic.dose < 1e-6);
  assert.ok(Math.abs(analytic.dose - E.quantaIntegralAnalytic(6, p)) < 1e-9);
});

// ------------------------------------------------- finding 6: chart sampling
// is a reporting density and never perturbs the solve

test('149. a single coarse step still reports the exact continuous mean', () => {
  // Sol's probe: stepMin 60 and sampleMin 60 used to integrate in one 60 min
  // knot and report 18.75 instead of the exact 50/e integral.
  const p = {
    pmStart: 0, outdoorPM: 100, infiltrationFactor: 0.5, infiltrationACH: 1,
    durationMin: 60, mechOA: 0, windowMode: 'closed', windowOpen: 0,
    students: 0, schedule: [{ start: 0, end: 60, occupancy: 1 }], stepMin: 60,
  };
  const exact = 50 / Math.E;
  const reference = E.simulate({ ...p, sampleMin: 60 }).metrics;
  for (const sampleMin of [60, 30, 15, 5, 1]) {
    const m = E.simulate({ ...p, sampleMin }).metrics;
    for (const key of ['pmMean', 'co2Mean', 'riskFinal', 'dose', 'pmFinal', 'co2Final', 'pmPeak', 'co2Peak']) {
      assert.equal(m[key], reference[key], `${key} moved at sampleMin ${sampleMin}: ${m[key]} vs ${reference[key]}`);
    }
    assert.ok(Math.abs(m.pmMean - exact) < 1e-9, `pmMean ${m.pmMean} at sampleMin ${sampleMin}`);
  }
});

test('150. every shared output time holds the identical trajectory state', () => {
  // Denser sampling may only add reporting points; coincident output times
  // must carry identical states on any schedule.
  const p = { ...E.getPreset('standard28').params, stepMin: 5 };
  const coarse = E.simulate({ ...p, sampleMin: 30 });
  const dense = E.simulate({ ...p, sampleMin: 1 });
  const at = new Map(dense.times.map((t, i) => [t, i]));
  coarse.times.forEach((t, i) => {
    const j = at.get(t);
    assert.ok(j !== undefined, `shared output time ${t} missing`);
    assert.equal(dense.co2[j], coarse.co2[i]);
    assert.equal(dense.pm[j], coarse.pm[i]);
    assert.equal(dense.quanta[j], coarse.quanta[i]);
    assert.equal(dense.integral[j], coarse.integral[i]);
    assert.equal(dense.risk[j], coarse.risk[i]);
  });
});

test('151. approach fraction is positive when CO2 falls to equilibrium', () => {
  // Sol's probe: a 1000 ppm start decaying to 420 ppm reported -0.6321.
  const v = E.verifyAnalytics({
    volume: 100, students: 0, mechOA: 100, infiltrationACH: 0,
    windowMode: 'closed', outdoorCO2: 420, co2Start: 1000,
  });
  assert.ok(v.approachFraction > 0, `approach ${v.approachFraction}`);
  assert.ok(Math.abs(v.approachFraction - (1 - Math.exp(-1))) < 1e-12, `approach ${v.approachFraction}`);
});

test('152. sealed-room verification stays finite and passes', () => {
  // With zero air exchange the closed-form targets integrate linearly; the
  // audit must not surface NaN percentages or a false CHECK FAILED chip.
  const v = E.verifyAnalytics({
    volume: 200, students: 30, mechOA: 0, infiltrationACH: 0, windowMode: 'closed',
  });
  for (const key of ['co2RmsePpm', 'co2RmsePercent', 'pmRmseUg', 'quantaRmse', 'co2MaxErrorPpm']) {
    assert.ok(Number.isFinite(v[key]), `${key} = ${v[key]}`);
  }
  assert.equal(v.passed, true);
  assert.equal(v.approachFraction, null);
  assert.equal(v.steadyResidual, null);
});

test('153. the approach guards share one rate threshold', () => {
  // Between qExchange > EPS and co2Rate > EPS the tau and equilibrium
  // estimates disagreed: a finite tau beside an infinite equilibrium
  // collapsed the fraction to 0. The pair now reports consistently.
  const v = E.verifyAnalytics({
    volume: 5000, students: 30, mechOA: 4e-9, infiltrationACH: 0, windowMode: 'closed',
  });
  assert.equal(v.approachFraction, null);
  assert.equal(v.co2Equilibrium, Infinity);
  assert.equal(v.steadyResidual, null);
});

test('154. malformed schedule entries fall back to the default day', () => {
  // A null entry used to throw; an entry missing finite fields silently
  // NaNed the CO2 means. Malformed arrays take the default schedule whole.
  for (const schedule of [[null], [{}], [{ start: 0, end: 50, occupancy: NaN }], [42]]) {
    const r = E.simulate({ students: 5, volume: 100, durationMin: 100, schedule });
    assert.ok(Number.isFinite(r.metrics.co2Mean));
    assert.ok(Number.isFinite(r.metrics.pmMean));
  }
});

test('155. a floored refinement chain cannot certify a false pass', () => {
  // When the stability floor clamps coarse and mid to identical step
  // counts the pair carries no order information; certifying Infinity
  // order beside a nonzero fine delta passed vacuously.
  const c = E.convergenceCheck({ ...E.getPreset('standard28').params, mechOA: 5000, volume: 50 });
  assert.ok(c.worstDelta > 1e-6);
  assert.equal(c.passed, false);
  assert.ok(Number.isNaN(c.minOrder));
  const good = E.convergenceCheck(E.getPreset('standard28').params);
  assert.equal(good.passed, true);
  assert.ok(good.minOrder >= 3);
});

// ------------------------------------------------- finding 7: catastrophic
// cancellation in the analytic integrators as the exchange rate -> 0

test('156. a barely-ventilated room keeps exact means and dose at any sampleMin', () => {
  // Audit probe: 30 students in 200 m3 with windows closed, no mechanical
  // air and infiltrationACH 1.1e-9 leaves an exchange rate just above the
  // zero-rate guard, where (1 - exp(-kt)) / k cancelled to noise. The CO2
  // mean read -201342 ppm and the accumulated dose went negative at fine
  // sampling; every sample interval must now give the sealed-room answer.
  const p = {
    students: 30, volume: 200, mechOA: 0, infiltrationACH: 1.1e-9,
    windowMode: 'closed', durationMin: 60,
    schedule: [{ start: 0, end: 60, occupancy: 1 }], infectious: 1,
  };
  const values = [60, 15, 5, 1].map((sampleMin) => E.analyticMetrics({ ...p, sampleMin }).metrics);
  for (const m of values) {
    assert.ok(Math.abs(m.co2Mean - 1770) < 1e-6, `co2Mean ${m.co2Mean}`);
    assert.ok(Math.abs(m.riskFinal - 5.8235466) < 1e-6, `riskFinal ${m.riskFinal}`);
    assert.ok(m.dose > 0 && m.dose < 0.003, `dose ${m.dose}`);
  }
  for (const m of values.slice(1)) {
    assert.ok(Math.abs(m.co2Mean - values[0].co2Mean) < 1e-9);
    assert.ok(Math.abs(m.riskFinal - values[0].riskFinal) < 1e-9);
  }
  // The exact-zero limit agrees with the tiny-rate result.
  const sealed = E.analyticMetrics({ ...p, infiltrationACH: 0, sampleMin: 1 }).metrics;
  assert.ok(Math.abs(sealed.co2Mean - values[0].co2Mean) < 1e-6);
  assert.ok(Math.abs(sealed.riskFinal - values[0].riskFinal) < 1e-8);
});
