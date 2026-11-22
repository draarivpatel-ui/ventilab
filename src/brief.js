/**
 * Signed IAQ engineering brief export.
 *
 * A deterministic payload (scenario, solved metrics, retrofit comparison,
 * school-day summary, solver verification) plus a pure-JS SHA-256 integrity
 * signature over its canonical JSON. The signature is tamper evidence, not
 * a digital signature: anyone can recompute it, so any edit to the payload
 * is detected. Feeding the scenario back through the solver replays the
 * recorded numbers exactly.
 */
import {
  normalizeParams,
  analyticMetrics,
  auditReport,
  canonicalJson,
  csvCell,
  fnv1a32,
} from './engine.js';
import { sha256HexSync } from './sha256.js';
import { retrofitComparison } from './retrofit.js';
import { schoolDayReport, SCHOOL_DAY_MINUTES, CO2_THRESHOLDS } from './schoolday.js';

const BRIEF_VERSION = 1;
const METRIC_TOLERANCE = 1e-6;

/**
 * Build the unsigned brief payload. Deterministic: no timestamps, no
 * environment data, same scenario in means the same bytes out.
 */
export function engineeringBrief(input = {}) {
  const p = normalizeParams(input);
  const audit = auditReport(p);
  const comparison = retrofitComparison(p);
  const day = schoolDayReport(p, 'custom');
  const m = audit.metrics;
  return {
    briefVersion: BRIEF_VERSION,
    modelVersion: 'ventilab-model-v2',
    generator: 'VentiLab IAQ engineering brief',
    scope: 'Synthetic reference classroom. Educational estimate, not a measurement or design calculation.',
    scenario: audit.scenario,
    metrics: {
      co2Peak: m.co2Peak,
      co2Mean: m.co2Mean,
      co2Final: m.co2Final,
      pmPeak: m.pmPeak,
      pmMean: m.pmMean,
      pmFinal: m.pmFinal,
      riskFinal: m.riskFinal,
      ecaACH: m.ecaACH,
      ecaTotal: m.ecaTotal,
      oaPerPersonLps: m.oaPerPersonLps,
      cost: m.cost,
      watts: m.watts,
      dBA: m.dBA,
      energyKwh: m.energyKwh,
    },
    compliance: {
      ecaACH: m.ecaACH,
      ecaACHGuide: 5,
      ecaOk: m.ecaACH >= 5,
      co2Peak: m.co2Peak,
      co2Guide: 800,
      co2Ok: m.co2Peak < 800,
      oaPerPersonLps: m.oaPerPersonLps,
      ashraeGuide: 7,
      ashraeOk: m.oaPerPersonLps >= 7,
    },
    retrofits: comparison.rows.map((row) => ({
      id: row.id,
      name: row.name,
      ecaACH: row.ecaACH,
      steadyStateCo2: row.steadyStateCo2,
      co2Peak: row.co2Peak,
      riskReduction: row.riskReduction,
      pmClearance90Min: row.pmClearance90Min,
      verdict: row.verdict.label,
      annualCost: row.annualCost,
      riskPer100: row.riskPer100,
    })),
    schoolDay: {
      minutes: SCHOOL_DAY_MINUTES,
      startLabel: day.startLabel,
      endLabel: day.endLabel,
      above800Before: day.exceedance.before.minutes[CO2_THRESHOLDS[0]],
      above1000Before: day.exceedance.before.minutes[CO2_THRESHOLDS[1]],
      above800After: day.exceedance.after.minutes[CO2_THRESHOLDS[0]],
      above1000After: day.exceedance.after.minutes[CO2_THRESHOLDS[1]],
      co2PeakBefore: day.exceedance.before.peak,
      co2PeakAfter: day.exceedance.after.peak,
    },
    verification: audit.verification,
    costModel: {
      note: comparison.costModel.note,
      electricityPricePerKwh: comparison.costModel.electricityPricePerKwh,
      occupiedHoursPerYear: comparison.costModel.occupiedHoursPerYear,
    },
  };
}

/**
 * Attach the integrity signature: FNV-1a-32 plus pure-JS SHA-256 over the
 * canonical JSON of every payload field except the signature block itself.
 */
export function signBrief(payload) {
  const body = { ...payload };
  delete body.signature;
  const canonical = canonicalJson(body);
  return {
    ...body,
    signature: {
      algorithm: 'SHA-256',
      role: 'Tamper-evidence integrity digest, not a digital signature',
      signedFields: 'Canonical JSON of every field except this signature block',
      fnv1a32: fnv1a32(canonical),
      sha256: sha256HexSync(canonical),
    },
  };
}

/** Verify a signed brief's integrity digests. Never throws. */
export function verifyBrief(brief) {
  try {
    if (!brief || typeof brief !== 'object') return { ok: false, detail: 'Not a brief object' };
    if (brief.briefVersion !== BRIEF_VERSION) return { ok: false, detail: 'Unsupported brief version' };
    if (!brief.signature || typeof brief.signature !== 'object') return { ok: false, detail: 'Missing signature block' };
    const body = { ...brief };
    delete body.signature;
    const canonical = canonicalJson(body);
    const expectedSha = sha256HexSync(canonical);
    const expectedFnv = fnv1a32(canonical);
    const shaOk = brief.signature.sha256 === expectedSha;
    const fnvOk = brief.signature.fnv1a32 === expectedFnv;
    return {
      ok: shaOk && fnvOk,
      shaOk,
      fnvOk,
      expectedSha256: expectedSha,
      actualSha256: brief.signature.sha256,
      detail: shaOk && fnvOk
        ? 'Signature verified: payload is intact'
        : 'Signature mismatch: the payload was edited or corrupted',
    };
  } catch (err) {
    return { ok: false, detail: `Verification failed: ${err.message || err}` };
  }
}

/**
 * Replay a verified brief: rebuild the scenario from its recorded inputs,
 * re-solve the closed-form metrics and compare every recorded metric within
 * tolerance. Never throws.
 */
export function replayBrief(brief) {
  try {
    if (!brief || typeof brief !== 'object' || !brief.scenario || !brief.metrics) {
      return { ok: false, detail: 'Brief lacks a scenario or metrics', checks: [] };
    }
    const replayed = analyticMetrics(normalizeParams(brief.scenario)).metrics;
    const checks = [];
    for (const [key, recorded] of Object.entries(brief.metrics)) {
      if (!(key in replayed) || typeof recorded !== 'number') continue;
      const actual = replayed[key];
      const tol = Math.max(METRIC_TOLERANCE, Math.abs(recorded) * METRIC_TOLERANCE);
      const bothInf = !Number.isFinite(recorded) && !Number.isFinite(actual);
      const ok = bothInf || (Number.isFinite(actual) && Math.abs(actual - recorded) <= tol);
      checks.push({ key, recorded, actual, ok });
    }
    return {
      ok: checks.length > 0 && checks.every((c) => c.ok),
      checks,
      detail: checks.every((c) => c.ok)
        ? `${checks.length} recorded metrics replay exactly`
        : `${checks.filter((c) => !c.ok).length} of ${checks.length} metrics differ on replay`,
    };
  } catch (err) {
    return { ok: false, detail: `Replay failed: ${err.message || err}`, checks: [] };
  }
}

/** Formula-safe fixed-column CSV of a signed brief. */
export function briefCsv(brief) {
  const lines = ['section,item,measure,value,unit'];
  const row = (section, item, measure, value, unit = '') => {
    lines.push([section, item, measure, value, unit].map(csvCell).join(','));
  };
  row('meta', 'briefVersion', 'value', brief.briefVersion);
  row('meta', 'modelVersion', 'solver and model version', brief.modelVersion);
  row('meta', 'generator', 'value', brief.generator);
  row('meta', 'scope', 'value', brief.scope);
  for (const [k, v] of Object.entries(brief.scenario)) {
    row('scenario', k, 'value', v !== null && typeof v === 'object' ? canonicalJson(v) : v);
  }
  for (const [k, v] of Object.entries(brief.metrics)) row('metrics', k, 'value', v);
  for (const [k, v] of Object.entries(brief.compliance)) row('compliance', k, 'value', v);
  for (const r of brief.retrofits) {
    row('retrofit', r.id, 'name', r.name);
    row('retrofit', r.id, 'ecaACH', r.ecaACH, 'eACH');
    row('retrofit', r.id, 'steadyStateCo2', r.steadyStateCo2, 'ppm');
    row('retrofit', r.id, 'co2Peak', r.co2Peak, 'ppm');
    row('retrofit', r.id, 'riskReduction', r.riskReduction, '%');
    row('retrofit', r.id, 'pmClearance90Min', r.pmClearance90Min, 'min');
    row('retrofit', r.id, 'verdict', r.verdict);
    row('retrofit', r.id, 'annualCost', r.annualCost, 'USD/yr');
    row('retrofit', r.id, 'riskPer100', Number.isFinite(r.riskPer100) ? r.riskPer100 : 'infinite (free gain)');
  }
  for (const [k, v] of Object.entries(brief.schoolDay)) row('schoolDay', k, 'value', v);
  for (const [k, v] of Object.entries(brief.verification)) row('verification', k, 'value', v);
  row('signature', 'algorithm', 'value', brief.signature.algorithm);
  row('signature', 'role', 'value', brief.signature.role);
  row('signature', 'fnv1a32', 'value', brief.signature.fnv1a32);
  row('signature', 'sha256', 'value', brief.signature.sha256);
  return `${lines.join('\r\n')}\r\n`;
}

/** Markdown rendering of a signed brief for reports and submissions. */
export function briefMarkdown(brief) {
  const f = (n, digits = 1) => (Number.isFinite(n) ? n.toFixed(digits) : 'n/a');
  const lines = [
    `# VentiLab IAQ Engineering Brief`,
    ``,
    `${brief.scope}`,
    ``,
    `## Classroom`,
    ``,
    `| Input | Value |`,
    `|---|---|`,
    `| Students | ${brief.scenario.students} |`,
    `| Room volume | ${brief.scenario.volume} m3 |`,
    `| Mechanical outdoor air | ${brief.scenario.mechOA} m3/h |`,
    `| Infiltration | ${brief.scenario.infiltrationACH} ACH |`,
    `| Window mode | ${brief.scenario.windowMode} at ${Math.round(brief.scenario.windowOpen * 100)}% open |`,
    `| Devices | ${brief.scenario.crBoxes} fan boxes, ${brief.scenario.hepaUnits} HEPA, MERV-13 ${brief.scenario.merv13}, UVGI ${brief.scenario.uvgi} |`,
    ``,
    `## Solved metrics`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| CO2 peak | ${f(brief.metrics.co2Peak, 0)} ppm |`,
    `| PM2.5 mean | ${f(brief.metrics.pmMean)} ug/m3 |`,
    `| Wells-Riley risk | ${f(brief.metrics.riskFinal)}% |`,
    `| Equivalent clean airflow | ${f(brief.metrics.ecaACH)} eACH (${f(brief.metrics.ecaTotal, 0)} m3/h) |`,
    `| Outdoor air per person | ${f(brief.metrics.oaPerPersonLps)} L/s |`,
    ``,
    `## Compliance verdict`,
    ``,
    `- CDC equivalent ACH >= 5: ${brief.compliance.ecaOk ? 'PASS' : 'FAIL'} (${f(brief.compliance.ecaACH)})`,
    `- CO2 peak < 800 ppm: ${brief.compliance.co2Ok ? 'PASS' : 'FAIL'} (${f(brief.compliance.co2Peak, 0)} ppm)`,
    `- ASHRAE 62.1 classroom guide ~7 L/s per person: ${brief.compliance.ashraeOk ? 'PASS' : 'FAIL'} (${f(brief.compliance.oaPerPersonLps)} L/s)`,
    ``,
    `## Retrofit comparison`,
    ``,
    `| Scenario | eACH | Steady CO2 | Peak CO2 | Risk cut | PM 90% clear | Verdict | USD/yr | Risk cut per $100 |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...brief.retrofits.map((r) => `| ${r.name} | ${f(r.ecaACH)} | ${f(r.steadyStateCo2, 0)} | ${f(r.co2Peak, 0)} | ${f(r.riskReduction)}% | ${f(r.pmClearance90Min, 0)} min | ${r.verdict} | $${f(r.annualCost, 0)} | ${Number.isFinite(r.riskPer100) ? `${f(r.riskPer100)}%` : 'free gain'} |`),
    ``,
    `## School day (8:00 AM - 3:30 PM)`,
    ``,
    `- Minutes above 800 ppm: ${f(brief.schoolDay.above800Before, 0)} before, ${f(brief.schoolDay.above800After, 0)} after`,
    `- Minutes above 1000 ppm: ${f(brief.schoolDay.above1000Before, 0)} before, ${f(brief.schoolDay.above1000After, 0)} after`,
    `- Day peak: ${f(brief.schoolDay.co2PeakBefore, 0)} ppm before, ${f(brief.schoolDay.co2PeakAfter, 0)} ppm after`,
    ``,
    `## Integrity signature`,
    ``,
    `- Algorithm: ${brief.signature.algorithm} (${brief.signature.role})`,
    `- Signed fields: ${brief.signature.signedFields}`,
    `- FNV-1a-32: \`${brief.signature.fnv1a32}\``,
    `- SHA-256: \`${brief.signature.sha256}\``,
    ``,
    `Generated offline by VentiLab. ${brief.costModel.note}`,
  ];
  return `${lines.join('\n')}\n`;
}
