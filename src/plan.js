/**
 * Classroom and community shared-air plan plus the live physics explainer.
 *
 * Pure ES module, no DOM and no dependencies beyond the engine: every string
 * is regenerated from the current scenario, so the checklist a teacher copies
 * and the equations a student reads always carry the real solved numbers.
 * All text is ASCII: hyphens only, never en or em dashes.
 */
import { normalizeParams, ventilationRates, equipment } from './engine.js';
import { steadyStateCo2 } from './retrofit.js';

const EPS = 1e-9;

/** Deterministic number formatting (no locale or ICU drift in tests). */
export function fmtNum(value, digits = 0) {
  if (!Number.isFinite(value)) return 'n/a';
  const fixed = Number(value).toFixed(digits);
  const [whole, frac] = fixed.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digitsOnly = sign ? whole.slice(1) : whole;
  const grouped = digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

export const PLAN_ROLES = Object.freeze([
  { id: 'teacher', label: 'Teacher' },
  { id: 'students', label: 'Students' },
  { id: 'families', label: 'Families and community' },
]);

function deviceSummary(p) {
  const parts = [];
  if (p.crBoxes > 0) parts.push(`${p.crBoxes} Corsi-Rosenthal box${p.crBoxes > 1 ? 'es' : ''}`);
  if (p.hepaUnits > 0) parts.push(`${p.hepaUnits} HEPA unit${p.hepaUnits > 1 ? 's' : ''}`);
  if (p.merv13) parts.push('the MERV-13 HVAC upgrade');
  if (p.uvgi) parts.push('upper-room UVGI');
  return parts;
}

/**
 * Build the role-grouped shared-air checklist for one evaluated scenario.
 * `params` is the effective input set, `metrics` the solved metric block from
 * evaluateScenario or analyticMetrics, `presetName` the display name.
 */
export function sharedAirPlan(input = {}, metrics = {}, presetName = 'reference classroom') {
  const p = normalizeParams(input);
  const vent = ventilationRates(p);
  const qExchange = Number.isFinite(metrics.qNatural) && Number.isFinite(metrics.qMech) && Number.isFinite(metrics.qInfiltration)
    ? metrics.qNatural + metrics.qMech + metrics.qInfiltration
    : vent.qNatural + p.mechOA + vent.qInfiltration;
  const ecaACH = Number.isFinite(metrics.ecaACH) ? metrics.ecaACH : 0;
  const ecaTotal = Number.isFinite(metrics.ecaTotal) ? metrics.ecaTotal : 0;
  const co2Peak = Number.isFinite(metrics.co2Peak) ? metrics.co2Peak : NaN;
  const pmMean = Number.isFinite(metrics.pmMean) ? metrics.pmMean : NaN;
  const riskFinal = Number.isFinite(metrics.riskFinal) ? metrics.riskFinal : NaN;
  const steady = steadyStateCo2(p);
  const devices = deviceSummary(p);

  const teacher = [
    { id: 'read', text: `Check outdoor air before first period. The model reads ${fmtNum(p.outdoorPM)} ug/m3 PM2.5 and ${fmtNum(p.outdoorCO2)} ppm CO2 outside right now.` },
    p.outdoorPM >= 35
      ? { id: 'windows', text: `Outdoor PM2.5 is elevated at ${fmtNum(p.outdoorPM)} ug/m3, so keep windows closed and lean on filtered recirculation; today outdoor air is a particle source.` }
      : p.windowMode === 'closed'
        ? { id: 'windows', text: `Outdoor air is clean enough to use at ${fmtNum(p.outdoorPM)} ug/m3. Open windows during breaks; outdoor air is the only lever that removes CO2.` }
        : { id: 'windows', text: `Hold the ${Math.round(p.windowOpen * 100)}% ${p.windowMode === 'cross' ? 'cross' : 'single-sided'} window opening through class periods and open wider at recess, lunch and passing time.` },
    co2Peak < 800
      ? { id: 'co2', text: `Keep a live CO2 readout visible. The modeled peak is ${fmtNum(co2Peak)} ppm, inside the 800 ppm guide band; keep the current routine and recheck it weekly.` }
      : { id: 'co2', text: `Keep a live CO2 readout visible. The modeled peak is ${fmtNum(co2Peak)} ppm, over the 800 ppm guide band; add outdoor air first and filtration second.` },
    devices.length
      ? { id: 'devices', text: `Run ${devices.join(' and ')} through every occupied period. Devices remove particles and aerosols but never CO2.` }
      : { id: 'devices', text: 'If a portable filter or fan box is available, run it during occupied periods. Devices remove particles and aerosols but never CO2.' },
    { id: 'log', text: 'Log the room once a week and re-run this model whenever occupancy, weather or equipment changes.' },
  ];

  const students = [
    { id: 'speak', text: 'Say so when the room feels stuffy. A reading over 1,000 ppm is the check band that says outdoor air is running low.' },
    { id: 'paths', text: 'Keep air paths open. Window bays, vents and filter intakes only work when they are unblocked.' },
    p.maskEfficiency > 0
      ? { id: 'masks', text: `The plan counts ${Math.round(p.maskEfficiency * 100)}% effective masks; keep them on consistently when risk runs high.` }
      : { id: 'masks', text: 'Masks cut shared aerosols. The model can price them in when airborne risk runs high.' },
    { id: 'log', text: 'Help log the CO2 reading every 15 minutes when the class runs the flush test.' },
  ];

  const families = [
    { id: 'ask', text: `Ask two questions of any classroom. What is its steady-state CO2, and what is its equivalent air change rate? This model says ${Number.isFinite(steady) ? `${fmtNum(steady)} ppm` : 'no steady state'} and ${fmtNum(ecaACH, 1)} eACH.` },
    { id: 'levers', text: 'A fan box removes particles and aerosols but cannot replace outdoor air for CO2. Ask which lever each purchase actually buys.' },
    { id: 'share', text: 'Share this plan. Every number in it comes from the same open, offline workbench, so anyone can check the math.' },
  ];
  if (p.crBoxes + p.hepaUnits > 0 || p.merv13 || p.uvgi) {
    families.push({ id: 'cost', text: `The modeled devices cost about $${fmtNum(metrics.cost ?? 0)} one-time and ${fmtNum(metrics.watts ?? 0)} W to run. Treat the figure as a conversation start, not a quote.` });
  }

  return {
    presetName: String(presetName || 'reference classroom'),
    summary: `Modeled now on the ${presetName}: CO2 peak ${fmtNum(co2Peak)} ppm, indoor PM2.5 ${fmtNum(pmMean, 1)} ug/m3, Wells-Riley risk ${fmtNum(riskFinal, 1)}%, equivalent clean air ${fmtNum(ecaTotal)} m3/h (${fmtNum(ecaACH, 1)} eACH) from ${fmtNum(qExchange)} m3/h of air exchange plus device CADR.`,
    roles: [
      { id: 'teacher', label: 'Teacher', items: teacher },
      { id: 'students', label: 'Students', items: students },
      { id: 'families', label: 'Families and community', items: families },
    ],
    foot: 'Synthetic reference classroom. Educational estimate from a simplified physics model, not a measurement and not health guidance. Generated offline by VentiLab.',
  };
}

/** Plain-text rendering for clipboard, SMS or print. `done` is a Set of item keys. */
export function planPlainText(plan, done = new Set()) {
  const lines = [
    'Classroom and community shared-air plan',
    plan.summary,
    '',
  ];
  for (const role of plan.roles) {
    lines.push(role.label.toUpperCase());
    for (const item of role.items) {
      lines.push(`[${done.has(`${role.id}:${item.id}`) ? 'x' : ' '}] ${item.text}`);
    }
    lines.push('');
  }
  lines.push(plan.foot);
  return lines.join('\n');
}

/**
 * The physics drawer: each equation row carries the symbolic formula, the
 * live substitution from the current classroom and the solved result.
 */
export function physicsExplainer(input = {}, metrics = {}) {
  const p = normalizeParams(input);
  const vent = ventilationRates(p);
  const equip = equipment(p);
  const qNatural = Number.isFinite(metrics.qNatural) ? metrics.qNatural : vent.qNatural;
  const qInfiltration = Number.isFinite(metrics.qInfiltration) ? metrics.qInfiltration : vent.qInfiltration;
  const qExchange = qNatural + p.mechOA + qInfiltration;
  const ach = qExchange / p.volume;
  const tau = ach > EPS ? 1 / ach : Infinity;
  const source = (p.students * p.co2Generation * 1000) / p.volume;
  const steady = steadyStateCo2(p);
  const quantaCADR = Number.isFinite(metrics.quantaCADR) ? metrics.quantaCADR : equip.quantaCADR;
  const ecaTotal = Number.isFinite(metrics.ecaTotal) ? metrics.ecaTotal : qExchange + quantaCADR;
  const dose = Number.isFinite(metrics.dose) ? metrics.dose : NaN;
  const doseFactor = p.infectious * p.quantaRate * (1 - p.maskEfficiency) * p.breathingFlow;
  const doseQuanta = Number.isFinite(dose) ? doseFactor * Math.max(0, dose) : NaN;
  const oaPerPerson = Number.isFinite(metrics.oaPerPersonLps) ? metrics.oaPerPersonLps : 0;

  return [
    {
      id: 'source',
      name: 'CO2 source',
      formula: 'S = N x G x 1000 / V',
      substitution: `${p.students} students x ${fmtNum(p.co2Generation, 1)} L/h x 1000 / ${fmtNum(p.volume)} m3`,
      result: `${fmtNum(source, 1)} ppm/h`,
      why: 'Each student exhales about 18 L/h of CO2 at light school activity; the room volume dilutes it.',
    },
    {
      id: 'ach',
      name: 'Air changes per hour',
      formula: 'ACH = (Qnat + Qmech + Qinf) / V',
      substitution: `(${fmtNum(qNatural)} + ${fmtNum(p.mechOA)} + ${fmtNum(qInfiltration)}) / ${fmtNum(p.volume)}`,
      result: ach > EPS ? `${fmtNum(ach, 2)} /h` : 'no exchange',
      why: 'Windows, mechanical outdoor air and crack infiltration all feed one exchange rate.',
    },
    {
      id: 'tau',
      name: 'Time constant',
      formula: 'tau = V / Q',
      substitution: `${fmtNum(p.volume)} / ${fmtNum(qExchange)}`,
      result: Number.isFinite(tau) ? `${fmtNum(tau, 2)} h` : 'no exchange',
      why: 'The CO2 gap above outdoors closes by 63% every tau, the signature of a first-order system.',
    },
    {
      id: 'steady',
      name: 'CO2 steady state',
      formula: 'C_ss = C_out + N x G x 1000 / Q',
      substitution: `${fmtNum(p.outdoorCO2)} + ${fmtNum(p.students)} x ${fmtNum(p.co2Generation, 1)} x 1000 / ${fmtNum(qExchange)}`,
      result: Number.isFinite(steady) ? `${fmtNum(steady)} ppm` : 'no steady state',
      why: 'Where CO2 settles with the room full; the six-hour peak chases this level.',
    },
    {
      id: 'eca',
      name: 'Equivalent clean airflow',
      formula: 'eACH = (Q + CADR) / V',
      substitution: `(${fmtNum(qExchange)} + ${fmtNum(quantaCADR)}) / ${fmtNum(p.volume)}`,
      result: `${fmtNum(ecaTotal / p.volume, 1)} eACH`,
      why: 'ASHRAE 241 puts outdoor air and device CADR on one scale; the CDC school guide is 5 or more.',
    },
    {
      id: 'wells-riley',
      name: 'Wells-Riley risk',
      formula: 'P = 1 - exp(-d)',
      substitution: Number.isFinite(dose)
        ? `d = ${p.infectious} x ${fmtNum(p.quantaRate)} x (1 - ${fmtNum(p.maskEfficiency, 2)}) x ${fmtNum(p.breathingFlow, 2)} x ${dose.toExponential(2)} = ${fmtNum(doseQuanta, 3)} quanta`
        : 'dose d unavailable',
      result: `${fmtNum(metrics.riskFinal ?? 0, 1)}%`,
      why: 'd multiplies infector count, emission, mask leakage and breathing into the solved quanta integral; the exponential turns dose into probability.',
    },
    {
      id: 'oa-person',
      name: 'Outdoor air per person',
      formula: 'OA = Q / N / 3.6',
      substitution: p.students > 0
        ? `${fmtNum(qExchange)} / ${p.students} / 3.6`
        : `${fmtNum(qExchange)} / 0 occupants`,
      result: p.students > 0 ? `${fmtNum(oaPerPerson, 1)} L/s` : 'no occupants',
      why: 'The ASHRAE 62.1 classroom guide is about 7 L/s of outdoor air per student.',
    },
    {
      id: 'pm',
      name: 'Particle balance',
      formula: 'dPM/dt = P_in x Q x C_out / V - (Q + CADRpm) x C / V',
      substitution: `outdoor ${fmtNum(p.outdoorPM)} ug/m3 -> indoor mean ${fmtNum(metrics.pmMean ?? 0, 1)} ug/m3`,
      result: `${fmtNum(metrics.pmMean ?? 0, 1)} ug/m3 indoor mean`,
      why: 'Particles ride the same air in, but infiltration only passes 70% and filters pull them back out.',
    },
  ];
}


