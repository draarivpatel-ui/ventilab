/**
 * VentiLab physics engine.
 *
 * Pure ES module, no dependencies, no browser APIs. All public functions are
 * deterministic for a given parameter object. Volumes are in m3, airflow in
 * m3/h, CO2 in ppm, PM2.5 in ug/m3, time in minutes unless noted otherwise.
 *
 * Modelling scope: these are simplified teaching models of a reference
 * classroom. They are not design calculations and are not measurements from
 * any real building.
 */

export const DEFAULT_SCHEDULE = Object.freeze([
  { start: 0, end: 50, label: 'Period 1', occupancy: 1 },
  { start: 50, end: 60, label: 'Break', occupancy: 0.25 },
  { start: 60, end: 110, label: 'Period 2', occupancy: 1 },
  { start: 110, end: 125, label: 'Recess', occupancy: 0.1 },
  { start: 125, end: 175, label: 'Period 3', occupancy: 1 },
  { start: 175, end: 185, label: 'Lunch', occupancy: 0.2 },
  { start: 185, end: 235, label: 'Period 4', occupancy: 1 },
  { start: 235, end: 245, label: 'Break', occupancy: 0.25 },
  { start: 245, end: 295, label: 'Period 5', occupancy: 1 },
  { start: 295, end: 360, label: 'Dismissal', occupancy: 0 },
]);

export const DEFAULTS = Object.freeze({
  students: 28,
  volume: 210,
  outdoorCO2: 420,
  outdoorPM: 12,
  windSpeed: 1.5,
  deltaT: 4,
  windowMode: 'closed',
  windowOpen: 0,
  windowArea: 2.4,
  mechOA: 180,
  infiltrationACH: 0.35,
  infiltrationFactor: 0.7,
  co2Generation: 18,
  breathingFlow: 0.6,
  infectious: 0,
  quantaRate: 40,
  maskEfficiency: 0,
  crBoxes: 0,
  hepaUnits: 0,
  merv13: false,
  uvgi: false,
  budget: 1200,
  durationMin: 360,
  stepMin: 2,
  sampleMin: 6,
  co2Start: null,
  pmStart: null,
  schedule: DEFAULT_SCHEDULE,
});

const EPS = 1e-9;

export function clamp(value, low, high) {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function bool(value) {
  return value === true || value === 1 || value === '1';
}

/** Merge user input with defaults and clamp every numeric field. */
export function normalizeParams(input = {}) {
  const p = { ...DEFAULTS, ...input };
  p.students = clamp(finite(p.students, DEFAULTS.students), 0, 200);
  p.volume = clamp(finite(p.volume, DEFAULTS.volume), 10, 5000);
  p.outdoorCO2 = clamp(finite(p.outdoorCO2, DEFAULTS.outdoorCO2), 0, 5000);
  p.outdoorPM = clamp(finite(p.outdoorPM, DEFAULTS.outdoorPM), 0, 2000);
  p.windSpeed = clamp(finite(p.windSpeed, DEFAULTS.windSpeed), 0, 40);
  p.deltaT = clamp(finite(p.deltaT, DEFAULTS.deltaT), -40, 60);
  p.windowOpen = clamp(finite(p.windowOpen, 0), 0, 1);
  p.windowArea = clamp(finite(p.windowArea, DEFAULTS.windowArea), 0, 40);
  p.mechOA = clamp(finite(p.mechOA, 0), 0, 20000);
  p.infiltrationACH = clamp(finite(p.infiltrationACH, 0), 0, 20);
  p.infiltrationFactor = clamp(finite(p.infiltrationFactor, 0), 0, 1);
  p.co2Generation = clamp(finite(p.co2Generation, 0), 0, 100);
  p.breathingFlow = clamp(finite(p.breathingFlow, 0), 0, 10);
  p.infectious = clamp(finite(p.infectious, 0), 0, 20);
  p.quantaRate = clamp(finite(p.quantaRate, 0), 0, 2000);
  p.maskEfficiency = clamp(finite(p.maskEfficiency, 0), 0, 0.99);
  p.crBoxes = Math.round(clamp(finite(p.crBoxes, 0), 0, 20));
  p.hepaUnits = Math.round(clamp(finite(p.hepaUnits, 0), 0, 20));
  p.merv13 = bool(p.merv13);
  p.uvgi = bool(p.uvgi);
  p.budget = clamp(finite(p.budget, 0), 0, 100000);
  p.durationMin = clamp(finite(p.durationMin, 360), 1, 1440);
  p.stepMin = clamp(finite(p.stepMin, 2), 0.05, 60);
  p.sampleMin = clamp(finite(p.sampleMin, 6), 0.1, 1440);
  p.windowMode = ['closed', 'single', 'cross'].includes(p.windowMode) ? p.windowMode : 'closed';
  p.schedule = Array.isArray(p.schedule) && p.schedule.length ? p.schedule : DEFAULT_SCHEDULE;
  p.co2Start = Number.isFinite(p.co2Start) ? p.co2Start : p.outdoorCO2;
  p.pmStart = Number.isFinite(p.pmStart) ? p.pmStart : p.outdoorPM * p.infiltrationFactor;
  return p;
}

/** Occupancy multiplier at time t (minutes) from the class schedule. */
export function occupancyAt(t, params) {
  const p = params.schedule || DEFAULT_SCHEDULE;
  for (let i = 0; i < p.length; i += 1) {
    if (t >= p[i].start && t < p[i].end) return p[i].occupancy;
  }
  const last = p[p.length - 1];
  return last ? last.occupancy : 1;
}

/**
 * Simplified natural ventilation estimate.
 *
 * Wind: Q = Cd * Aeff * v * 3600. Single-sided Cd = 0.25; cross-flow Cd = 0.62
 * with two equal openings in series (Aeff = A / sqrt(2)).
 * Stack: Q = Cd * Aeff * sqrt(2 g H |dT| / Tmean) * 3600.
 * Wind and stack are combined by root-sum-square, then scaled by opening
 * fraction. Educational approximation only.
 */
export function ventilationRates(params) {
  const p = normalizeParams(params);
  if (p.windowMode === 'closed' || p.windowOpen <= 0) {
    return { qWind: 0, qStack: 0, qNatural: 0, qInfiltration: p.infiltrationACH * p.volume };
  }
  const area = p.windowArea * p.windowOpen;
  const cross = p.windowMode === 'cross';
  const aeff = cross ? area / Math.SQRT2 : area;
  const cd = cross ? 0.62 : 0.25;
  const height = cross ? 1.6 : 2.2;
  const meanTemp = 293;
  const gravity = 9.81;
  const qWind = cd * aeff * p.windSpeed * 3600;
  const qStack = cd * aeff * Math.sqrt((2 * gravity * height * Math.abs(p.deltaT)) / meanTemp) * 3600;
  return {
    qWind,
    qStack,
    qNatural: Math.hypot(qWind, qStack),
    qInfiltration: p.infiltrationACH * p.volume,
  };
}

export function equipment(params) {
  const p = normalizeParams(params);
  const crCADR = p.crBoxes * 400;
  const hepaCADR = p.hepaUnits * 350;
  const mervCADR = p.merv13 ? p.volume * 4 : 0;
  const uvgiCADR = p.uvgi ? p.volume * 3 : 0;
  const oaFilterEfficiency = p.merv13 ? 0.55 : 0.08;
  return {
    crCADR,
    hepaCADR,
    mervCADR,
    uvgiCADR,
    oaFilterEfficiency,
    quantaCADR: crCADR + hepaCADR + mervCADR + uvgiCADR,
    pmCADR: crCADR * 0.9 + hepaCADR * 0.99 + mervCADR * 0.5,
    cost: p.crBoxes * 85 + p.hepaUnits * 260 + (p.merv13 ? 650 : 0) + (p.uvgi ? 900 : 0),
    watts: p.crBoxes * 35 + p.hepaUnits * 55 + (p.merv13 ? 40 : 0) + (p.uvgi ? 25 : 0),
    dBA: equivalentNoise(p),
  };
}

/** Logarithmic addition of independent fan noise sources. */
export function equivalentNoise(params) {
  const p = normalizeParams(params);
  let sum = 0;
  for (let i = 0; i < p.crBoxes; i += 1) sum += 10 ** (52 / 10);
  for (let i = 0; i < p.hepaUnits; i += 1) sum += 10 ** (49 / 10);
  if (sum <= 0) return p.merv13 ? 1 : 0;
  const level = 10 * Math.log10(sum) + (p.merv13 ? 1 : 0);
  return Number.isFinite(level) ? level : 0;
}

/**
 * State: [CO2 ppm, unit-source quanta, integrated unit-source quanta, PM2.5].
 * Time t is in hours and every airflow is m3/h, so all terms are per-hour.
 */
function derivatives(state, tHours, p, vent, equip, occupancyOverride) {
  const co2 = state[0];
  const quanta = state[1];
  const pm = state[3];
  const tMinutes = tHours * 60;
  const people = (occupancyOverride === undefined
    ? occupancyAt(tMinutes, p) * p.students
    : occupancyOverride * p.students);
  const qOutdoor = vent.qNatural + p.mechOA;
  const co2Source = (people * p.co2Generation * 1000) / p.volume;
  const dco2 = co2Source - (qOutdoor / p.volume) * (co2 - p.outdoorCO2);

  const quantaRemoval =
    qOutdoor +
    p.mechOA * equip.oaFilterEfficiency +
    equip.quantaCADR;
  const dquanta = 1 / p.volume - (quantaRemoval / p.volume) * quanta;
  const dIntegral = quanta;

  const pmSource =
    (p.infiltrationFactor * vent.qInfiltration +
      vent.qNatural +
      p.mechOA * (1 - equip.oaFilterEfficiency)) *
    p.outdoorPM /
    p.volume;
  const pmSinks =
    (vent.qInfiltration + vent.qNatural + p.mechOA + equip.pmCADR) / p.volume;
  const dpm = pmSource - pmSinks * pm;

  return [dco2, dquanta, dIntegral, dpm];
}

function rk4Step(state, h, t, deriv) {
  const k1 = deriv(state, t);
  const s2 = state.map((v, i) => v + (h / 2) * k1[i]);
  const k2 = deriv(s2, t + h / 2);
  const s3 = state.map((v, i) => v + (h / 2) * k2[i]);
  const k3 = deriv(s3, t + h / 2);
  const s4 = state.map((v, i) => v + h * k3[i]);
  const k4 = deriv(s4, t + h);
  return state.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
}

function sortedUnique(values) {
  return [...new Set(values.map((v) => Math.round(v * 1e6) / 1e6))].sort((a, b) => a - b);
}

/**
 * Integrate the coupled CO2, quanta, dose and PM2.5 equations with RK4.
 * Steps never cross a schedule or sampling boundary, so discontinuities are
 * handled exactly instead of smearing across a step.
 */
export function simulate(input = {}, options = {}) {
  const p = normalizeParams(input);
  const vent = ventilationRates(p);
  const equip = equipment(p);
  const duration = p.durationMin;
  const boundaries = p.schedule.flatMap((s) => [s.start, s.end]).filter((t) => t > 0 && t < duration);
  const sampleTimes = [];
  for (let t = 0; t <= duration + EPS; t += p.sampleMin) sampleTimes.push(Math.min(t, duration));
  const nodes = sortedUnique([0, duration, ...boundaries, ...sampleTimes]);
  // Integrate in hours; the reported time series stays in minutes.
  const deriv = (state, tHours) => derivatives(state, tHours, p, vent, equip, options.occupancyOverride);

  let state = [p.co2Start, 0, 0, p.pmStart];
  const times = [];
  const co2 = [];
  const quanta = [];
  const integral = [];
  const pm = [];
  const risk = [];

  const push = (t, s) => {
    times.push(t);
    co2.push(s[0]);
    quanta.push(s[1]);
    integral.push(s[2]);
    pm.push(s[3]);
    risk.push(wellsRileyProbability(s[2], p) * 100);
  };
  push(0, state);

  const qOutdoor = vent.qNatural + p.mechOA;
  const maxRate = Math.max(
    qOutdoor / p.volume,
    (qOutdoor + p.mechOA * equip.oaFilterEfficiency + equip.quantaCADR) / p.volume,
    (vent.qInfiltration + qOutdoor + equip.pmCADR) / p.volume
  );

  for (let n = 0; n < nodes.length - 1; n += 1) {
    const start = nodes[n];
    const end = nodes[n + 1];
    const span = end - start;
    if (span <= EPS) continue;
    const minStableSteps = maxRate > EPS ? Math.ceil((maxRate * (span / 60)) / 1.5) : 1;
    const steps = Math.max(1, Math.ceil(span / p.stepMin - 1e-9), minStableSteps);
    const h = span / steps / 60;
    for (let j = 0; j < steps; j += 1) {
      state = rk4Step(state, h, (start + j * (span / steps)) / 60, deriv);
    }
    push(end, state);
  }

  const ecaTotal =
    vent.qNatural + p.mechOA + equip.quantaCADR + p.mechOA * equip.oaFilterEfficiency;
  const ecaPerPersonLps = p.students > 0 ? ecaTotal / p.students / 3.6 : 0;
  const max = (arr) => arr.reduce((a, b) => Math.max(a, b), -Infinity);
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    times,
    co2,
    quanta,
    integral,
    pm,
    risk,
    metrics: {
      co2Peak: max(co2),
      co2Mean: mean(co2),
      co2Final: co2[co2.length - 1],
      pmPeak: max(pm),
      pmMean: mean(pm),
      pmFinal: pm[pm.length - 1],
      riskFinal: risk[risk.length - 1],
      dose: state[2],
      ecaTotal,
      ecaPerPersonLps,
      cost: equip.cost,
      watts: equip.watts,
      dBA: equip.dBA,
      naturalCFM: vent.qNatural / 1.699,
      qNatural: vent.qNatural,
      qMech: p.mechOA,
    },
  };
}

/** Exact Wells-Riley probability from an integrated unit-source concentration. */
export function wellsRileyProbability(integratedConcentration, params) {
  const p = normalizeParams(params);
  const source = p.infectious * p.quantaRate * (1 - p.maskEfficiency) * p.breathingFlow;
  const dose = source * Math.max(0, finite(integratedConcentration, 0));
  if (dose <= 0) return 0;
  return 1 - Math.exp(-dose);
}

/** Closed-form CO2 solution for one constant-occupancy, constant-airflow segment. */
export function co2Analytic(tHours, params, initialCO2) {
  const p = normalizeParams(params);
  const q = ventilationRates(p).qNatural + p.mechOA;
  const cOut = p.outdoorCO2;
  const c0 = finite(initialCO2, cOut);
  const source = (p.students * p.co2Generation * 1000) / p.volume; // ppm/h
  if (q <= EPS) return c0 + source * tHours;
  const k = q / p.volume;
  const equilibrium = cOut + source / k;
  return equilibrium + (c0 - equilibrium) * Math.exp(-k * tHours);
}

/** Closed-form indoor/outdoor PM2.5 ratio at steady state. */
export function pmSteadyRatio(params) {
  const p = normalizeParams(params);
  const vent = ventilationRates(p);
  const equip = equipment(p);
  const incoming =
    p.infiltrationFactor * vent.qInfiltration +
    vent.qNatural +
    p.mechOA * (1 - equip.oaFilterEfficiency);
  const removal = vent.qInfiltration + vent.qNatural + p.mechOA + equip.pmCADR;
  return removal > EPS ? incoming / removal : Infinity;
}

/** Closed-form integral of unit quanta concentration from 0 to T (hours). */
export function quantaIntegralAnalytic(tHours, params) {
  const p = normalizeParams(params);
  const vent = ventilationRates(p);
  const equip = equipment(p);
  const removal =
    vent.qNatural + p.mechOA + p.mechOA * equip.oaFilterEfficiency + equip.quantaCADR;
  const k = removal / p.volume;
  if (k <= EPS) return tHours / p.volume;
  const cInf = 1 / removal;
  return cInf * (tHours - (1 - Math.exp(-k * tHours)) / k);
}

/** Solve a constant-coefficient linear ODE analytically at a given hour. */
function linearAnalytic(tHours, initial, ratePerHour, sourcePerHour) {
  const equilibrium = sourcePerHour / ratePerHour;
  return equilibrium + (initial - equilibrium) * Math.exp(-ratePerHour * tHours);
}

/** Compare RK4 against all three available closed-form solutions. */
export function verifyAnalytics(input = {}) {
  const p = normalizeParams({
    ...input,
    schedule: [{ start: 0, end: 1440, label: 'Constant', occupancy: 1 }],
    durationMin: 360,
    stepMin: 1,
    sampleMin: 6,
  });
  const run = simulate(p);
  const vent = ventilationRates(p);
  const equip = equipment(p);
  const co2Rate = (vent.qNatural + p.mechOA) / p.volume;
  const co2Source = (p.students * p.co2Generation * 1000) / p.volume;
  const pmRate = (vent.qInfiltration + vent.qNatural + p.mechOA + equip.pmCADR) / p.volume;
  const pmSource =
    (p.infiltrationFactor * vent.qInfiltration +
      vent.qNatural +
      p.mechOA * (1 - equip.oaFilterEfficiency)) *
    p.outdoorPM /
    p.volume;
  const quantaRatePerHour =
    (vent.qNatural + p.mechOA + p.mechOA * equip.oaFilterEfficiency + equip.quantaCADR) /
    p.volume;

  const co2Errors = [];
  const pmErrors = [];
  const quantaErrors = [];
  for (let i = 0; i < run.times.length; i += 1) {
    const hours = run.times[i] / 60;
    const targetCO2 = linearAnalytic(hours, p.co2Start, co2Rate, co2Source + co2Rate * p.outdoorCO2);
    co2Errors.push(run.co2[i] - targetCO2);
    pmErrors.push(run.pm[i] - linearAnalytic(hours, p.pmStart, pmRate, pmSource));
    const targetQuanta = linearAnalytic(hours, 0, quantaRatePerHour, 1 / p.volume);
    quantaErrors.push(run.quanta[i] - targetQuanta);
  }
  const rmse = (arr) => Math.sqrt(arr.reduce((s, e) => s + e * e, 0) / arr.length);
  const meanCo2 = run.co2.reduce((a, b) => a + b, 0) / run.co2.length;
  const co2Rmse = rmse(co2Errors);
  const tauHours = p.volume / (vent.qNatural + p.mechOA);
  const oneTau = co2Analytic(tauHours, p, p.co2Start);
  const sixHours = co2Analytic(6, p, p.co2Start);
  const approachFraction = Math.abs(sixHours - p.co2Start) > EPS
    ? (oneTau - p.co2Start) / (sixHours - p.co2Start)
    : 0;
  return {
    co2RmsePpm: co2Rmse,
    co2RmsePercent: (co2Rmse / meanCo2) * 100,
    co2MaxErrorPpm: Math.max(...co2Errors.map(Math.abs)),
    pmRmseUg: rmse(pmErrors),
    quantaRmse: rmse(quantaErrors),
    pmRatio: pmSteadyRatio(p),
    timeConstantHours: tauHours,
    approachFraction,
    steps: run.times.length - 1,
    passed: (co2Rmse / meanCo2) * 100 < 0.05 && rmse(quantaErrors) < 1e-5,
  };
}

/** Run a scenario and compare it with the closed-window, no-equipment baseline. */
export function evaluateScenario(input = {}) {
  const p = normalizeParams(input);
  const run = simulate(p);
  const baseline = simulate({
    ...p,
    windowMode: 'closed',
    windowOpen: 0,
    crBoxes: 0,
    hepaUnits: 0,
    merv13: false,
    uvgi: false,
  });
  const baseRisk = baseline.metrics.riskFinal;
  const riskReduction = baseRisk > EPS ? ((baseRisk - run.metrics.riskFinal) / baseRisk) * 100 : 0;
  return {
    params: p,
    run,
    baseline,
    metrics: { ...run.metrics, riskReduction, baselineRisk: baseRisk },
  };
}

const OBJECTIVES = [
  { key: 'cost', direction: 'min' },
  { key: 'watts', direction: 'min' },
  { key: 'dBA', direction: 'min' },
  { key: 'co2Peak', direction: 'min' },
  { key: 'pmMean', direction: 'min' },
  { key: 'riskRemaining', direction: 'min' },
];

/** Strict Pareto dominance: no objective worse, at least one strictly better. */
export function dominates(a, b, objectives = OBJECTIVES) {
  let strictlyBetter = false;
  for (const obj of objectives) {
    const av = a[obj.key];
    const bv = b[obj.key];
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return false;
    if (obj.direction === 'min') {
      if (av > bv + 1e-9) return false;
      if (av < bv - 1e-9) strictlyBetter = true;
    } else {
      if (av < bv - 1e-9) return false;
      if (av > bv + 1e-9) strictlyBetter = true;
    }
  }
  return strictlyBetter;
}

/** Exact O(n^2) Pareto filter. No approximation or binning is used. */
export function paretoFrontier(points, objectives = OBJECTIVES) {
  return points.filter(
    (candidate) => !points.some((other) => other !== candidate && dominates(other, candidate, objectives)),
  );
}

export function interventionOptions(params = {}) {
  const p = normalizeParams(params);
  const options = [];
  for (const mode of ['closed', 'single', 'cross']) {
    for (const open of mode === 'closed' ? [0] : [0.5, 1]) {
      for (const cr of [0, 1, 2]) {
        for (const hepa of [0, 1]) {
          for (const merv of [false, true]) {
            for (const uvgi of [false, true]) {
              options.push({
                ...p,
                windowMode: mode,
                windowOpen: open,
                crBoxes: cr,
                hepaUnits: hepa,
                merv13: merv,
                uvgi,
                label: `${mode}/${open}/${cr}/${hepa}/${merv ? 'merv' : 'nomerv'}/${uvgi ? 'uv' : 'nouv'}`,
              });
            }
          }
        }
      }
    }
  }
  return options;
}

/** Enumerate interventions, filter by budget, then compute the exact frontier. */
export function optimizeRetrofits(input = {}, budgetLimit) {
  const p = normalizeParams(input);
  const limit = budgetLimit === undefined ? p.budget : budgetLimit;
  const scenarios = interventionOptions(p).map((option) => {
    const evaluated = evaluateScenario(option);
    return {
      label: option.label,
      params: option,
      cost: evaluated.metrics.cost,
      watts: evaluated.metrics.watts,
      dBA: evaluated.metrics.dBA,
      co2Peak: evaluated.metrics.co2Peak,
      pmMean: evaluated.metrics.pmMean,
      riskRemaining: evaluated.metrics.riskFinal,
      riskReduction: evaluated.metrics.riskReduction,
    };
  });
  const affordable = scenarios.filter((s) => s.cost <= limit + 1e-9);
  const frontier = paretoFrontier(affordable).sort((a, b) => a.cost - b.cost || a.riskRemaining - b.riskRemaining);
  const bestRisk = frontier.reduce((best, s) => (!best || s.riskRemaining < best.riskRemaining ? s : best), null);
  const cheapest = frontier.length ? frontier[0] : null;
  return { all: scenarios, affordable, frontier, recommended: bestRisk, cheapest };
}

/**
 * Synthetic reference classroom models. These are parameter sets for
 * exploration, not measurements or pilots from any real school.
 */
export const PRESETS = Object.freeze([
  {
    id: 'standard28',
    name: 'Standard 28-student classroom',
    note: 'Synthetic reference model: closed windows, low mechanical outdoor air.',
    params: {
      students: 28, volume: 210, outdoorCO2: 420, outdoorPM: 12, windSpeed: 1.5,
      deltaT: 4, windowMode: 'closed', windowOpen: 0, mechOA: 180,
      infiltrationACH: 0.35, infectious: 1, quantaRate: 40, budget: 1200,
    },
  },
  {
    id: 'crowded-lab',
    name: 'Crowded science lab',
    note: 'Synthetic reference model: high occupancy and elevated quanta emission.',
    params: {
      students: 34, volume: 175, outdoorCO2: 450, outdoorPM: 15, windSpeed: 1,
      deltaT: 5, windowMode: 'closed', windowOpen: 0, mechOA: 220,
      infiltrationACH: 0.4, infectious: 1, quantaRate: 75, budget: 1800,
    },
  },
  {
    id: 'rural-natural',
    name: 'Rural naturally ventilated room',
    note: 'Synthetic reference model: cross ventilation and mild wind.',
    params: {
      students: 24, volume: 240, outdoorCO2: 415, outdoorPM: 8, windSpeed: 2.8,
      deltaT: 6, windowMode: 'cross', windowOpen: 0.75, mechOA: 0,
      infiltrationACH: 0.5, infectious: 1, quantaRate: 35, budget: 500,
    },
  },
  {
    id: 'wildfire-smoke',
    name: 'Wildfire smoke day',
    note: 'Synthetic reference model: outdoor PM2.5 fixed at 180 ug/m3.',
    params: {
      students: 26, volume: 200, outdoorCO2: 430, outdoorPM: 180, windSpeed: 2,
      deltaT: 3, windowMode: 'closed', windowOpen: 0, mechOA: 200,
      infiltrationACH: 0.5, infectious: 1, quantaRate: 45, budget: 1500,
    },
  },
  {
    id: 'diy-retrofit',
    name: 'DIY Corsi-Rosenthal comparison',
    note: 'Synthetic reference model: fan-box retrofit options under a budget.',
    params: {
      students: 30, volume: 220, outdoorCO2: 425, outdoorPM: 18, windSpeed: 1.8,
      deltaT: 4, windowMode: 'single', windowOpen: 0.35, mechOA: 150,
      infiltrationACH: 0.4, crBoxes: 1, hepaUnits: 0, infectious: 1,
      quantaRate: 50, budget: 900,
    },
  },
]);

export function getPreset(id) {
  return PRESETS.find((preset) => preset.id === id) || PRESETS[0];
}

const SHARE_FIELDS = Object.freeze({
  v: { min: 1, max: 1, integer: true },
  p: { values: PRESETS.map((preset) => preset.id) },
  s: { min: 1, max: 60, integer: true, map: 'students' },
  vol: { min: 50, max: 800, integer: true, map: 'volume' },
  co2: { min: 300, max: 1200, integer: true, map: 'outdoorCO2' },
  pm: { min: 0, max: 400, integer: true, map: 'outdoorPM' },
  wind: { min: 0, max: 15, map: 'windSpeed' },
  dt: { min: -15, max: 25, map: 'deltaT' },
  mode: { values: ['closed', 'single', 'cross'], map: 'windowMode' },
  open: { min: 0, max: 100, integer: true, map: 'windowOpen', scaleFrom: 100 },
  mech: { min: 0, max: 2000, integer: true, map: 'mechOA' },
  cr: { min: 0, max: 4, integer: true, map: 'crBoxes' },
  hepa: { min: 0, max: 4, integer: true, map: 'hepaUnits' },
  merv: { min: 0, max: 1, integer: true, map: 'merv13' },
  uvgi: { min: 0, max: 1, integer: true, map: 'uvgi' },
  inf: { min: 0, max: 5, integer: true, map: 'infectious' },
  q: { min: 0, max: 300, integer: true, map: 'quantaRate' },
  mask: { min: 0, max: 95, integer: true, map: 'maskEfficiency', scaleFrom: 100 },
  budget: { min: 0, max: 10000, integer: true, map: 'budget' },
});

const SHARE_ORDER = Object.keys(SHARE_FIELDS);

/** Encode only allowlisted, validated state into a compact URL hash. */
export function encodeShare(state = {}) {
  const s = normalizeParams(state);
  const parts = [`v=1`, `p=${encodeURIComponent(s.presetId || 'standard28')}`];
  for (const key of SHARE_ORDER) {
    if (key === 'v' || key === 'p') continue;
    const spec = SHARE_FIELDS[key];
    if (!spec.map) continue;
    let value = s[spec.map];
    if (spec.scaleFrom) value = Math.round(value * spec.scaleFrom * 100) / 100;
    if (spec.values) value = String(value);
    if (typeof value === 'boolean') value = value ? 1 : 0;
    parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return `#${parts.join('&')}`;
}

/**
 * Strictly decode a share hash. Unknown fields, duplicates, malformed numbers,
 * out-of-range values, oversized input and prototype keys are all rejected.
 * Never throws and never returns non-allowlisted keys.
 */
export function decodeShare(hash) {
  try {
    if (typeof hash !== 'string') return { ok: false, error: 'Invalid hash type' };
    let raw = hash.trim();
    if (raw.startsWith('#')) raw = raw.slice(1);
    if (!raw || raw.length > 600) return { ok: false, error: 'Hash length out of range' };
    if (/[\u0000-\u001f\u007f<>"'`;(){}[\]\\]/.test(raw)) return { ok: false, error: 'Unsafe characters' };
    const entries = raw.split('&');
    if (entries.length > SHARE_ORDER.length) return { ok: false, error: 'Too many fields' };
    const seen = new Set();
    const values = Object.create(null);
    for (const entry of entries) {
      const match = /^([a-z][a-z0-9]{0,5})=([A-Za-z0-9._-]{1,24})$/.exec(entry);
      if (!match) return { ok: false, error: 'Malformed field' };
      const [, key, rawValue] = match;
      if (!Object.hasOwn(SHARE_FIELDS, key)) return { ok: false, error: 'Unknown field' };
      if (seen.has(key)) return { ok: false, error: 'Duplicate field' };
      seen.add(key);
      const spec = SHARE_FIELDS[key];
      if (spec.values) {
        if (!spec.values.includes(rawValue)) return { ok: false, error: 'Enum out of range' };
        values[key] = rawValue;
        continue;
      }
      if (!/^-?\d+(?:\.\d{1,3})?$/.test(rawValue)) return { ok: false, error: 'Invalid number' };
      const number = Number(rawValue);
      if (!Number.isFinite(number) || number < spec.min || number > spec.max) {
        return { ok: false, error: 'Number out of range' };
      }
      if (spec.integer && !Number.isInteger(number)) return { ok: false, error: 'Expected integer' };
      values[key] = number;
    }
    if (!seen.has('v') || values.v !== 1) return { ok: false, error: 'Unsupported version' };
    const state = {};
    for (const key of SHARE_ORDER) {
      if (!seen.has(key) || key === 'v') continue;
      const spec = SHARE_FIELDS[key];
      if (key === 'p') {
        state.presetId = values.p;
        Object.assign(state, getPreset(values.p).params);
        continue;
      }
      let value = values[key];
      if (spec.scaleFrom) value = value / spec.scaleFrom;
      if (key === 'merv' || key === 'uvgi') value = value === 1;
      state[spec.map] = value;
    }
    return { ok: true, state, fields: [...seen] };
  } catch {
    return { ok: false, error: 'Decode failed' };
  }
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}
