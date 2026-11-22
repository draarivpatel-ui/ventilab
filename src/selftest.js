/**
 * In-page self-test runner. A compact suite that proves the workbench's
 * core invariants live in the browser: steady-state CO2 mass-balance
 * convergence, Wells-Riley bounds and monotonicity in ACH, PM2.5
 * exponential-decay conservation, multi-period schedule conservation,
 * CSV formula escaping, brief tamper detection and the FIPS 180-4 SHA-256
 * known-answer vectors. Zero dependencies; every check runs the real
 * shipped code paths.
 */
import {
  DEFAULTS,
  normalizeParams,
  simulate,
  analyticMetrics,
  verifyAnalytics,
  wellsRileyProbability,
  ventilationRates,
  equipment,
  csvCell,
  canonicalJson,
  fnv1a32,
} from './engine.js';
import { sha256HexSync, sha256Bytes } from './sha256.js';
import { engineeringBrief, signBrief, verifyBrief, replayBrief } from './brief.js';
import { encodeRoom, decodeRoom } from './roomcodec.js';
import { co2ThresholdExceedance, SCHOOL_DAY_SCHEDULE } from './schoolday.js';
import { pmClearance90Min, retrofitComparison } from './retrofit.js';

const SHA256_KAT = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
];

function checkSha256() {
  const fails = SHA256_KAT.filter(([msg, hex]) => sha256HexSync(msg) !== hex);
  const millionA = sha256Bytes(new Uint8Array(1e6).fill(97))
    .map((b) => b.toString(16).padStart(2, '0')).join('') === 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0';
  const pass = fails.length === 0 && millionA;
  return { pass, detail: pass ? 'all FIPS 180-4 vectors match, including the 1,000,000 x "a" vector' : `${fails.length} vector(s) mismatched` };
}

function checkCo2SteadyState() {
  const v = verifyAnalytics(DEFAULTS);
  const converged = v.passed && (v.steadyResidual === null || v.steadyResidual < 0.02);
  return {
    pass: converged,
    detail: `RK4 vs closed form RMSE ${v.co2RmsePercent.toExponential(2)}%, steady residual ${v.steadyResidual === null ? 'n/a' : (v.steadyResidual * 100).toFixed(3) + '%'}`,
  };
}

function checkWellsRiley() {
  const base = { ...DEFAULTS, infectious: 1 };
  const probs = [0, 0.5, 1, 2, 8].map((dose) => wellsRileyProbability(dose, base));
  const bounded = probs.every((p) => p >= 0 && p <= 1);
  const monotonicDose = probs.every((p, i) => i === 0 || p >= probs[i - 1]);
  const risks = [50, 150, 400, 900].map((mechOA) => simulate({ ...base, mechOA }).metrics.riskFinal);
  const monotonicAch = risks.every((r, i) => i === 0 || r < risks[i - 1]);
  const pass = bounded && monotonicDose && monotonicAch;
  return {
    pass,
    detail: pass
      ? `probabilities bounded in [0,1]; risk ${risks[0].toFixed(1)}% -> ${risks[3].toFixed(1)}% as outdoor air rises`
      : 'probability bounds or ACH monotonicity violated',
  };
}

function checkPmDecay() {
  // A pulse with no ongoing outdoor source must decay exponentially at the
  // modeled first-order removal rate; the simulated 90% clearance matches
  // the closed-form ln(10)/rate within one sampling step.
  const p = normalizeParams({ ...DEFAULTS, outdoorPM: 0, pmStart: 100, durationMin: 360, stepMin: 1, sampleMin: 1 });
  const run = simulate(p);
  const idx = run.pm.findIndex((v) => v <= 10);
  const exact = pmClearance90Min(p);
  const pass = idx > 0 && Math.abs(run.times[idx] - exact) <= 1.5;
  return {
    pass,
    detail: `90% clearance at ${idx > 0 ? run.times[idx].toFixed(1) : 'n/a'} min simulated vs ${exact.toFixed(1)} min closed form`,
  };
}

function checkScheduleConservation() {
  const p = normalizeParams({ ...DEFAULTS, schedule: SCHOOL_DAY_SCHEDULE, durationMin: 450, stepMin: 1, sampleMin: 3 });
  const run = simulate(p);
  const closed = analyticMetrics(p);
  const co2Rel = Math.abs(run.metrics.co2Peak - closed.metrics.co2Peak) / closed.metrics.co2Peak;
  const pmRel = Math.abs(run.metrics.pmMean - closed.metrics.pmMean) / Math.max(1e-9, closed.metrics.pmMean);
  const massOk = run.co2.every((v) => v >= p.outdoorCO2 - 1e-6);
  const exc = co2ThresholdExceedance(p);
  const within = Object.values(exc.minutes).every((m) => m >= 0 && m <= 450);
  const pass = co2Rel < 0.01 && pmRel < 0.01 && massOk && within;
  return {
    pass,
    detail: `14-block school day: RK4 vs closed form ${(co2Rel * 100).toFixed(3)}% CO2 peak, ${(pmRel * 100).toFixed(3)}% PM mean; ${exc.minutes[800].toFixed(1)} min above 800 ppm`,
  };
}

function checkCsv() {
  const cases = [['=1+1', "'=1+1"], ['+x', "'+x"], ['-10', "'-10"], ['@cmd', "'@cmd"], ['\t=2', "'\t=2"]];
  const escaped = cases.every(([input, want]) => csvCell(input) === want);
  const numeric = csvCell(-10) === '-10' && csvCell(2.5) === '2.5';
  const quoted = csvCell('a,b') === '"a,b"' && csvCell('say "hi"') === '"say ""hi"""';
  const pass = escaped && numeric && quoted;
  return { pass, detail: pass ? 'formula prefixes neutralized, quoting doubles quotes, numbers stay numeric' : 'CSV escaping failed' };
}

function checkTamper() {
  const brief = signBrief(engineeringBrief(DEFAULTS));
  const intact = verifyBrief(brief);
  const tampered = JSON.parse(JSON.stringify(brief));
  tampered.metrics.co2Peak += 1;
  const broken = verifyBrief(tampered);
  const replay = replayBrief(brief);
  const pass = intact.ok && !broken.ok && replay.ok;
  return {
    pass,
    detail: pass
      ? `intact brief verifies (sha256 ${brief.signature.sha256.slice(0, 12)}...), +1 ppm edit detected, ${replay.checks.length} metrics replay`
      : 'tamper detection or replay failed',
  };
}

function checkRoomCodec() {
  const state = { students: 31, volume: 240, mechOA: 300, crBoxes: 2, merv13: true, retrofitId: 'school-package' };
  const round = decodeRoom(encodeRoom(state));
  const hostile = ['#room=', '#room=!!!!', '#room=AAAA', '#room=' + 'A'.repeat(5000)];
  const rejected = hostile.every((h) => decodeRoom(h).ok === false);
  const pass = round.ok && round.state.students === 31 && round.state.retrofitId === 'school-package' && rejected;
  return {
    pass,
    detail: pass ? 'bookmark round-trips all fields; malformed bodies rejected' : 'room codec failed round-trip or rejection',
  };
}

function checkComparison() {
  const cmp = retrofitComparison({ ...DEFAULTS, infectious: 1 });
  const baselineRow = cmp.rows.find((r) => r.id === 'baseline');
  const best = cmp.rows.filter((r) => !r.isBaseline).reduce((a, b) => (b.riskReduction > a.riskReduction ? b : a));
  const pass = cmp.rows.length >= 7 && baselineRow && baselineRow.riskReduction === 0 && best.riskReduction > 0;
  return {
    pass,
    detail: `${cmp.rows.length} deterministic scenarios scored; best risk cut ${best.riskReduction.toFixed(1)}% (${best.name})`,
  };
}

/**
 * Run every check. Returns an array of { id, name, pass, detail } plus a
 * summary object; a throwing check is reported as a failure, never thrown.
 */
export function selfTestSuite() {
  const defs = [
    ['sha256-kat', 'SHA-256 FIPS 180-4 known answers', checkSha256],
    ['co2-steady', 'CO2 mass-balance convergence', checkCo2SteadyState],
    ['wells-riley', 'Wells-Riley bounds and ACH monotonicity', checkWellsRiley],
    ['pm-decay', 'PM2.5 exponential-decay conservation', checkPmDecay],
    ['schedule', 'Multi-period schedule conservation', checkScheduleConservation],
    ['csv-escape', 'CSV formula-injection escaping', checkCsv],
    ['brief-integrity', 'Signed brief tamper detection', checkTamper],
    ['room-codec', 'Room bookmark codec', checkRoomCodec],
    ['comparator', 'Retrofit comparator consistency', checkComparison],
    ['canonical-json', 'Canonical JSON determinism', () => {
      const a = canonicalJson({ b: [3, { d: 1, a: 2 }], a: 'x' });
      const pass = a === '{"a":"x","b":[3,{"a":2,"d":1}]}' && fnv1a32(a).length === 8;
      return { pass, detail: pass ? 'keys sort recursively, arrays keep order, FNV-1a 8 hex digits' : 'canonical JSON mismatch' };
    }],
  ];
  const results = defs.map(([id, name, fn]) => {
    try {
      const r = fn();
      return { id, name, pass: r.pass === true, detail: r.detail || '' };
    } catch (err) {
      return { id, name, pass: false, detail: `threw: ${err.message || err}` };
    }
  });
  return {
    results,
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    ok: results.every((r) => r.pass),
  };
}
