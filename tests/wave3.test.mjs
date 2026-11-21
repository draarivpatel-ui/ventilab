import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as E from '../src/engine.js';

const P = E.getPreset('standard28').params;
const TWO_OBJECTIVES = [
  { key: 'cost', direction: 'min' },
  { key: 'riskRemaining', direction: 'min' },
];

// ---------------------------------------------------------------- Pareto invariants

test('76. locked frontier counts stay exact for the standard classroom', () => {
  const opt = E.optimizeRetrofits(P);
  assert.equal(opt.all.length, 700);
  assert.equal(opt.affordable.length, 259);
  assert.equal(opt.frontier.length, 246);
});

test('77. locked all-config and two-objective frontier counts stay exact', () => {
  const opt = E.optimizeRetrofits(P);
  assert.equal(E.paretoFrontier(opt.all).length, 661);
  assert.equal(E.paretoFrontier(opt.affordable, TWO_OBJECTIVES).length, 9);
});

// ---------------------------------------------------------------- sensitivity shape

test('78. sensitivity analysis covers four inputs in a fixed order', () => {
  const s = E.sensitivityAnalysis(P);
  assert.deepEqual(s.parameters.map((p) => p.id), ['ach', 'occupancy', 'infiltration', 'cadr']);
  assert.deepEqual(s.outputs.map((o) => o.id), ['co2Peak', 'pmMean', 'energyKwh', 'riskFinal']);
  assert.equal(s.fraction, 0.2);
});

test('79. sensitivity analysis is fully deterministic', () => {
  assert.deepEqual(E.sensitivityAnalysis(P), E.sensitivityAnalysis(P));
  assert.deepEqual(
    E.sensitivityAnalysis(E.getPreset('wildfire-smoke').params),
    E.sensitivityAnalysis(E.getPreset('wildfire-smoke').params),
  );
});

test('80. perturbed input values are exactly base times 0.8 and 1.2', () => {
  const s = E.sensitivityAnalysis(P);
  const ach = s.parameters.find((p) => p.id === 'ach');
  const occ = s.parameters.find((p) => p.id === 'occupancy');
  const inf = s.parameters.find((p) => p.id === 'infiltration');
  const cadr = s.parameters.find((p) => p.id === 'cadr');
  assert.equal(ach.lowValue, 144);
  assert.equal(ach.highValue, 216);
  assert.ok(Math.abs(occ.lowValue - 22.4) < 1e-12);
  assert.ok(Math.abs(occ.highValue - 33.6) < 1e-12);
  assert.ok(Math.abs(inf.lowValue - 0.28) < 1e-12);
  assert.ok(Math.abs(inf.highValue - 0.42) < 1e-12);
  assert.ok(Math.abs(cadr.lowValue - 0.8) < 1e-12);
  assert.ok(Math.abs(cadr.highValue - 1.2) < 1e-12);
});

test('81. every perturbed effect equals a direct closed-form solve', () => {
  const p = E.normalizeParams(P);
  const s = E.sensitivityAnalysis(p);
  for (const def of E.SENSITIVITY_PARAMETERS) {
    const lowM = E.analyticMetrics(def.apply(p, 0.8)).metrics;
    const highM = E.analyticMetrics(def.apply(p, 1.2)).metrics;
    const got = s.parameters.find((param) => param.id === def.id);
    for (const o of E.SENSITIVITY_OUTPUTS) {
      assert.equal(got.effects[o.id].low, o.get(lowM), `${def.id}.${o.id}.low`);
      assert.equal(got.effects[o.id].high, o.get(highM), `${def.id}.${o.id}.high`);
      assert.equal(got.effects[o.id].deltaLow, o.get(lowM) - o.get(E.analyticMetrics(p).metrics));
      assert.equal(got.effects[o.id].deltaHigh, o.get(highM) - o.get(E.analyticMetrics(p).metrics));
    }
  }
});

test('82. sensitivity baseline equals the scenario closed-form metrics', () => {
  const s = E.sensitivityAnalysis(P);
  const m = E.analyticMetrics(P).metrics;
  for (const o of s.outputs) {
    const def = E.SENSITIVITY_OUTPUTS.find((d) => d.id === o.id);
    assert.equal(o.baseline, def.get(m), o.id);
  }
});

test('83. custom and extreme fractions are respected and clamped', () => {
  const s = E.sensitivityAnalysis(P, { fraction: 0.1 });
  assert.equal(s.fraction, 0.1);
  const ach = s.parameters.find((p) => p.id === 'ach');
  assert.ok(Math.abs(ach.lowValue - 162) < 1e-9);
  assert.ok(Math.abs(ach.highValue - 198) < 1e-9);
  assert.equal(E.sensitivityAnalysis(P, { fraction: 9 }).fraction, 0.95);
  assert.equal(E.sensitivityAnalysis(P, { fraction: -2 }).fraction, 0);
  assert.equal(E.sensitivityAnalysis(P, { fraction: NaN }).fraction, 0.2);
});

test('84. sensitivity never mutates the caller parameter object', () => {
  const p = { ...P };
  const snapshot = JSON.stringify(p);
  E.sensitivityAnalysis(p);
  assert.equal(JSON.stringify(p), snapshot);
});

// -------------------------------------------------------- sensitivity monotonicity

test('85. mechanical outdoor air trades CO2 against PM2.5 on the standard room', () => {
  const ach = E.sensitivityAnalysis(P).parameters.find((p) => p.id === 'ach');
  assert.ok(ach.effects.co2Peak.deltaLow > 0, 'less outdoor air raises the CO2 peak');
  assert.ok(ach.effects.co2Peak.deltaHigh < 0, 'more outdoor air lowers the CO2 peak');
  // The stock filter strips only 8 percent of incoming particles, so extra
  // mechanical air is a net particle source in this scenario.
  assert.ok(ach.effects.pmMean.deltaLow < 0);
  assert.ok(ach.effects.pmMean.deltaHigh > 0);
});

test('86. mechanical outdoor air lowers Wells-Riley risk monotonically', () => {
  const ach = E.sensitivityAnalysis(P).parameters.find((p) => p.id === 'ach');
  assert.ok(ach.effects.riskFinal.deltaLow > 0);
  assert.ok(ach.effects.riskFinal.deltaHigh < 0);
});

test('87. mechanical outdoor air raises conditioning energy monotonically', () => {
  const ach = E.sensitivityAnalysis(P).parameters.find((p) => p.id === 'ach');
  assert.ok(ach.effects.energyKwh.deltaLow < 0);
  assert.ok(ach.effects.energyKwh.deltaHigh > 0);
});

test('88. occupancy moves only the CO2 peak, nothing else', () => {
  const occ = E.sensitivityAnalysis(P).parameters.find((p) => p.id === 'occupancy');
  assert.ok(occ.effects.co2Peak.deltaLow < 0);
  assert.ok(occ.effects.co2Peak.deltaHigh > 0);
  // Quanta dose is per unit source, so headcount cannot change modeled risk,
  // and occupancy is not an energy or particle term in this model.
  assert.equal(occ.effects.pmMean.deltaLow, 0);
  assert.equal(occ.effects.pmMean.deltaHigh, 0);
  assert.equal(occ.effects.energyKwh.deltaLow, 0);
  assert.equal(occ.effects.energyKwh.deltaHigh, 0);
  assert.equal(occ.effects.riskFinal.deltaLow, 0);
  assert.equal(occ.effects.riskFinal.deltaHigh, 0);
});

test('89. infiltration dilutes CO2 and risk while raising energy use', () => {
  const inf = E.sensitivityAnalysis(P).parameters.find((p) => p.id === 'infiltration');
  assert.ok(inf.effects.co2Peak.deltaLow > 0);
  assert.ok(inf.effects.co2Peak.deltaHigh < 0);
  assert.ok(inf.effects.riskFinal.deltaLow > 0);
  assert.ok(inf.effects.riskFinal.deltaHigh < 0);
  assert.ok(inf.effects.energyKwh.deltaLow < 0);
  assert.ok(inf.effects.energyKwh.deltaHigh > 0);
});

test('90. infiltration dilutes indoor PM2.5 in both clean and smoky outdoor air', () => {
  for (const presetId of ['standard28', 'wildfire-smoke']) {
    const inf = E.sensitivityAnalysis(E.getPreset(presetId).params).parameters.find((p) => p.id === 'infiltration');
    assert.ok(inf.effects.pmMean.deltaLow > 0, presetId);
    assert.ok(inf.effects.pmMean.deltaHigh < 0, presetId);
  }
});

test('91. device CADR never touches CO2 or energy but clears PM2.5 and risk', () => {
  const dev = { ...P, hepaUnits: 2, crBoxes: 1, merv13: true };
  const cadr = E.sensitivityAnalysis(dev).parameters.find((p) => p.id === 'cadr');
  assert.equal(cadr.effects.co2Peak.deltaLow, 0);
  assert.equal(cadr.effects.co2Peak.deltaHigh, 0);
  assert.equal(cadr.effects.energyKwh.deltaLow, 0);
  assert.equal(cadr.effects.energyKwh.deltaHigh, 0);
  assert.ok(cadr.effects.pmMean.deltaLow > 0);
  assert.ok(cadr.effects.pmMean.deltaHigh < 0);
  assert.ok(cadr.effects.riskFinal.deltaLow > 0);
  assert.ok(cadr.effects.riskFinal.deltaHigh < 0);
});

test('92. a classroom with no devices shows a zero-width CADR bar', () => {
  const cadr = E.sensitivityAnalysis(P).parameters.find((p) => p.id === 'cadr');
  for (const o of E.SENSITIVITY_OUTPUTS) {
    assert.equal(cadr.effects[o.id].deltaLow, 0, o.id);
    assert.equal(cadr.effects[o.id].deltaHigh, 0, o.id);
  }
});

test('93. perturbing a zero-valued input produces exactly zero deltas', () => {
  // The rural preset has no mechanical outdoor air, so 0 times 0.8 is 0.
  const ach = E.sensitivityAnalysis(E.getPreset('rural-natural').params).parameters.find((p) => p.id === 'ach');
  assert.equal(ach.lowValue, 0);
  assert.equal(ach.highValue, 0);
  for (const o of E.SENSITIVITY_OUTPUTS) {
    assert.equal(ach.effects[o.id].deltaLow, 0, o.id);
    assert.equal(ach.effects[o.id].deltaHigh, 0, o.id);
  }
});

test('94. every parameter-output pair is monotone across the 0.8 to 1.2 sweep', () => {
  for (const preset of E.PRESETS) {
    const s = E.sensitivityAnalysis(preset.params);
    for (const param of s.parameters) {
      for (const o of s.outputs) {
        const e = param.effects[o.id];
        const up = e.high >= o.baseline - 1e-9 && o.baseline >= e.low - 1e-9;
        const down = e.high <= o.baseline + 1e-9 && o.baseline <= e.low + 1e-9;
        assert.ok(up || down, `${preset.id} ${param.id} ${o.id}: ${e.low} ${o.baseline} ${e.high}`);
      }
    }
  }
});

test('95. tornado order sorts by largest absolute effect, ties keep input order', () => {
  const s = E.sensitivityAnalysis(P);
  for (const o of s.outputs) {
    const order = s.tornadoOrder[o.id];
    assert.deepEqual([...order].sort(), ['ach', 'cadr', 'infiltration', 'occupancy'].sort());
    const byId = Object.fromEntries(s.parameters.map((p) => [p.id, p]));
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(
        byId[order[i - 1]].effects[o.id].maxDelta >= byId[order[i]].effects[o.id].maxDelta - 1e-12,
        `${o.id} order`,
      );
    }
  }
});

test('96. occupancy leads the CO2 tornado, airflow leads the energy tornado', () => {
  const s = E.sensitivityAnalysis(P);
  assert.equal(s.tornadoOrder.co2Peak[0], 'occupancy');
  assert.equal(s.tornadoOrder.energyKwh[0], 'ach');
  assert.ok(s.tornadoOrder.energyKwh.indexOf('occupancy') > s.tornadoOrder.energyKwh.indexOf('ach'));
});

// ---------------------------------------------------------------- energy metrics

test('97. energy metrics exist on both solver paths and agree', () => {
  for (const preset of E.PRESETS) {
    const a = E.analyticMetrics(preset.params).metrics;
    const s = E.simulate(preset.params).metrics;
    assert.equal(a.energyKwh, s.energyKwh, preset.id);
    assert.equal(a.conditioningKW, s.conditioningKW, preset.id);
  }
});

test('98. daily energy decomposes exactly into conditioning plus device watts', () => {
  const m = E.analyticMetrics(P).metrics;
  const hours = E.normalizeParams(P).durationMin / 60;
  assert.ok(Math.abs(m.energyKwh - (m.conditioningKW + m.watts / 1000) * hours) < 1e-12);
});

test('99. conditioning load follows q times rho times cp times absolute deltaT', () => {
  const p = E.normalizeParams(P);
  const vent = E.ventilationRates(p);
  const q = vent.qNatural + p.mechOA + vent.qInfiltration;
  const m = E.analyticMetrics(p).metrics;
  assert.ok(Math.abs(m.conditioningKW - (q * 1.2 * 1.006 * Math.abs(p.deltaT)) / 3600) < 1e-12);
});

test('100. conditioning load is linear in temperature difference and symmetric', () => {
  const a = E.analyticMetrics({ ...P, deltaT: 4 }).metrics.conditioningKW;
  const b = E.analyticMetrics({ ...P, deltaT: 8 }).metrics.conditioningKW;
  const c = E.analyticMetrics({ ...P, deltaT: -8 }).metrics.conditioningKW;
  assert.ok(Math.abs(b - 2 * a) < 1e-12);
  assert.equal(b, c);
});

test('101. zero temperature gap with no devices means zero energy', () => {
  const m = E.analyticMetrics({ ...P, deltaT: 0, crBoxes: 0, hepaUnits: 0, merv13: false, uvgi: false }).metrics;
  assert.equal(m.conditioningKW, 0);
  assert.equal(m.energyKwh, 0);
});

test('102. device watts add to daily energy even with zero temperature gap', () => {
  const m = E.analyticMetrics({ ...P, deltaT: 0, hepaUnits: 2 }).metrics;
  assert.equal(m.conditioningKW, 0);
  assert.ok(Math.abs(m.energyKwh - (2 * 55 / 1000) * 6) < 1e-12);
});

test('103. conditioning load scales with total outdoor exchange', () => {
  const q1 = E.analyticMetrics({ ...P, mechOA: 180 }).metrics.conditioningKW;
  const q2 = E.analyticMetrics({ ...P, mechOA: 360 }).metrics.conditioningKW;
  const vent1 = E.ventilationRates(E.normalizeParams({ ...P, mechOA: 180 }));
  const vent2 = E.ventilationRates(E.normalizeParams({ ...P, mechOA: 360 }));
  const r1 = 180 + vent1.qInfiltration + vent1.qNatural;
  const r2 = 360 + vent2.qInfiltration + vent2.qNatural;
  assert.ok(Math.abs(q2 / q1 - r2 / r1) < 1e-9);
});

// ---------------------------------------------------------------- cadrScale param

test('104. cadrScale normalizes into range and defaults to one', () => {
  assert.equal(E.normalizeParams({}).cadrScale, 1);
  assert.equal(E.normalizeParams({ cadrScale: -3 }).cadrScale, 0);
  assert.equal(E.normalizeParams({ cadrScale: 99 }).cadrScale, 10);
  assert.equal(E.normalizeParams({ cadrScale: NaN }).cadrScale, 1);
});

test('105. cadrScale scales every engineered CADR term but never price or noise', () => {
  const base = E.equipment({ crBoxes: 2, hepaUnits: 1, merv13: true, uvgi: true, volume: 200 });
  const half = E.equipment({ crBoxes: 2, hepaUnits: 1, merv13: true, uvgi: true, volume: 200, cadrScale: 0.5 });
  assert.equal(half.crCADR, base.crCADR / 2);
  assert.equal(half.hepaCADR, base.hepaCADR / 2);
  assert.equal(half.mervCADR, base.mervCADR / 2);
  assert.equal(half.uvgiCADR, base.uvgiCADR / 2);
  assert.equal(half.quantaCADR, base.quantaCADR / 2);
  assert.equal(half.cost, base.cost);
  assert.equal(half.watts, base.watts);
  assert.equal(half.dBA, base.dBA);
  assert.equal(half.oaFilterEfficiency, base.oaFilterEfficiency);
});

test('106. cadrScale of zero removes device benefit entirely', () => {
  const p = { ...P, hepaUnits: 3, crBoxes: 2 };
  const none = E.simulate({ ...p, cadrScale: 0 }).metrics;
  const bare = E.simulate({ ...P }).metrics;
  assert.ok(Math.abs(none.riskFinal - bare.riskFinal) < 1e-9);
  assert.ok(Math.abs(none.pmMean - bare.pmMean) < 1e-9);
});

test('107. doubling delivered CADR keeps CO2 and cost fixed while cutting risk', () => {
  const p = { ...P, hepaUnits: 2, infectious: 1 };
  const a = E.simulate({ ...p, cadrScale: 1 }).metrics;
  const b = E.simulate({ ...p, cadrScale: 2 }).metrics;
  assert.equal(a.co2Peak, b.co2Peak);
  assert.equal(a.cost, b.cost);
  assert.ok(b.riskFinal < a.riskFinal);
  assert.ok(b.pmMean < a.pmMean);
});

// ---------------------------------------------------------------- fingerprints

test('108. fnv1a32 matches the published FNV-1a test vectors', () => {
  assert.equal(E.fnv1a32(''), '811c9dc5');
  assert.equal(E.fnv1a32('a'), 'e40c292c');
  assert.equal(E.fnv1a32('foobar'), 'bf9cf968');
});

test('109. fnv1a32 hashes UTF-8 bytes and is deterministic', () => {
  assert.match(E.fnv1a32('caf\u00e9 \u2603'), /^[0-9a-f]{8}$/);
  assert.equal(E.fnv1a32('caf\u00e9 \u2603'), E.fnv1a32('caf\u00e9 \u2603'));
  assert.notEqual(E.fnv1a32('caf\u00e9'), E.fnv1a32('cafe'));
});

test('110. canonicalJson sorts keys recursively and keeps array order', () => {
  assert.equal(
    E.canonicalJson({ b: 1, a: { d: [3, 1, 2], c: 2 } }),
    '{"a":{"c":2,"d":[3,1,2]},"b":1}',
  );
  assert.equal(E.canonicalJson({ x: 1, y: 2 }), E.canonicalJson({ y: 2, x: 1 }));
});

test('111. canonicalJson serializes non-finite numbers as null and skips unsupported keys', () => {
  assert.equal(E.canonicalJson({ a: Infinity, b: -Infinity, c: NaN }), '{"a":null,"b":null,"c":null}');
  // Same contract as JSON.stringify: function and undefined values disappear
  // from objects but become null inside arrays.
  assert.equal(E.canonicalJson({ d: () => 1, e: undefined, f: 1 }), '{"f":1}');
  assert.equal(E.canonicalJson([NaN, undefined, () => 2, 1]), '[null,null,null,1]');
});

test('112. sha256Hex matches node crypto and returns 64 hex chars', async () => {
  const text = 'ventilab audit body';
  const expected = createHash('sha256').update(text, 'utf8').digest('hex');
  assert.equal(await E.sha256Hex(text), expected);
  assert.equal(await E.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.match(await E.sha256Hex(''), /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------- audit report

test('113. the audit report is byte-identical across builds', () => {
  const a = E.canonicalJson(E.auditReport(P));
  const b = E.canonicalJson(E.auditReport(P));
  assert.equal(a, b);
  assert.deepEqual(JSON.parse(a), JSON.parse(b));
});

test('114. the report fingerprint recomputes exactly from its body', () => {
  const report = E.auditReport(P);
  const { fingerprint, ...body } = report;
  assert.equal(fingerprint.fnv1a32, E.fnv1a32(E.canonicalJson(body)));
  assert.match(fingerprint.fnv1a32, /^[0-9a-f]{8}$/);
});

test('115. changing any scenario input changes the fingerprint', () => {
  const a = E.auditReport(P).fingerprint.fnv1a32;
  assert.notEqual(E.auditReport({ ...P, students: 29 }).fingerprint.fnv1a32, a);
  assert.notEqual(E.auditReport({ ...P, mechOA: 200 }).fingerprint.fnv1a32, a);
  assert.notEqual(E.auditReport({ ...P, hepaUnits: 1 }).fingerprint.fnv1a32, a);
  const fingerprints = new Set(E.PRESETS.map((pr) => E.auditReport(pr.params).fingerprint.fnv1a32));
  assert.equal(fingerprints.size, E.PRESETS.length);
});

test('116. report scenario, metrics and baseline match the engine exactly', () => {
  const report = E.auditReport(P);
  const p = E.normalizeParams(P);
  const m = E.analyticMetrics(p).metrics;
  const base = E.analyticMetrics(E.baselineParams(p)).metrics;
  assert.equal(report.scenario.students, p.students);
  assert.equal(report.scenario.infiltrationACH, p.infiltrationACH);
  assert.equal(report.scenario.cadrScale, 1);
  for (const k of Object.keys(report.metrics)) assert.equal(report.metrics[k], m[k], k);
  assert.equal(report.baseline.riskFinal, base.riskFinal);
  assert.equal(report.baseline.co2Peak, base.co2Peak);
});

test('117. report optimization summary matches the live optimizer', () => {
  const report = E.auditReport(P);
  const opt = E.optimizeRetrofits(P);
  assert.equal(report.optimization.totalOptions, 700);
  assert.equal(report.optimization.affordableOptions, 259);
  assert.equal(report.optimization.frontierOptions, 246);
  assert.equal(report.optimization.recommended, opt.recommended.label);
  assert.equal(report.optimization.cheapest, opt.cheapest.label);
  assert.equal(report.optimization.recommendedDetail.riskRemaining, opt.recommended.riskRemaining);
});

test('118. report sensitivity section mirrors the analyzer output', () => {
  const report = E.auditReport(P);
  const sens = E.sensitivityAnalysis(P);
  assert.equal(report.sensitivity.fraction, sens.fraction);
  assert.equal(report.sensitivity.parameters.length, 4);
  for (const param of report.sensitivity.parameters) {
    const src = sens.parameters.find((x) => x.id === param.id);
    assert.equal(param.baseValue, src.baseValue);
    for (const o of E.SENSITIVITY_OUTPUTS) {
      assert.equal(param.effects[o.id].deltaLow, src.effects[o.id].deltaLow, `${param.id}.${o.id}`);
    }
  }
});

test('119. report verification carries the solver proof numbers', () => {
  const report = E.auditReport(P);
  const v = E.verifyAnalytics(P);
  const c = E.convergenceCheck(P);
  assert.equal(report.verification.co2RmsePercent, v.co2RmsePercent);
  assert.equal(report.verification.rk4MinOrder, c.minOrder);
  assert.equal(report.verification.passed, v.passed && c.passed);
  assert.ok(report.verification.passed);
});

test('120. the report contains no timestamps or environment data', () => {
  const report = E.auditReport(P);
  const text = E.canonicalJson(report);
  assert.ok(!/timestamp|generatedAt|"date"|"time"|now\(/i.test(text));
  assert.equal(typeof report.fingerprint.fnv1a32, 'string');
});

// ---------------------------------------------------------------- audit CSV

test('121. auditCsv is deterministic and CRLF terminated', () => {
  const report = E.auditReport(P);
  const a = E.auditCsv(report);
  assert.equal(a, E.auditCsv(report));
  assert.ok(a.endsWith('\r\n'));
  for (const part of a.split('\r\n')) {
    assert.ok(!part.includes('\n') && !part.includes('\r'), 'bare newline inside a row');
  }
});

test('122. auditCsv has the fixed five-column header and exact section counts', () => {
  const csv = E.auditCsv(E.auditReport(P));
  const lines = csv.split('\r\n').filter((l) => l.length);
  assert.equal(lines[0], 'section,item,measure,value,unit');
  const count = (sec) => lines.filter((l) => l.startsWith(`${sec},`)).length;
  assert.equal(count('meta'), 5);
  assert.equal(count('scenario'), 29);
  assert.equal(count('metrics'), 22);
  assert.equal(count('baseline'), 3);
  assert.equal(count('sensitivity'), 76);
  assert.equal(count('optimization'), 14);
  assert.equal(count('verification'), 12);
  assert.equal(lines.length, 162);
});

test('123. auditCsv embeds the report fingerprint verbatim', () => {
  const report = E.auditReport(P);
  const csv = E.auditCsv(report);
  assert.ok(csv.includes(report.fingerprint.fnv1a32));
  const fpLine = csv.split('\r\n').find((l) => l.startsWith('meta,fingerprint'));
  assert.ok(fpLine.endsWith(`,${report.fingerprint.fnv1a32},`));
});

test('124. csvCell prefixes every spreadsheet formula prefix', () => {
  assert.equal(E.csvCell('=1+1'), "'=1+1");
  assert.equal(E.csvCell('-5'), "'-5");
  assert.equal(E.csvCell('+5'), "'+5");
  assert.equal(E.csvCell('@cmd'), "'@cmd");
  assert.equal(E.csvCell('\tcmd'), "'\tcmd");
  assert.equal(E.csvCell('safe'), 'safe');
  assert.equal(E.csvCell(42), '42');
  assert.equal(E.csvCell(null), '');
  assert.equal(E.csvCell(undefined), '');
});

test('125. csvCell quotes commas and doubles embedded quotes', () => {
  assert.equal(E.csvCell('a,b'), '"a,b"');
  assert.equal(E.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(E.csvCell('=x,y'), '"\'=x,y"');
});

test('126. no audit CSV cell can begin a spreadsheet formula', () => {
  const csv = E.auditCsv(E.auditReport(P));
  const rows = csv.trimEnd().split('\r\n').slice(1);
  const cellAt = (line, i) => {
    // Minimal parser for quoted and unquoted cells.
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j];
      if (quoted) {
        if (ch === '"' && line[j + 1] === '"') { cur += '"'; j += 1; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells[i];
  };
  // Finite numbers serialize as raw numeric cells, so a leading minus on a
  // real number is legitimate. Formula escaping protects text cells only.
  const NUMERIC_CELL = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
  for (const line of rows) {
    for (let i = 0; i < 5; i += 1) {
      const cell = cellAt(line, i);
      if (!NUMERIC_CELL.test(cell)) {
        assert.ok(!/^[=+\-@\t\r]/.test(cell), `formula-unsafe cell ${cell} in ${line}`);
      }
    }
    const cells = [0, 1, 2, 3, 4].map((i) => cellAt(line, i));
    assert.equal(cells.length, 5);
  }
});

test('127. CSV sensitivity rows carry exact signed deltas with units', () => {
  const report = E.auditReport(P);
  const sens = E.sensitivityAnalysis(P);
  const csv = E.auditCsv(report);
  for (const param of sens.parameters) {
    for (const o of E.SENSITIVITY_OUTPUTS) {
      const e = param.effects[o.id];
      const tag = `sensitivity,${param.id}>${o.id}`;
      assert.ok(csv.includes(`${tag},delta_low,${E.csvCell(e.deltaLow)}`), `${tag} low`);
      assert.ok(csv.includes(`${tag},delta_high,${E.csvCell(e.deltaHigh)}`), `${tag} high`);
    }
  }
});

// --------------------------------------------------------- conservation invariants

test('128. a sealed room conserves PM2.5 and CO2 while quanta accumulates at 1/V', () => {
  const sealed = {
    ...P, mechOA: 0, infiltrationACH: 0, windowMode: 'closed', windowOpen: 0,
    crBoxes: 0, hepaUnits: 0, merv13: false, uvgi: false, pmStart: 40, students: 0, co2Start: 500,
  };
  const run = E.simulate(sealed);
  assert.ok(run.pm.every((v) => Math.abs(v - 40) < 1e-9));
  assert.ok(run.co2.every((v) => Math.abs(v - 500) < 1e-9));
  // With zero removal the unit-source concentration integrates to exactly t/V.
  assert.ok(Math.abs(run.quanta.at(-1) - 6 / sealed.volume) < 1e-9);
  assert.ok(Math.abs(run.integral.at(-1) - (6 * 6) / (2 * sealed.volume)) < 1e-9);
});

test('129. CO2 converges monotonically toward the analytic equilibrium', () => {
  const p = { ...P, schedule: [{ start: 0, end: 1440, label: 'Constant', occupancy: 1 }], durationMin: 1440, sampleMin: 30 };
  const run = E.simulate(p);
  const eq = E.verifyAnalytics(p).co2Equilibrium;
  let prev = Infinity;
  for (const c of run.co2.slice(3)) {
    const d = Math.abs(c - eq);
    assert.ok(d <= prev + 1e-9, `${d} > ${prev}`);
    prev = d;
  }
});

test('130. integrated dose equals the closed form under a constant schedule', () => {
  const p = { ...P, schedule: [{ start: 0, end: 1440, label: 'Constant', occupancy: 1 }] };
  const a = E.analyticMetrics(p).metrics.dose;
  const expected = E.quantaIntegralAnalytic(6, p);
  assert.ok(Math.abs(a - expected) < 1e-9);
  const s = E.simulate(p);
  assert.ok(Math.abs(s.metrics.dose - expected) / expected < 1e-6);
});

test('131. normalizeParams is idempotent on every preset', () => {
  for (const preset of E.PRESETS) {
    const once = E.normalizeParams(preset.params);
    assert.deepEqual(E.normalizeParams(once), once, preset.id);
  }
  const custom = E.normalizeParams({ ...P, cadrScale: 0.85, students: 22.4 });
  assert.deepEqual(E.normalizeParams(custom), custom);
});

test('132. tighter budgets never enlarge the affordable set', () => {
  const labelsAt = (b) => new Set(E.optimizeRetrofits(P, b).affordable.map((s) => s.label));
  const zero = labelsAt(0);
  const mid = labelsAt(600);
  const full = labelsAt(1200);
  for (const l of zero) assert.ok(mid.has(l));
  for (const l of mid) assert.ok(full.has(l));
  assert.equal(E.optimizeRetrofits(P, 0).all.length, 700);
});

test('133. the CO2 time constant equals volume over total exchange', () => {
  for (const mechOA of [0, 180, 600]) {
    const p = { ...P, mechOA };
    const vent = E.ventilationRates(E.normalizeParams(p));
    const q = vent.qNatural + mechOA + vent.qInfiltration;
    assert.ok(Math.abs(E.verifyAnalytics(p).timeConstantHours - p.volume / q) < 1e-12, `mechOA ${mechOA}`);
  }
  // With only infiltration, tau collapses to the inverse ACH for any volume.
  const t210 = E.verifyAnalytics({ ...P, mechOA: 0, volume: 210 }).timeConstantHours;
  const t420 = E.verifyAnalytics({ ...P, mechOA: 0, volume: 420 }).timeConstantHours;
  assert.ok(Math.abs(t210 - t420) < 1e-12);
  assert.ok(Math.abs(t210 - 1 / P.infiltrationACH) < 1e-9);
});

test('134. sensitivity outputs stay finite on every preset', () => {
  for (const preset of E.PRESETS) {
    const s = E.sensitivityAnalysis(preset.params);
    for (const param of s.parameters) {
      for (const o of s.outputs) {
        assert.ok(Number.isFinite(param.effects[o.id].low), `${preset.id} ${param.id} ${o.id}`);
        assert.ok(Number.isFinite(param.effects[o.id].high), `${preset.id} ${param.id} ${o.id}`);
        assert.ok(param.effects[o.id].low >= 0 && param.effects[o.id].high >= 0, `${preset.id} ${param.id} ${o.id}`);
      }
    }
  }
});

test('135. perturbed extreme classrooms stay bounded and nonnegative', () => {
  const p = {
    ...P, students: 60, mechOA: 1200, infiltrationACH: 2, cadrScale: 1.5,
    crBoxes: 4, hepaUnits: 4, merv13: true, uvgi: true, outdoorPM: 200, deltaT: 20,
  };
  const run = E.simulate(p);
  for (const key of ['co2', 'pm', 'integral', 'risk']) {
    assert.ok(run[key].every((v) => Number.isFinite(v) && v >= 0), key);
  }
  assert.ok(run.metrics.riskFinal <= 100);
  const m = run.metrics;
  assert.ok(m.conditioningKW > 0 && Number.isFinite(m.energyKwh));
});

test('136. device-only interventions leave the CO2 trajectory untouched', () => {
  for (const cadrScale of [0.5, 1, 1.5]) {
    const run = E.simulate({ ...P, hepaUnits: 2, cadrScale });
    const base = E.simulate(P);
    assert.deepEqual(run.co2, base.co2, `cadrScale ${cadrScale}`);
  }
});

test('137. audit report and CSV succeed on every preset', () => {
  for (const preset of E.PRESETS) {
    const report = E.auditReport(preset.params);
    assert.match(report.fingerprint.fnv1a32, /^[0-9a-f]{8}$/, preset.id);
    assert.ok(report.verification.passed, preset.id);
    const csv = E.auditCsv(report);
    assert.ok(csv.includes(report.fingerprint.fnv1a32), preset.id);
    assert.ok(E.canonicalJson(report).length > 500, preset.id);
  }
});

test('138. audit CSV round-trips the reported metric values', () => {
  const report = E.auditReport(P);
  const csv = E.auditCsv(report);
  for (const [k, v] of Object.entries(report.metrics)) {
    assert.ok(csv.includes(`metrics,${k},value,${E.csvCell(v)}`), k);
  }
  for (const [k, v] of Object.entries(report.scenario)) {
    const cell = v !== null && typeof v === 'object' ? E.canonicalJson(v) : v;
    assert.ok(csv.includes(`scenario,${k},value,${E.csvCell(cell)}`), k);
  }
});
