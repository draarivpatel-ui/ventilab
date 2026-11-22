/**
 * Multi-scenario IAQ retrofit comparator.
 *
 * Compares the as-is classroom against five deterministic retrofit
 * interventions plus a "custom" row that mirrors the user's own control
 * settings. Every metric is closed-form (the same solved ODE as the main
 * workbench), every cost is a disclosed rough planning estimate, and nothing
 * touches the network.
 *
 * Cost model: annualized capital plus consumables plus fan electricity over
 * a school year. These are transparent engineering estimates for comparison,
 * not quotes and not measurements.
 */
import {
  normalizeParams,
  ventilationRates,
  equipment,
  infectionCleanAirM3h,
  analyticMetrics,
  baselineParams,
  optimizeRetrofits,
} from './engine.js';

const EPS = 1e-9;

/**
 * Disclosed annualized cost model, USD. Occupied hours: 7.5 h per school day
 * times 180 school days. Each device entry is capital amortized over a life
 * plus per-year consumables (filter media / lamps) plus electricity.
 */
export const ANNUAL_COST_MODEL = Object.freeze({
  currency: 'USD',
  electricityPricePerKwh: 0.16,
  occupiedHoursPerYear: 1350,
  devices: Object.freeze({
    crBox: Object.freeze({ capital: 85, lifeYears: 5, consumablesPerYear: 24, watts: 35 }),
    hepa: Object.freeze({ capital: 260, lifeYears: 8, consumablesPerYear: 60, watts: 55 }),
    merv13: Object.freeze({ capital: 650, lifeYears: 10, consumablesPerYear: 40, watts: 40 }),
    uvgi: Object.freeze({ capital: 900, lifeYears: 10, consumablesPerYear: 70, watts: 25 }),
  }),
  note: 'Rough single-number planning estimates for comparison only, not quotes.',
});

/**
 * The five deterministic named interventions, applied on top of the
 * as-is room (closed windows, no added devices). Baseline compares the
 * do-nothing reference. `custom` is built per call from the live controls.
 */
export const RETROFIT_SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'baseline',
    name: 'As-is classroom (no retrofit)',
    short: 'Baseline',
    overrides: Object.freeze({}),
    isBaseline: true,
    note: 'Closed windows, no added devices. The do-nothing reference row.',
  }),
  Object.freeze({
    id: 'cr-box-2',
    name: 'Corsi-Rosenthal Box x2',
    short: '2 fan boxes',
    overrides: Object.freeze({ crBoxes: 2 }),
    note: 'Two DIY fan-filter boxes, about 800 m3/h combined CADR at full rating.',
  }),
  Object.freeze({
    id: 'merv13-upgrade',
    name: 'MERV-13 HVAC upgrade',
    short: 'MERV-13',
    overrides: Object.freeze({ merv13: true }),
    note: 'Central filter upgrade: 4 eACH equivalent recirculation credit plus 55% intake PM removal.',
  }),
  Object.freeze({
    id: 'hepa-400',
    name: 'Commercial HEPA ~400 CFM',
    short: 'HEPA ~400 CFM',
    overrides: Object.freeze({ hepaUnits: 2 }),
    note: 'Two commercial HEPA units delivering about 412 CFM (700 m3/h) combined.',
  }),
  Object.freeze({
    id: 'cross-vent',
    name: 'Cross-ventilation window schedule',
    short: 'Cross breeze',
    overrides: Object.freeze({ windowMode: 'cross', windowOpen: 0.5 }),
    note: 'Windows half open with cross-flow whenever occupied. Zero hardware cost.',
  }),
  Object.freeze({
    id: 'school-package',
    name: 'Low-cost school package',
    short: 'School package',
    overrides: Object.freeze({ crBoxes: 2, windowMode: 'single', windowOpen: 0.25 }),
    note: 'Two fan boxes plus a single-sided 25% window schedule. The low-budget bundle.',
  }),
]);

export const RETROFIT_IDS = Object.freeze(RETROFIT_SCENARIOS.map((s) => s.id));

export function getRetrofitScenario(id) {
  return RETROFIT_SCENARIOS.find((s) => s.id === id) || null;
}

/**
 * Resolve a scenario id against a room: 'baseline' gives the do-nothing
 * room, 'custom' the room exactly as configured, and each named id applies
 * its deterministic overrides on top of the as-is room.
 */
export function resolveRetrofit(input = {}, id = 'custom') {
  const p = normalizeParams(input);
  if (id === 'custom') return p;
  const base = baselineParams(p);
  if (id === 'baseline') return normalizeParams(base);
  const scenario = getRetrofitScenario(id);
  if (!scenario) return p;
  return normalizeParams({ ...base, ...scenario.overrides });
}

/**
 * Annualized retrofit cost under ANNUAL_COST_MODEL. Only added devices cost;
 * window schedules and the baseline itself cost nothing.
 */
export function annualizedCost(input = {}, model = ANNUAL_COST_MODEL) {
  const p = normalizeParams(input);
  const d = model.devices;
  const energy = (watts) => (watts / 1000) * model.electricityPricePerKwh * model.occupiedHoursPerYear;
  const deviceCost = (spec, count) => (count <= 0 ? 0 : count * (spec.capital / spec.lifeYears + spec.consumablesPerYear + energy(spec.watts)));
  return (
    deviceCost(d.crBox, p.crBoxes) +
    deviceCost(d.hepa, p.hepaUnits) +
    (p.merv13 ? d.merv13.capital / d.merv13.lifeYears + d.merv13.consumablesPerYear + energy(d.merv13.watts) : 0) +
    (p.uvgi ? d.uvgi.capital / d.uvgi.lifeYears + d.uvgi.consumablesPerYear + energy(d.uvgi.watts) : 0)
  );
}

/** Minutes for an indoor PM2.5 pulse to decay 90% toward its equilibrium. */
export function pmClearance90Min(input = {}) {
  const p = normalizeParams(input);
  const vent = ventilationRates(p);
  const equip = equipment(p);
  const rate = (vent.qInfiltration + vent.qNatural + p.mechOA + equip.pmCADR) / p.volume;
  return rate > EPS ? (Math.LN10 * 60) / rate : Infinity;
}

/** Full-occupancy steady-state CO2, or Infinity when there is no exchange. */
export function steadyStateCo2(input = {}) {
  const p = normalizeParams(input);
  const vent = ventilationRates(p);
  const qExchange = vent.qNatural + p.mechOA + vent.qInfiltration;
  const rate = qExchange / p.volume;
  const source = (p.students * p.co2Generation * 1000) / p.volume;
  return rate > EPS ? p.outdoorCO2 + source / rate : Infinity;
}

/** CDC >=5 eACH and <800 ppm peak verdict for one evaluated scenario. */
export function complianceVerdict(metrics) {
  const eachOk = Number.isFinite(metrics.ecaACH) && metrics.ecaACH >= 5 - 1e-9;
  const co2Ok = Number.isFinite(metrics.co2Peak) && metrics.co2Peak < 800;
  const label = eachOk && co2Ok
    ? 'Meets CDC eACH and CO2 guides'
    : eachOk
      ? 'Meets eACH only'
      : co2Ok
        ? 'Meets CO2 guide only'
        : 'Below both guides';
  return { eachOk, co2Ok, label };
}

/**
 * Evaluate one resolved scenario against the as-is baseline risk. Returns
 * the deterministic comparator row: eACH, steady-state and peak CO2,
 * Wells-Riley risk reduction, PM2.5 90% clearance, the compliance verdict,
 * annualized cost and risk reduction per $100 per year.
 */
export function evaluateRetrofit(input = {}, baseRiskFinal) {
  const p = normalizeParams(input);
  const m = analyticMetrics(p).metrics;
  const baseRisk = Number.isFinite(baseRiskFinal) ? baseRiskFinal : analyticMetrics(baselineParams(p)).metrics.riskFinal;
  const riskReduction = baseRisk > EPS ? ((baseRisk - m.riskFinal) / baseRisk) * 100 : 0;
  const annualCost = annualizedCost(p);
  const riskPer100 = annualCost > EPS
    ? riskReduction / (annualCost / 100)
    : riskReduction > EPS ? Infinity : 0;
  return {
    params: p,
    ecaACH: m.ecaACH,
    ecaTotal: m.ecaTotal,
    steadyStateCo2: steadyStateCo2(p),
    co2Peak: m.co2Peak,
    co2Mean: m.co2Mean,
    pmMean: m.pmMean,
    pmClearance90Min: pmClearance90Min(p),
    riskFinal: m.riskFinal,
    baselineRisk: baseRisk,
    riskReduction,
    annualCost,
    riskPer100,
    upfrontCost: m.cost,
    watts: m.watts,
    dBA: m.dBA,
    oaPerPersonLps: m.oaPerPersonLps,
    verdict: complianceVerdict(m),
  };
}

/**
 * Build the full comparator: baseline plus the five named interventions plus
 * a custom row from the live controls. With a positive budget, the row set
 * also includes the exact-optimizer's best affordable pick.
 */
export function retrofitComparison(input = {}, { budget } = {}) {
  const p = normalizeParams(input);
  const baseline = resolveRetrofit(p, 'baseline');
  const baseRisk = analyticMetrics(baseline).metrics.riskFinal;
  const rowFor = (scenario, params, extra = {}) => ({
    id: scenario.id,
    name: scenario.name,
    short: scenario.short,
    note: scenario.note,
    isBaseline: scenario.isBaseline === true,
    ...evaluateRetrofit(params, baseRisk),
    ...extra,
  });
  const rows = RETROFIT_SCENARIOS.map((scenario) => rowFor(scenario, resolveRetrofit(p, scenario.id)));
  rows.push(rowFor({ id: 'custom', name: 'Custom (current controls)', short: 'Custom', note: 'The room exactly as the sliders and switches are set.' }, p));
  const limit = budget === undefined ? p.budget : budget;
  let best = null;
  if (limit > 0) {
    const opt = optimizeRetrofits(p, limit);
    if (opt.recommended) {
      best = rowFor(
        {
          id: 'best-under-budget',
          name: `Best under $${Math.round(limit)}`,
          short: 'Best under budget',
          note: `Exact optimizer pick within the cap: ${opt.recommended.params ? describeOverrides(opt.recommended.params) : opt.recommended.label}.`,
        },
        opt.recommended.params,
        { optimizerLabel: opt.recommended.label, cost: opt.recommended.cost },
      );
    }
  }
  return {
    baselineRisk: baseRisk,
    rows,
    best,
    costModel: ANNUAL_COST_MODEL,
    thresholds: { ecaACH: 5, co2Ppm: 800 },
  };
}

/** Short human-readable list of a resolved scenario's non-baseline fields. */
export function describeOverrides(params) {
  const p = normalizeParams(params);
  const parts = [];
  if (p.windowMode !== 'closed') parts.push(`${p.windowMode} windows ${Math.round(p.windowOpen * 100)}%`);
  if (p.crBoxes) parts.push(`${p.crBoxes} fan box${p.crBoxes === 1 ? '' : 'es'}`);
  if (p.hepaUnits) parts.push(`${p.hepaUnits} HEPA`);
  if (p.merv13) parts.push('MERV-13');
  if (p.uvgi) parts.push('UVGI');
  return parts.length ? parts.join(' + ') : 'no added devices';
}

/** Convenience: infection clean-air eACH for an arbitrary override set. */
export function effectiveACH(input = {}) {
  const p = normalizeParams(input);
  const vent = ventilationRates(p);
  const equip = equipment(p);
  return infectionCleanAirM3h(p, vent, equip) / p.volume;
}
