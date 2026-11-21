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
  cadrScale: 1,
  budget: 1200,
  durationMin: 360,
  stepMin: 2,
  sampleMin: 6,
  co2Start: null,
  pmStart: null,
  schedule: DEFAULT_SCHEDULE,
});

const EPS = 1e-9;
// Room-temperature air properties used for the conditioning-load estimate:
// density 1.2 kg/m3, specific heat 1.006 kJ/(kg K). Teaching constants only.
const AIR_DENSITY = 1.2;
const AIR_HEAT_CAPACITY = 1.006;

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
  p.cadrScale = clamp(finite(p.cadrScale, 1), 0, 10);
  p.budget = clamp(finite(p.budget, 0), 0, 100000);
  p.durationMin = clamp(finite(p.durationMin, 360), 1, 1440);
  p.stepMin = clamp(finite(p.stepMin, 2), 0.05, 60);
  p.sampleMin = clamp(finite(p.sampleMin, 6), 0.1, 1440);
  p.windowMode = ['closed', 'single', 'cross'].includes(p.windowMode) ? p.windowMode : 'closed';
  p.schedule = Array.isArray(p.schedule) && p.schedule.length &&
    p.schedule.every((s) => s && typeof s === 'object' &&
      Number.isFinite(s.start) && Number.isFinite(s.end) && Number.isFinite(s.occupancy))
    ? p.schedule
    : DEFAULT_SCHEDULE;
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
  const crCADR = p.crBoxes * 400 * p.cadrScale;
  const hepaCADR = p.hepaUnits * 350 * p.cadrScale;
  const mervCADR = p.merv13 ? p.volume * 4 * p.cadrScale : 0;
  const uvgiCADR = p.uvgi ? p.volume * 3 * p.cadrScale : 0;
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

/** Logarithmic addition of independent fan noise sources. MERV-13 is passive. */
export function equivalentNoise(params) {
  const p = normalizeParams(params);
  let sum = 0;
  for (let i = 0; i < p.crBoxes; i += 1) sum += 10 ** (52 / 10);
  for (let i = 0; i < p.hepaUnits; i += 1) sum += 10 ** (49 / 10);
  if (sum <= 0) return 0;
  const level = 10 * Math.log10(sum);
  return Number.isFinite(level) ? level : 0;
}

/**
 * Equivalent clean-air rate that removes indoor-generated quanta, in m3/h:
 * the full outdoor air exchange plus recirculating air cleaning, counted
 * once. The outdoor-air intake filter is not credited here. Filtering the
 * incoming stream only strips particles from outdoor air (handled in the PM
 * source term); it cannot remove indoor-generated quanta beyond the exchange
 * that is already fully credited.
 */
export function infectionCleanAirM3h(p, vent, equip) {
  return vent.qNatural + p.mechOA + vent.qInfiltration + equip.quantaCADR;
}

/**
 * State: [CO2 ppm, unit-source quanta, PM2.5]. Time t is in hours and every
 * airflow is m3/h, so all terms are per-hour. The continuous time integrals
 * of all three concentrations are accumulated outside the RK4 state as exact
 * closed-form spans, so reported means never depend on chart sampling.
 */
function derivatives(state, tHours, p, vent, equip, occupancyOverride) {
  const co2 = state[0];
  const quanta = state[1];
  const pm = state[2];
  const tMinutes = tHours * 60;
  const people = (occupancyOverride === undefined
    ? occupancyAt(tMinutes, p) * p.students
    : occupancyOverride * p.students);
  const qExchange = vent.qNatural + p.mechOA + vent.qInfiltration;
  const co2Source = (people * p.co2Generation * 1000) / p.volume;
  const dco2 = co2Source - (qExchange / p.volume) * (co2 - p.outdoorCO2);

  const quantaRemoval = infectionCleanAirM3h(p, vent, equip);
  const dquanta = 1 / p.volume - (quantaRemoval / p.volume) * quanta;

  const pmSource =
    (p.infiltrationFactor * vent.qInfiltration +
      vent.qNatural +
      p.mechOA * (1 - equip.oaFilterEfficiency)) *
    p.outdoorPM /
    p.volume;
  const pmSinks =
    (vent.qInfiltration + vent.qNatural + p.mechOA + equip.pmCADR) / p.volume;
  const dpm = pmSource - pmSinks * pm;

  return [dco2, dquanta, dpm];
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
 * Integrate the coupled CO2, quanta and PM2.5 equations with RK4. The
 * canonical integration grid holds only schedule boundaries and stepMin
 * sub-steps; chart sampling is a reporting density and never adds knots to
 * the solve. A reporting point inside a step is evaluated with a partial
 * RK4 step from the step start state, which keeps the emitted series on the
 * same solved trajectory without altering it.
 */
export function simulate(input = {}, options = {}) {
  const p = normalizeParams(input);
  const vent = ventilationRates(p);
  const equip = equipment(p);
  const duration = p.durationMin;
  const boundaries = p.schedule.flatMap((s) => [s.start, s.end]).filter((t) => t > 0 && t < duration);
  const sampleTimes = [];
  for (let t = 0; t <= duration + EPS; t += p.sampleMin) sampleTimes.push(Math.min(t, duration));
  const nodes = sortedUnique([0, duration, ...boundaries]);
  const outputTimes = sortedUnique([0, duration, ...boundaries, ...sampleTimes]);
  // Integrate in hours; the reported time series stays in minutes. Occupancy is
  // piecewise constant, so each span uses its single interior value exactly;
  // node times never rely on a floating-point round-trip through hours.
  const deriv = (state, tHours, occupancy) => derivatives(state, tHours, p, vent, equip, occupancy);

  const doseFactor = p.infectious * p.quantaRate * (1 - p.maskEfficiency) * p.breathingFlow;
  let state = [p.co2Start, 0, p.pmStart];
  // Exact closed-form time integrals chained across schedule spans. Every
  // reported mean and dose is the continuous integral of the exact
  // trajectory, so the metrics are invariant to both stepMin and sampleMin.
  let co2Integral = 0;
  let doseIntegral = 0;
  let pmIntegral = 0;
  let exactCo2 = p.co2Start;
  let exactQuanta = 0;
  let exactPm = p.pmStart;
  let stepCount = 0;
  const times = [];
  const co2 = [];
  const quanta = [];
  const integral = [];
  const pm = [];
  const risk = [];

  const push = (t, s, dose) => {
    times.push(t);
    co2.push(s[0]);
    quanta.push(s[1]);
    integral.push(dose);
    pm.push(s[2]);
    const d = doseFactor * Math.max(0, dose);
    risk.push(d > 0 ? (1 - Math.exp(-d)) * 100 : 0);
  };
  push(0, state, 0);

  const qExchange = vent.qNatural + p.mechOA + vent.qInfiltration;
  const co2Rate = qExchange / p.volume;
  const quantaRatePerHour = infectionCleanAirM3h(p, vent, equip) / p.volume;
  const pmRate = (vent.qInfiltration + vent.qNatural + p.mechOA + equip.pmCADR) / p.volume;
  const pmSourceRate =
    ((p.infiltrationFactor * vent.qInfiltration +
      vent.qNatural +
      p.mechOA * (1 - equip.oaFilterEfficiency)) *
      p.outdoorPM) /
    p.volume;
  const maxRate = Math.max(co2Rate, quantaRatePerHour, pmRate);

  let outputIndex = 1;
  for (let n = 0; n < nodes.length - 1; n += 1) {
    const start = nodes[n];
    const end = nodes[n + 1];
    const span = end - start;
    if (span <= EPS) continue;
    const minStableSteps = maxRate > EPS ? Math.ceil((maxRate * (span / 60)) / 1.5) : 1;
    const steps = Math.max(1, Math.ceil(span / p.stepMin - 1e-9), minStableSteps);
    const spanOccupancy = options.occupancyOverride === undefined
      ? occupancyAt((start + end) / 2, p)
      : options.occupancyOverride;
    const co2SourceRate =
      (spanOccupancy * p.students * p.co2Generation * 1000) / p.volume + co2Rate * p.outdoorCO2;
    const spanHours = span / 60;
    const spanDoseStart = doseIntegral;
    const spanQuantaStart = exactQuanta;
    const co2Span = linearSpan(exactCo2, co2Rate, co2SourceRate, spanHours);
    const quantaSpan = linearSpan(exactQuanta, quantaRatePerHour, 1 / p.volume, spanHours);
    const pmSpan = linearSpan(exactPm, pmRate, pmSourceRate, spanHours);
    co2Integral += co2Span.integral;
    doseIntegral += quantaSpan.integral;
    pmIntegral += pmSpan.integral;
    exactCo2 = co2Span.end;
    exactQuanta = quantaSpan.end;
    exactPm = pmSpan.end;
    const doseAt = (t) =>
      spanDoseStart +
      linearSpan(spanQuantaStart, quantaRatePerHour, 1 / p.volume, (t - start) / 60).integral;
    const stepDeriv = (s, t) => deriv(s, t, spanOccupancy);
    const h = spanHours / steps;
    const stepMinutes = span / steps;
    stepCount += steps;
    for (let j = 0; j < steps; j += 1) {
      const t0 = start + j * stepMinutes;
      const t1 = t0 + stepMinutes;
      const startState = state;
      state = rk4Step(startState, h, t0 / 60, stepDeriv);
      while (outputIndex < outputTimes.length && outputTimes[outputIndex] <= t1 + EPS) {
        const t = outputTimes[outputIndex];
        outputIndex += 1;
        if (t <= t0 + EPS) continue;
        if (t >= t1 - EPS) {
          push(t, state, doseAt(t));
          continue;
        }
        const dtHours = (t - t0) / 60;
        const sampleState = rk4Step(startState, dtHours, t0 / 60, stepDeriv);
        push(t, sampleState, doseAt(t));
      }
    }
  }

  const ecaTotal = infectionCleanAirM3h(p, vent, equip);
  const ecaPerPersonLps = p.students > 0 ? ecaTotal / p.students / 3.6 : 0;
  const oaPerPersonLps = p.students > 0 ? qExchange / p.students / 3.6 : 0;
  const max = (arr) => arr.reduce((a, b) => Math.max(a, b), -Infinity);
  // Means are exact continuous time integrals accumulated per integration
  // step, so they depend only on the physical scenario and never on the
  // chart sampling nodes.
  const durationHours = duration / 60;

  return {
    times,
    co2,
    quanta,
    integral,
    pm,
    risk,
    steps: stepCount,
    metrics: {
      co2Peak: max(co2),
      co2Mean: co2Integral / durationHours,
      co2Final: co2[co2.length - 1],
      pmPeak: max(pm),
      pmMean: pmIntegral / durationHours,
      pmFinal: pm[pm.length - 1],
      riskFinal: risk[risk.length - 1],
      dose: doseIntegral,
      ecaTotal,
      ecaACH: ecaTotal / p.volume,
      ecaPerPersonLps,
      oaPerPersonLps,
      cost: equip.cost,
      watts: equip.watts,
      dBA: equip.dBA,
      naturalCFM: vent.qNatural / 1.699,
      qNatural: vent.qNatural,
      qMech: p.mechOA,
      qInfiltration: vent.qInfiltration,
      quantaCADR: equip.quantaCADR,
      pmCADR: equip.pmCADR,
      ...energyMetrics(qExchange, p, equip),
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
  const vent = ventilationRates(p);
  const q = vent.qNatural + p.mechOA + vent.qInfiltration;
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
  const removal = infectionCleanAirM3h(p, vent, equip);
  const k = removal / p.volume;
  if (k <= EPS) return (tHours * tHours) / (2 * p.volume);
  const cInf = 1 / removal;
  return cInf * (tHours - (1 - Math.exp(-k * tHours)) / k);
}

/**
 * Teaching estimate of the thermal power needed to condition incoming
 * outdoor air to room temperature: P = q * rho * cp * |dT|, with q in m3/h
 * converted to kg/s. A positive deltaT means the outdoor stream must be
 * heated or cooled toward neutral. Device fan energy is tracked separately
 * through the watts field.
 */
function conditioningLoadKW(qExchangeM3h, deltaT) {
  return (qExchangeM3h * AIR_DENSITY * AIR_HEAT_CAPACITY * Math.abs(deltaT)) / 3600;
}

function energyMetrics(qExchangeM3h, p, equip) {
  const conditioningKW = conditioningLoadKW(qExchangeM3h, p.deltaT);
  const hours = p.durationMin / 60;
  return {
    conditioningKW,
    energyKwh: (conditioningKW + equip.watts / 1000) * hours,
  };
}

/** Solve a constant-coefficient linear ODE analytically at a given hour. */
function linearAnalytic(tHours, initial, ratePerHour, sourcePerHour) {
  if (ratePerHour <= EPS) return initial + sourcePerHour * tHours;
  const equilibrium = sourcePerHour / ratePerHour;
  return equilibrium + (initial - equilibrium) * Math.exp(-ratePerHour * tHours);
}

/**
 * Exact end value and exact time integral of dx/dt = source - rate*x over a
 * span of tHours hours, with the same zero-rate fallback the simulator uses.
 */
function linearSpan(initial, ratePerHour, sourcePerHour, tHours) {
  if (ratePerHour <= EPS) {
    return {
      end: initial + sourcePerHour * tHours,
      integral: initial * tHours + 0.5 * sourcePerHour * tHours * tHours,
    };
  }
  const equilibrium = sourcePerHour / ratePerHour;
  const decay = Math.exp(-ratePerHour * tHours);
  return {
    end: equilibrium + (initial - equilibrium) * decay,
    integral: equilibrium * tHours + ((initial - equilibrium) * (1 - decay)) / ratePerHour,
  };
}

/**
 * Closed-form counterpart of simulate(): every coefficient in the coupled
 * ODEs is piecewise constant across the schedule, so each node-to-node span
 * has an exact exponential solution. Evaluates the same output nodes and the
 * same peak/mean/final metric definitions, matching the RK4 trajectory to
 * solver tolerance. The 700-option optimizer uses it to stay instant.
 */
export function analyticMetrics(input = {}) {
  const p = normalizeParams(input);
  const vent = ventilationRates(p);
  const equip = equipment(p);
  const duration = p.durationMin;
  const boundaries = p.schedule.flatMap((s) => [s.start, s.end]).filter((t) => t > 0 && t < duration);
  const sampleTimes = [];
  for (let t = 0; t <= duration + EPS; t += p.sampleMin) sampleTimes.push(Math.min(t, duration));
  const nodes = sortedUnique([0, duration, ...boundaries, ...sampleTimes]);

  const qExchange = vent.qNatural + p.mechOA + vent.qInfiltration;
  const co2Rate = qExchange / p.volume;
  const quantaRemoval = infectionCleanAirM3h(p, vent, equip);
  const quantaRate = quantaRemoval / p.volume;
  const pmRate = (vent.qInfiltration + vent.qNatural + p.mechOA + equip.pmCADR) / p.volume;
  const pmSource =
    ((p.infiltrationFactor * vent.qInfiltration +
      vent.qNatural +
      p.mechOA * (1 - equip.oaFilterEfficiency)) *
      p.outdoorPM) /
    p.volume;
  const doseFactor = p.infectious * p.quantaRate * (1 - p.maskEfficiency) * p.breathingFlow;

  let co2Value = p.co2Start;
  let quantaValue = 0;
  let dose = 0;
  let pmValue = p.pmStart;
  let co2Integral = 0;
  let pmIntegral = 0;

  const times = [0];
  const co2 = [co2Value];
  const pm = [pmValue];
  const risk = [0];

  for (let n = 0; n < nodes.length - 1; n += 1) {
    const start = nodes[n];
    const end = nodes[n + 1];
    const span = end - start;
    if (span <= EPS) continue;
    const occupancy = occupancyAt((start + end) / 2, p);
    const tHours = span / 60;
    const co2Source =
      (occupancy * p.students * p.co2Generation * 1000) / p.volume +
      co2Rate * p.outdoorCO2;
    const co2Span = linearSpan(co2Value, co2Rate, co2Source, tHours);
    const quantaSpan = linearSpan(quantaValue, quantaRate, 1 / p.volume, tHours);
    const pmSpan = linearSpan(pmValue, pmRate, pmSource, tHours);
    co2Value = co2Span.end;
    quantaValue = quantaSpan.end;
    dose += quantaSpan.integral;
    pmValue = pmSpan.end;
    co2Integral += co2Span.integral;
    pmIntegral += pmSpan.integral;
    times.push(end);
    co2.push(co2Value);
    pm.push(pmValue);
    const d = doseFactor * Math.max(0, dose);
    risk.push(d > 0 ? (1 - Math.exp(-d)) * 100 : 0);
  }

  const ecaTotal = quantaRemoval;
  const ecaPerPersonLps = p.students > 0 ? ecaTotal / p.students / 3.6 : 0;
  const oaPerPersonLps = p.students > 0 ? qExchange / p.students / 3.6 : 0;
  const max = (arr) => arr.reduce((a, b) => Math.max(a, b), -Infinity);
  // Means are exact continuous time integrals summed over the schedule
  // spans, so they depend only on the physical scenario, never on the
  // chart sampling nodes.
  const durationHours = duration / 60;

  return {
    times,
    co2,
    pm,
    risk,
    metrics: {
      co2Peak: max(co2),
      co2Mean: co2Integral / durationHours,
      co2Final: co2[co2.length - 1],
      pmPeak: max(pm),
      pmMean: pmIntegral / durationHours,
      pmFinal: pm[pm.length - 1],
      riskFinal: risk[risk.length - 1],
      dose,
      ecaTotal,
      ecaACH: ecaTotal / p.volume,
      ecaPerPersonLps,
      oaPerPersonLps,
      cost: equip.cost,
      watts: equip.watts,
      dBA: equip.dBA,
      naturalCFM: vent.qNatural / 1.699,
      qNatural: vent.qNatural,
      qMech: p.mechOA,
      qInfiltration: vent.qInfiltration,
      quantaCADR: equip.quantaCADR,
      pmCADR: equip.pmCADR,
      oaFilterCredit: p.mechOA * equip.oaFilterEfficiency,
      ...energyMetrics(qExchange, p, equip),
    },
  };
}

/**
 * Status-chip severity. Each pollutant is scored by how far it exceeds its
 * own guide threshold, so a hazard many multiples over its limit outranks one
 * barely over: on a wildfire day PM2.5 leads instead of hiding behind CO2.
 * High tier: PM2.5 mean >= EPA 35, CO2 peak >= 1500, risk >= 20.
 * Elevated tier: PM2.5 mean >= WHO 15, CO2 peak >= 1000, risk >= 10.
 */
export function severityStatus(m) {
  const valid = Number.isFinite(m.co2Peak) && Number.isFinite(m.pmMean) && Number.isFinite(m.riskFinal);
  if (!valid) return { level: 'error', label: 'Solver error', hazards: [], dominant: null };
  const NAMES = { pm: 'PM2.5', co2: 'CO2', risk: 'infection risk' };
  const highScaled = [
    { key: 'pm', ratio: m.pmMean / 35 },
    { key: 'co2', ratio: m.co2Peak / 1500 },
    { key: 'risk', ratio: m.riskFinal / 20 },
  ]
    .filter((e) => e.ratio >= 1)
    .sort((a, b) => b.ratio - a.ratio);
  if (highScaled.length) {
    return {
      level: 'high',
      label: `High ${highScaled.map((e) => NAMES[e.key]).join(' + ')}`,
      hazards: highScaled.map((e) => e.key),
      dominant: highScaled[0].key,
    };
  }
  const elevatedScaled = [
    { key: 'pm', ratio: m.pmMean / 15 },
    { key: 'co2', ratio: m.co2Peak / 1000 },
    { key: 'risk', ratio: m.riskFinal / 10 },
  ]
    .filter((e) => e.ratio >= 1)
    .sort((a, b) => b.ratio - a.ratio);
  if (elevatedScaled.length) {
    return {
      level: 'elevated',
      label: `Elevated ${elevatedScaled.map((e) => NAMES[e.key]).join(' + ')}`,
      hazards: elevatedScaled.map((e) => e.key),
      dominant: elevatedScaled[0].key,
    };
  }
  return { level: 'ok', label: 'Within guide bands', hazards: [], dominant: null };
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
  const qExchange = vent.qNatural + p.mechOA + vent.qInfiltration;
  const co2Rate = qExchange / p.volume;
  const co2Source = (p.students * p.co2Generation * 1000) / p.volume;
  const pmRate = (vent.qInfiltration + vent.qNatural + p.mechOA + equip.pmCADR) / p.volume;
  const pmSource =
    (p.infiltrationFactor * vent.qInfiltration +
      vent.qNatural +
      p.mechOA * (1 - equip.oaFilterEfficiency)) *
    p.outdoorPM /
    p.volume;
  const quantaRatePerHour = infectionCleanAirM3h(p, vent, equip) / p.volume;

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
  const meanCo2 = run.metrics.co2Mean;
  const co2Rmse = rmse(co2Errors);
  // The tau pair and the equilibrium pair must share one rate threshold:
  // using qExchange here and co2Rate below leaves a band where tau is
  // finite but equilibrium is infinite and the fraction collapses to 0.
  const tauHours = co2Rate > EPS ? 1 / co2Rate : Infinity;
  const oneTau = co2Rate > EPS ? co2Analytic(tauHours, p, p.co2Start) : NaN;
  const co2Equilibrium = co2Rate > EPS ? p.outdoorCO2 + co2Source / co2Rate : Infinity;
  const netChange = Math.abs(co2Equilibrium - p.co2Start);
  // Approach fraction is signed progress from start toward equilibrium over
  // the full gap, so a correct solver reports 1 - exp(-1) after one time
  // constant whether CO2 rises or falls. Below ~1e-6 ppm of gap the
  // subtraction cancels all meaningful digits, so there is no approach to
  // measure.
  const approachFraction = Number.isFinite(oneTau) && netChange > 1e-6
    ? (oneTau - p.co2Start) / (co2Equilibrium - p.co2Start)
    : null;
  const steadyResidual = Number.isFinite(co2Equilibrium) && netChange > EPS
    ? Math.abs(run.co2[run.co2.length - 1] - co2Equilibrium) / netChange
    : null;
  return {
    co2RmsePpm: co2Rmse,
    co2RmsePercent: (co2Rmse / meanCo2) * 100,
    co2MaxErrorPpm: Math.max(...co2Errors.map(Math.abs)),
    pmRmseUg: rmse(pmErrors),
    quantaRmse: rmse(quantaErrors),
    pmRatio: pmSteadyRatio(p),
    timeConstantHours: tauHours,
    approachFraction,
    co2Equilibrium,
    steadyResidual,
    steps: run.steps,
    passed: (co2Rmse / meanCo2) * 100 < 0.05 && rmse(quantaErrors) < 1e-5,
  };
}

/**
 * Richardson-style step-size check: the same scenario at h, h/2 and h/4.
 * Output nodes are identical across runs because sampling never depends on
 * stepMin, so the series can be compared point for point. For a smooth ODE an
 * RK4 method shows an observed order near 4 (each refinement cuts the error
 * roughly sixteen-fold).
 */
export function convergenceCheck(input = {}) {
  const p = normalizeParams(input);
  const h0 = p.stepMin;
  const runAt = (stepMin) => simulate({ ...p, stepMin, sampleMin: 30 });
  const coarse = runAt(h0);
  const mid = runAt(h0 / 2);
  const fine = runAt(h0 / 4);
  const series = [
    { key: 'co2', label: 'CO2' },
    { key: 'pm', label: 'PM2.5' },
    { key: 'quanta', label: 'Quanta concentration' },
  ];
  const rows = [];
  for (const s of series) {
    const a = coarse[s.key];
    const b = mid[s.key];
    const c = fine[s.key];
    let deltaCM = 0;
    let deltaMF = 0;
    for (let i = 0; i < a.length && i < b.length && i < c.length; i += 1) {
      deltaCM = Math.max(deltaCM, Math.abs(a[i] - b[i]));
      deltaMF = Math.max(deltaMF, Math.abs(b[i] - c[i]));
    }
    // An order needs two differing pairs. Identical series with a zero
    // fine delta is genuine convergence (Infinity); identical coarse and
    // mid runs that then diverge from fine mean the stability floor
    // clamped the pair, so the chain cannot certify an order (NaN).
    const order = deltaCM > 0 && deltaMF > 0
      ? Math.log2(deltaCM / deltaMF)
      : deltaMF === 0 ? Infinity : NaN;
    rows.push({ key: s.key, label: s.label, deltaCM, deltaMF, order });
  }
  const worstDelta = Math.max(...rows.map((r) => r.deltaMF));
  const minOrder = Math.min(...rows.map((r) => r.order));
  return {
    stepMin: h0,
    rows,
    worstDelta,
    minOrder,
    passed: worstDelta < 1e-6 || minOrder >= 3,
  };
}

/** Parameters for the closed-window, no-equipment reference baseline. */
export function baselineParams(input = {}) {
  const p = normalizeParams(input);
  return {
    ...p,
    windowMode: 'closed',
    windowOpen: 0,
    crBoxes: 0,
    hepaUnits: 0,
    merv13: false,
    uvgi: false,
  };
}

/** Run a scenario and compare it with the closed-window, no-equipment baseline. */
export function evaluateScenario(input = {}, baselineRun) {
  const p = normalizeParams(input);
  const run = simulate(p);
  const baseline = baselineRun || simulate(baselineParams(p));
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
    for (const open of mode === 'closed' ? [0] : [0.25, 0.5, 1]) {
      for (const cr of [0, 1, 2, 3, 4]) {
        for (const hepa of [0, 1, 2, 3, 4]) {
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

/**
 * Enumerate interventions, filter by budget, then compute the exact frontier.
 * Options are scored with analyticMetrics (the closed-form of the same ODE);
 * pass { simulated: true } to score them with the RK4 simulator instead, which
 * the test suite uses to prove both paths produce the same frontier.
 */
export function optimizeRetrofits(input = {}, budgetLimit, { simulated = false } = {}) {
  const p = normalizeParams(input);
  const limit = budgetLimit === undefined ? p.budget : budgetLimit;
  const baseRisk = simulated
    ? simulate(baselineParams(p)).metrics.riskFinal
    : analyticMetrics(baselineParams(p)).metrics.riskFinal;
  const scenarios = interventionOptions(p).map((option) => {
    const evaluated = simulated ? simulate(option) : analyticMetrics(option);
    const equip = equipment(option);
    const m = evaluated.metrics;
    return {
      label: option.label,
      params: option,
      cost: m.cost,
      watts: m.watts,
      dBA: m.dBA,
      co2Peak: m.co2Peak,
      co2Mean: m.co2Mean,
      pmPeak: m.pmPeak,
      pmMean: m.pmMean,
      riskRemaining: m.riskFinal,
      riskReduction: baseRisk > EPS ? ((baseRisk - m.riskFinal) / baseRisk) * 100 : 0,
      ecaTotal: m.ecaTotal,
      ecaACH: m.ecaACH,
      quantaCADR: equip.quantaCADR,
      pmCADR: equip.pmCADR,
      airExchange: m.qNatural + m.qMech + m.qInfiltration,
      oaFilterCredit: equip.oaFilterEfficiency * m.qMech,
    };
  });
  const affordable = scenarios.filter((s) => s.cost <= limit + 1e-9);
  const frontier = paretoFrontier(affordable).sort((a, b) => a.cost - b.cost || a.riskRemaining - b.riskRemaining);
  const bestRisk = frontier.reduce((best, s) => (!best || s.riskRemaining < best.riskRemaining ? s : best), null);
  const cheapest = frontier.length ? frontier[0] : null;
  return { all: scenarios, affordable, frontier, recommended: bestRisk, cheapest };
}

/**
 * One-at-a-time parameter sensitivity (tornado) analysis.
 *
 * Each input is perturbed by the same fraction below and above its current
 * value while every other input stays fixed. Effects are computed with the
 * exact closed-form solver (analyticMetrics), so the result is fully
 * deterministic and identical across runs, browsers and exports.
 */
export const SENSITIVITY_PARAMETERS = Object.freeze([
  {
    id: 'ach',
    label: 'Mechanical outdoor air',
    unit: 'm3/h',
    get: (p) => p.mechOA,
    apply: (p, f) => ({ ...p, mechOA: p.mechOA * f }),
  },
  {
    id: 'occupancy',
    label: 'Occupancy',
    unit: 'students',
    get: (p) => p.students,
    apply: (p, f) => ({ ...p, students: p.students * f }),
  },
  {
    id: 'infiltration',
    label: 'Envelope infiltration',
    unit: 'ACH',
    get: (p) => p.infiltrationACH,
    apply: (p, f) => ({ ...p, infiltrationACH: p.infiltrationACH * f }),
  },
  {
    id: 'cadr',
    label: 'Device clean-air delivery',
    unit: 'x rated CADR',
    get: (p) => p.cadrScale,
    apply: (p, f) => ({ ...p, cadrScale: p.cadrScale * f }),
  },
]);

export const SENSITIVITY_OUTPUTS = Object.freeze([
  { id: 'co2Peak', label: 'CO2 peak', unit: 'ppm', digits: 0, get: (m) => m.co2Peak },
  { id: 'pmMean', label: 'PM2.5 mean', unit: 'ug/m3', digits: 1, get: (m) => m.pmMean },
  { id: 'energyKwh', label: 'Daily energy', unit: 'kWh', digits: 2, get: (m) => m.energyKwh },
  { id: 'riskFinal', label: 'Wells-Riley risk', unit: '%', digits: 1, get: (m) => m.riskFinal },
]);

export function sensitivityAnalysis(input = {}, { fraction = 0.2 } = {}) {
  const p = normalizeParams(input);
  const frac = clamp(finite(fraction, 0.2), 0, 0.95);
  const baseMetrics = analyticMetrics(p).metrics;
  const outputs = SENSITIVITY_OUTPUTS.map((o) => ({
    id: o.id,
    label: o.label,
    unit: o.unit,
    digits: o.digits,
    baseline: o.get(baseMetrics),
  }));
  const parameters = SENSITIVITY_PARAMETERS.map((def) => {
    const lowParams = def.apply(p, 1 - frac);
    const highParams = def.apply(p, 1 + frac);
    const lowMetrics = analyticMetrics(lowParams).metrics;
    const highMetrics = analyticMetrics(highParams).metrics;
    const effects = {};
    for (const o of SENSITIVITY_OUTPUTS) {
      const base = o.get(baseMetrics);
      const low = o.get(lowMetrics);
      const high = o.get(highMetrics);
      effects[o.id] = {
        low,
        high,
        deltaLow: low - base,
        deltaHigh: high - base,
        maxDelta: Math.max(Math.abs(low - base), Math.abs(high - base)),
      };
    }
    return {
      id: def.id,
      label: def.label,
      unit: def.unit,
      baseValue: def.get(p),
      lowValue: def.get(normalizeParams(lowParams)),
      highValue: def.get(normalizeParams(highParams)),
      effects,
    };
  });
  const defIndex = new Map(SENSITIVITY_PARAMETERS.map((def, i) => [def.id, i]));
  const tornadoOrder = {};
  for (const o of SENSITIVITY_OUTPUTS) {
    tornadoOrder[o.id] = parameters
      .slice()
      .sort((a, b) => b.effects[o.id].maxDelta - a.effects[o.id].maxDelta || defIndex.get(a.id) - defIndex.get(b.id))
      .map((param) => param.id);
  }
  return { fraction: frac, outputs, parameters, tornadoOrder };
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

/**
 * One-click guided experiments. Each pins a synthetic reference scenario plus a
 * short reading cue; every parameter remains editable afterward.
 */
export const EXPERIMENTS = Object.freeze([
  {
    id: 'winter-spike',
    name: 'Winter closed-window spike',
    presetId: 'standard28',
    overrides: { windowMode: 'closed', windowOpen: 0, mechOA: 120 },
    watch: 'CO2 climbs through the 1000 and 1500 ppm guides all day while Wells-Riley risk accumulates. Then apply any frontier point and watch the dashed baseline separate.',
  },
  {
    id: 'wildfire-event',
    name: 'Wildfire smoke PM2.5 event',
    presetId: 'wildfire-smoke',
    overrides: {},
    watch: 'Indoor PM2.5 settles far above the EPA 24-hour guide of 35 ug/m3. Apply a frontier point with HEPA or fan boxes and watch the orange line fall.',
  },
  {
    id: 'cr-vs-merv',
    name: 'Corsi-Rosenthal vs MERV-13',
    presetId: 'diy-retrofit',
    overrides: { budget: 900 },
    watch: 'On the frontier, DIY fan boxes sit next to a MERV-13 upgrade at similar risk. Click each point to compare cost, noise and clean air delivered.',
  },
  {
    id: 'cross-breeze',
    name: 'Cross-breeze recovery',
    presetId: 'rural-natural',
    overrides: {},
    watch: 'Cross ventilation with mild wind holds CO2 near outdoor levels and risk near zero, the free retrofit. Drag wind speed to zero to see it collapse.',
  },
]);

export function getExperiment(id) {
  return EXPERIMENTS.find((exp) => exp.id === id) || null;
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

/**
 * Deterministic audit export.
 *
 * The audit report is a plain JSON-serializable snapshot of the scenario,
 * its solved metrics, the one-at-a-time sensitivity table, the optimizer
 * summary and the solver verification numbers. It contains no timestamps,
 * random values or environment data, so the same scenario always produces
 * byte-identical output and a stable fingerprint.
 */

function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i += 1) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return out;
}

/** FNV-1a 32-bit hash of the UTF-8 bytes of the input, as 8 hex digits. */
export function fnv1a32(text) {
  const bytes = utf8Bytes(String(text));
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Canonical JSON: object keys sorted at every depth, arrays kept in order,
 * non-finite numbers and unsupported values serialised as null. Two
 * structurally equal values always produce identical text.
 */
export function canonicalJson(value) {
  const encode = (v) => {
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(encode).join(',')}]`;
    if (typeof v === 'object') {
      const keys = Object.keys(v)
        .filter((k) => v[k] !== undefined && typeof v[k] !== 'function')
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(v[k])}`).join(',')}}`;
    }
    return 'null';
  };
  return encode(value);
}

/** SHA-256 of the UTF-8 text as hex, or null where WebCrypto is unavailable. */
export async function sha256Hex(text) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || typeof subtle.digest !== 'function') return null;
  const digest = await subtle.digest('SHA-256', new Uint8Array(utf8Bytes(String(text))));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Formula-safe CSV cell. Finite JavaScript numbers serialize directly as
 * raw numeric cells (including negatives like -10 or -2.5) so spreadsheet
 * and parser consumers read them as numbers. Formula-injection escaping
 * (the leading apostrophe on =, +, -, @ and control characters) applies
 * only to non-numeric string values; quoting doubles embedded quotes.
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let out = String(value);
  if (/^[=+\-@\t\r]/.test(out)) out = `'${out}`;
  if (/[",\n\r]/.test(out)) out = `"${out.replace(/"/g, '""')}"`;
  return out;
}

const AUDIT_METRIC_UNITS = Object.freeze({
  co2Peak: 'ppm', co2Mean: 'ppm', co2Final: 'ppm',
  pmPeak: 'ug/m3', pmMean: 'ug/m3', pmFinal: 'ug/m3',
  riskFinal: '%', dose: 'quanta-h',
  ecaTotal: 'm3/h', ecaACH: 'eACH', ecaPerPersonLps: 'L/s', oaPerPersonLps: 'L/s',
  conditioningKW: 'kW', energyKwh: 'kWh',
  cost: 'USD', watts: 'W', dBA: 'dBA',
  qNatural: 'm3/h', qMech: 'm3/h', qInfiltration: 'm3/h',
  quantaCADR: 'm3/h', pmCADR: 'm3/h',
});

/** Build the deterministic audit report object for a scenario. */
export function auditReport(input = {}) {
  const p = normalizeParams(input);
  const m = analyticMetrics(p).metrics;
  const baseline = analyticMetrics(baselineParams(p)).metrics;
  const opt = optimizeRetrofits(p);
  const sens = sensitivityAnalysis(p);
  const verify = verifyAnalytics(p);
  const conv = convergenceCheck(p);
  const body = {
    reportVersion: 2,
    modelVersion: 'ventilab-model-v2',
    generator: 'VentiLab audit export',
    scope: 'Synthetic reference classroom. Educational estimate, not a measurement or design calculation.',
    // The scenario carries every effective input the report depends on, so
    // feeding report.scenario back into auditReport reproduces identical
    // peaks, means and fingerprint.
    scenario: {
      students: p.students,
      volume: p.volume,
      outdoorCO2: p.outdoorCO2,
      outdoorPM: p.outdoorPM,
      windSpeed: p.windSpeed,
      deltaT: p.deltaT,
      windowMode: p.windowMode,
      windowOpen: p.windowOpen,
      windowArea: p.windowArea,
      mechOA: p.mechOA,
      infiltrationACH: p.infiltrationACH,
      infiltrationFactor: p.infiltrationFactor,
      co2Generation: p.co2Generation,
      breathingFlow: p.breathingFlow,
      infectious: p.infectious,
      quantaRate: p.quantaRate,
      maskEfficiency: p.maskEfficiency,
      crBoxes: p.crBoxes,
      hepaUnits: p.hepaUnits,
      merv13: p.merv13,
      uvgi: p.uvgi,
      cadrScale: p.cadrScale,
      budget: p.budget,
      durationMin: p.durationMin,
      stepMin: p.stepMin,
      sampleMin: p.sampleMin,
      co2Start: p.co2Start,
      pmStart: p.pmStart,
      schedule: p.schedule,
    },
    metrics: Object.fromEntries(
      Object.keys(AUDIT_METRIC_UNITS).filter((k) => k in m).map((k) => [k, m[k]]),
    ),
    baseline: {
      riskFinal: baseline.riskFinal,
      co2Peak: baseline.co2Peak,
      pmMean: baseline.pmMean,
    },
    sensitivity: {
      fraction: sens.fraction,
      outputs: sens.outputs.map((o) => ({
        id: o.id, label: o.label, unit: o.unit, baseline: o.baseline,
      })),
      parameters: sens.parameters.map((param) => ({
        id: param.id,
        label: param.label,
        unit: param.unit,
        baseValue: param.baseValue,
        lowValue: param.lowValue,
        highValue: param.highValue,
        effects: Object.fromEntries(
          SENSITIVITY_OUTPUTS.map((o) => {
            const e = param.effects[o.id];
            return [o.id, { low: e.low, high: e.high, deltaLow: e.deltaLow, deltaHigh: e.deltaHigh }];
          }),
        ),
      })),
    },
    optimization: {
      totalOptions: opt.all.length,
      affordableOptions: opt.affordable.length,
      frontierOptions: opt.frontier.length,
      recommended: opt.recommended ? opt.recommended.label : null,
      cheapest: opt.cheapest ? opt.cheapest.label : null,
      recommendedDetail: opt.recommended
        ? {
            cost: opt.recommended.cost,
            watts: opt.recommended.watts,
            dBA: opt.recommended.dBA,
            co2Peak: opt.recommended.co2Peak,
            pmMean: opt.recommended.pmMean,
            riskRemaining: opt.recommended.riskRemaining,
            riskReduction: opt.recommended.riskReduction,
            ecaTotal: opt.recommended.ecaTotal,
            ecaACH: opt.recommended.ecaACH,
          }
        : null,
    },
    verification: {
      co2RmsePercent: verify.co2RmsePercent,
      co2RmsePpm: verify.co2RmsePpm,
      co2MaxErrorPpm: verify.co2MaxErrorPpm,
      pmRmseUg: verify.pmRmseUg,
      quantaRmse: verify.quantaRmse,
      pmRatio: verify.pmRatio,
      timeConstantHours: verify.timeConstantHours,
      approachFraction: verify.approachFraction,
      steadyResidual: verify.steadyResidual,
      rk4MinOrder: conv.minOrder,
      rk4WorstDelta: conv.worstDelta,
      passed: verify.passed && conv.passed,
    },
  };
  return {
    ...body,
    fingerprint: {
      algorithm: 'FNV-1a-32',
      role: 'JSON report payload identifier',
      note: 'FNV-1a-32 over the canonical JSON of every report field except this fingerprint block.',
      fnv1a32: fnv1a32(canonicalJson(body)),
    },
  };
}

/**
 * Serialise an audit report to a fixed-column, formula-safe CSV string.
 * extras.payloadSha256, when supplied, is embedded as the SHA-256 of the
 * canonical JSON report payload so a CSV alone can verify the JSON export.
 */
export function auditCsv(report, extras = {}) {
  const lines = ['section,item,measure,value,unit'];
  const row = (section, item, measure, value, unit = '') => {
    lines.push([section, item, measure, value, unit].map(csvCell).join(','));
  };
  row('meta', 'reportVersion', 'value', report.reportVersion);
  row('meta', 'modelVersion', 'solver and model version', report.modelVersion);
  row('meta', 'generator', 'value', report.generator);
  row('meta', 'scope', 'value', report.scope);
  row('meta', 'fingerprint', `${report.fingerprint.algorithm} ${report.fingerprint.role}`, report.fingerprint.fnv1a32);
  if (extras.payloadSha256) {
    row('meta', 'jsonPayloadSha256', 'SHA-256 of the canonical JSON report payload', extras.payloadSha256);
  }
  for (const [k, v] of Object.entries(report.scenario)) {
    row('scenario', k, 'value', v !== null && typeof v === 'object' ? canonicalJson(v) : v);
  }
  for (const [k, v] of Object.entries(report.metrics)) row('metrics', k, 'value', v, AUDIT_METRIC_UNITS[k] || '');
  for (const [k, v] of Object.entries(report.baseline)) row('baseline', k, 'value', v, AUDIT_METRIC_UNITS[k] || '');
  for (const param of report.sensitivity.parameters) {
    row('sensitivity', param.id, 'input_base', param.baseValue, param.unit);
    row('sensitivity', param.id, 'input_low', param.lowValue, param.unit);
    row('sensitivity', param.id, 'input_high', param.highValue, param.unit);
    for (const out of report.sensitivity.outputs) {
      const e = param.effects[out.id];
      row('sensitivity', `${param.id}>${out.id}`, 'value_low', e.low, out.unit);
      row('sensitivity', `${param.id}>${out.id}`, 'value_high', e.high, out.unit);
      row('sensitivity', `${param.id}>${out.id}`, 'delta_low', e.deltaLow, out.unit);
      row('sensitivity', `${param.id}>${out.id}`, 'delta_high', e.deltaHigh, out.unit);
    }
  }
  for (const [k, v] of Object.entries(report.optimization)) {
    if (v !== null && typeof v === 'object') {
      for (const [dk, dv] of Object.entries(v)) row('optimization', `${k}.${dk}`, 'value', dv, AUDIT_METRIC_UNITS[dk] || '');
    } else {
      row('optimization', k, 'value', v === null ? '' : v);
    }
  }
  for (const [k, v] of Object.entries(report.verification)) row('verification', k, 'value', v);
  return `${lines.join('\r\n')}\r\n`;
}
