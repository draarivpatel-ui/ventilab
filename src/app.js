/**
 * VentiLab application controller. Wires controls, physics engine, charts,
 * share codec, guided experiments, frontier inspector and print card.
 * Only DOM APIs and local modules are used.
 */
import * as E from './engine.js';
import * as V from './viz.js';

const $ = (id) => document.getElementById(id);
const fmt = (n, digits = 0) => Number.isFinite(n)
  ? n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : '--';

const CONTROL_MAP = {
  students: (v) => Number(v),
  volume: (v) => Number(v),
  outdoorPM: (v) => Number(v),
  outdoorCO2: (v) => Number(v),
  windowOpen: (v) => Number(v) / 100,
  mechOA: (v) => Number(v),
  crBoxes: (v) => Number(v),
  hepaUnits: (v) => Number(v),
  budget: (v) => Number(v),
  infectious: (v) => Number(v),
  wind: (v) => Number(v),
};

const state = {
  presetId: 'standard28',
  students: 28,
  volume: 210,
  outdoorCO2: 420,
  outdoorPM: 12,
  windSpeed: 1.5,
  windowMode: 'closed',
  windowOpen: 0,
  mechOA: 180,
  crBoxes: 0,
  hepaUnits: 0,
  merv13: false,
  uvgi: false,
  masks: false,
  infectious: 1,
  budget: 1200,
};

let evaluated = null;
let optimization = null;
let verification = null;
let convergence = null;
let selectedIntervention = -1;
let hoverIndex = null;
let hoverPareto = null;
let toastTimer = null;

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function syncControls() {
  for (const id of Object.keys(CONTROL_MAP)) {
    const el = $(id);
    if (!el) continue;
    const engineKey = id === 'wind' ? 'windSpeed' : id;
    const value = state[engineKey];
    if (id === 'windowOpen') el.value = String(Math.round(value * 100));
    else el.value = String(value);
  }
  for (const radio of document.querySelectorAll('input[name="windowMode"]')) {
    radio.checked = radio.value === state.windowMode;
  }
  $('merv13').checked = state.merv13;
  $('uvgi').checked = state.uvgi;
  $('masks').checked = state.masks;
  $('presetSelect').value = state.presetId;
  $('presetNote').textContent = E.getPreset(state.presetId).note;
  const outs = {
    students: `${state.students}`, volume: `${state.volume} m3`, outdoorPM: `${state.outdoorPM} ug/m3`,
    windowOpen: `${Math.round(state.windowOpen * 100)}%`, mechOA: `${state.mechOA} m3/h`,
    crBoxes: `${state.crBoxes}`, hepaUnits: `${state.hepaUnits}`, budget: `$${fmt(state.budget)}`,
    infectious: `${state.infectious}`, wind: `${state.windSpeed} m/s`, outdoorCO2: `${state.outdoorCO2} ppm`,
  };
  for (const [id, text] of Object.entries(outs)) {
    const el = $(`${id}Out`);
    if (el) el.textContent = text;
  }
}

function physicsParams() {
  return {
    ...state,
    maskEfficiency: state.masks ? 0.7 : 0,
    stepMin: 2,
    sampleMin: 6,
  };
}

function metricCard(label, value, unit, percent, kind, note) {
  const title = note ? `${label} (${note})` : label;
  return `<article class="metric ${kind || ''}">
    <div class="metric-label">${E.escapeHtml(title)}</div>
    <div class="metric-value">${E.escapeHtml(value)}</div>
    <div class="metric-unit">${E.escapeHtml(unit)}</div>
    <div class="metric-bar" aria-hidden="true"><span style="width:${Math.max(2, Math.min(100, percent))}%"></span></div>
  </article>`;
}

function renderMetrics() {
  const m = evaluated.metrics;
  const severity = E.severityStatus(m);
  const chip = $('statusChip');
  chip.textContent = severity.label;
  chip.className = `status-chip${severity.level === 'high' || severity.level === 'error' ? ' chip-alert' : severity.level === 'elevated' ? ' chip-warn' : ' chip-good'}`;
  const delta = m.riskReduction;
  const deltaText = `${delta > 0 ? '-' : delta < 0 ? '+' : ''}${fmt(Math.abs(delta), 1)}%`;
  $('metricGrid').innerHTML = [
    metricCard('CO2 peak', fmt(m.co2Peak), 'ppm', (m.co2Peak / 2500) * 100, '', 'six-hour maximum'),
    metricCard('PM2.5 indoor mean', fmt(m.pmMean, 1), 'ug/m3', (m.pmMean / 200) * 100, 'is-particles', 'six-hour mean'),
    metricCard('Wells-Riley risk', fmt(m.riskFinal, 1), '%', m.riskFinal, 'is-risk', 'end of day'),
    metricCard('Risk vs do-nothing', deltaText, `baseline ${fmt(m.baselineRisk, 1)}% -> now ${fmt(m.riskFinal, 1)}%`, Math.max(0, delta), 'is-money', 'closed windows, no devices'),
    metricCard('Equivalent clean airflow', fmt(m.ecaTotal), 'm3/h (ASHRAE 241)', Math.min(100, (m.ecaACH / 8) * 100), '', `${fmt(m.ecaACH, 1)} eACH, CDC guide >=5`),
    metricCard('Outdoor air per person', fmt(m.oaPerPersonLps, 1), 'L/s', Math.min(100, (m.oaPerPersonLps / 10) * 100), '', `ASHRAE 62.1 classroom guide ~7 L/s`),
    metricCard('Retrofit cost', `$${fmt(m.cost)}`, 'one-time estimate', Math.min(100, (m.cost / 4000) * 100), 'is-money', 'for selected devices'),
    metricCard('Device power', fmt(m.watts), 'W', Math.min(100, (m.watts / 500) * 100), '', `${fmt(m.dBA, 0)} dBA combined`),
  ].join('');
  const band = m.co2Peak >= 1500 ? 'the 1500 ppm poor band' : m.co2Peak >= 1000 ? 'the 1000 ppm check band' : 'the 800 ppm guide band';
  const pmGuide = m.pmMean >= 35 ? 'over the EPA 24-hour guide of 35' : m.pmMean >= 15 ? 'over the WHO 24-hour guide of 15' : 'inside the WHO 24-hour guide of 15';
  $('metricCaption').textContent = `Peak CO2 sits in ${band} on the chart. Indoor PM2.5 averages ${fmt(m.pmMean, 1)} ug/m3, ${pmGuide}. Outdoor air per student is ${fmt(m.oaPerPersonLps, 1)} L/s against the ASHRAE 62.1 classroom guide of about 7 L/s, and equivalent clean airflow is ${fmt(m.ecaACH, 1)} eACH against the CDC guide of 5 or more.`;
  $('diagramCaption').textContent = state.windowMode === 'closed'
    ? `Windows closed. Mechanical outdoor air is ${fmt(state.mechOA)} m3/h and infiltration adds ${fmt(m.qInfiltration)} m3/h; filtration recirculates indoor air but does not remove the body-generated CO2.`
    : `${state.windowMode === 'cross' ? 'Cross' : 'Single-sided'} ventilation at ${Math.round(state.windowOpen * 100)}% opening contributes ${fmt(m.qNatural)} m3/h of outdoor air on top of ${fmt(m.qInfiltration)} m3/h infiltration.`;
}

function renderTable() {
  const rows = evaluated.run.times.map((t, i) => `<tr><td>${fmt(t)}</td><td>${fmt(evaluated.run.co2[i])}</td><td>${fmt(evaluated.run.pm[i], 1)}</td><td>${fmt(evaluated.run.risk[i], 2)}</td></tr>`).join('');
  $('dataTable').innerHTML = `<table><thead><tr><th>Time (min)</th><th>CO2 (ppm)</th><th>PM2.5 (ug/m3)</th><th>Risk (%)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function describeOption(option) {
  const parts = [];
  if (option.params.windowMode !== 'closed') parts.push(`${option.params.windowMode === 'cross' ? 'cross' : 'single-sided'} windows ${Math.round(option.params.windowOpen * 100)}%`);
  if (option.params.crBoxes) parts.push(`${option.params.crBoxes} fan box${option.params.crBoxes > 1 ? 'es' : ''}`);
  if (option.params.hepaUnits) parts.push(`${option.params.hepaUnits} HEPA`);
  if (option.params.merv13) parts.push('MERV-13');
  if (option.params.uvgi) parts.push('UVGI');
  return parts.length ? parts.join(' + ') : 'No retrofit (baseline)';
}

function inspectedOption() {
  if (hoverPareto !== null && optimization.affordable[hoverPareto]) return { option: optimization.affordable[hoverPareto], index: hoverPareto, source: 'hover' };
  if (selectedIntervention >= 0 && optimization.affordable[selectedIntervention]) return { option: optimization.affordable[selectedIntervention], index: selectedIntervention, source: 'selected' };
  const recIndex = optimization.recommended ? optimization.affordable.indexOf(optimization.recommended) : -1;
  if (recIndex >= 0) return { option: optimization.affordable[recIndex], index: recIndex, source: 'recommended' };
  return null;
}

function renderInspector() {
  const inspected = inspectedOption();
  const grid = $('inspGrid');
  const applyBtn = $('inspApply');
  if (!inspected) {
    $('inspTitle').textContent = 'No option inside the budget';
    grid.innerHTML = '';
    $('inspNote').textContent = 'Raise the retrofit budget to unlock frontier points.';
    applyBtn.disabled = true;
    return;
  }
  const p = inspected.option;
  const onFrontier = optimization.frontier.includes(p);
  $('inspTitle').textContent = describeOption(p);
  const cells = [
    ['Cost', `$${fmt(p.cost)}`],
    ['Power', `${fmt(p.watts)} W`],
    ['Noise', `${fmt(p.dBA, 0)} dBA`],
    ['Outdoor air exchange', `${fmt(p.airExchange)} m3/h`],
    ['Mechanical CADR (devices)', `${fmt(p.quantaCADR)} m3/h`],
    ['Device PM2.5 CADR', `${fmt(p.pmCADR)} m3/h`],
    ['HVAC filter credit', `${fmt(p.oaFilterCredit)} m3/h`],
    ['Total equiv. clean air', `${fmt(p.ecaTotal)} m3/h`],
    ['Total equiv. air changes', `${fmt(p.ecaACH, 1)} eACH`],
    ['CO2 peak', `${fmt(p.co2Peak)} ppm`],
    ['PM2.5 mean', `${fmt(p.pmMean, 1)} ug/m3`],
    ['Risk delta vs baseline', `${p.riskReduction >= 0 ? '-' : '+'}${fmt(Math.abs(p.riskReduction), 1)}% (${fmt(p.riskRemaining, 1)}% left)`],
  ];
  grid.innerHTML = cells.map(([k, v]) => `<div class="insp-cell"><span>${E.escapeHtml(k)}</span><strong>${E.escapeHtml(v)}</strong></div>`).join('');
  const pos = onFrontier ? 'Pareto optimal' : 'dominated by at least one frontier point';
  const src = inspected.source === 'hover' ? 'hovering' : inspected.source;
  $('inspNote').textContent = `${src === 'recommended' ? 'Recommended' : 'Inspected'} point, ${pos} across cost, power, noise, CO2 peak, PM2.5 mean and remaining risk. Total clean air ${fmt(p.ecaTotal)} m3/h = outdoor air ${fmt(p.airExchange)} + device CADR ${fmt(p.quantaCADR)} + HVAC filter credit ${fmt(p.oaFilterCredit)}.`;
  applyBtn.disabled = false;
}

function renderPareto() {
  const affordable = optimization.affordable;
  const frontier = optimization.frontier;
  $('paretoCaption').textContent = `${frontier.length} exact Pareto-optimal options from ${affordable.length} affordable configurations, compared on cost, power, noise, CO2 peak, PM2.5 mean and remaining risk. Click any point to inspect it.`;
  const cards = frontier.slice(0, 6).map((p) => {
    const index = affordable.indexOf(p);
    return `<button type="button" class="intervention${index === selectedIntervention ? ' is-active' : ''}" data-index="${index}" aria-pressed="${index === selectedIntervention}">
      <div class="intervention-title">${E.escapeHtml(describeOption(p))}</div>
      <div class="intervention-sub">$${fmt(p.cost)} - risk ${fmt(p.riskRemaining, 1)}% - ${fmt(p.dBA, 0)} dBA - ${fmt(p.co2Peak)} ppm CO2 - ${fmt(p.pmMean, 1)} ug/m3 PM</div>
    </button>`;
  }).join('');
  $('interventionList').innerHTML = cards || '<p class="viz-caption">No option fits the selected budget. Raise the budget to explore retrofits.</p>';
  for (const button of $('interventionList').querySelectorAll('.intervention')) {
    button.addEventListener('click', () => selectIntervention(Number(button.dataset.index)));
  }
  V.drawPareto($('paretoCanvas'), affordable, frontier, selectedIntervention, hoverPareto);
  renderInspector();
}

function selectIntervention(index) {
  const option = optimization.affordable[index];
  if (!option) return;
  selectedIntervention = index;
  renderPareto();
}

function applyIntervention(index) {
  const option = optimization.affordable[index];
  if (!option) return;
  selectedIntervention = index;
  state.windowMode = option.params.windowMode;
  state.windowOpen = option.params.windowOpen;
  state.crBoxes = option.params.crBoxes;
  state.hepaUnits = option.params.hepaUnits;
  state.merv13 = option.params.merv13;
  state.uvgi = option.params.uvgi;
  syncControls();
  recompute();
  showToast(`Applied: ${describeOption(option)}`);
}

function renderVerification() {
  const v = verification;
  const c = convergence;
  $('verifyChip').textContent = v.passed && c.passed ? 'PASS' : 'CHECK FAILED';
  $('verifyChip').className = `status-chip ${v.passed && c.passed ? 'chip-good' : 'chip-alert'}`;
  const worstRow = c.rows.reduce((a, b) => (b.deltaMF > a.deltaMF ? b : a), c.rows[0]);
  $('verifyGrid').innerHTML = `
    <div class="verify-item"><span>CO2 RK4 vs closed form</span><strong>${v.co2RmsePercent.toExponential(2)}%</strong></div>
    <div class="verify-item"><span>PM2.5 RMSE</span><strong>${v.pmRmseUg.toExponential(2)} ug/m3</strong></div>
    <div class="verify-item"><span>Integrated quanta</span><strong>${v.quantaRmse.toExponential(2)}</strong></div>
    <div class="verify-item"><span>RK4 observed order</span><strong>${fmt(c.minOrder, 2)} (expect ~4)</strong></div>
    <div class="verify-item"><span>Refinement delta, h/2 vs h/4</span><strong>${worstRow.deltaMF.toExponential(2)} (${worstRow.label})</strong></div>
    <div class="verify-item"><span>CO2 steady-state residual</span><strong>${fmt(v.steadyResidual * 100, 3)}% of approach</strong></div>
    <div class="verify-item"><span>CO2 time constant</span><strong>${fmt(v.timeConstantHours, 2)} h</strong></div>
    <div class="verify-item"><span>Approach after one tau</span><strong>${fmt(v.approachFraction * 100, 1)}%</strong></div>
    <div class="verify-item"><span>PM indoor/outdoor ratio</span><strong>${fmt(v.pmRatio, 3)}</strong></div>`;
}

function renderActionCard() {
  const m = evaluated.metrics;
  const top = optimization.recommended;
  const recommendation = top ? `${describeOption(top)} (${fmt(top.riskReduction, 0)}% lower risk)` : 'No retrofit within budget';
  const actions = [
    `Track CO2 and keep it under 800 ppm during class if possible.`,
    state.outdoorPM > 80
      ? 'Wildfire day. Keep windows closed and run filtered recirculation; outdoor PM2.5 is high.'
      : `Use ${state.windowMode === 'closed' ? 'short mid-class window breaks' : `${Math.round(state.windowOpen * 100)}% window opening`} when outdoor air is clean.`,
    top && top.cost > 0 ? `Budget priority. ${recommendation}.` : 'No new purchase needed. Timing and window use come first.',
    'Recheck the numbers after changing seats, occupancy or weather.',
  ];
  $('actionCard').innerHTML = `
    <p class="card-title">Clean-Air Action Card</p>
    <div class="card-grid">
      <div class="card-cell"><span>CO2 peak</span><strong>${fmt(m.co2Peak)} ppm</strong></div>
      <div class="card-cell"><span>Indoor PM2.5</span><strong>${fmt(m.pmMean, 1)} ug/m3</strong></div>
      <div class="card-cell"><span>Airborne risk</span><strong>${fmt(m.riskFinal, 1)}%</strong></div>
      <div class="card-cell"><span>Equivalent ACH</span><strong>${fmt(m.ecaACH, 1)} eACH</strong></div>
    </div>
    <ol class="card-steps">${actions.map((a) => `<li>${E.escapeHtml(a)}</li>`).join('')}</ol>
    <p class="card-foot">Synthetic reference classroom ${E.escapeHtml(E.getPreset(state.presetId).name)}. Educational estimate from a simplified physics model, not a measurement from a real classroom and not ventilation-system design guidance. Generated offline by VentiLab.</p>`;
}

function renderCharts() {
  V.drawClassroom($('classCanvas'), {
    ...state,
    co2Peak: evaluated.metrics.co2Peak,
    pmMean: evaluated.metrics.pmMean,
    qNatural: evaluated.metrics.qNatural,
    qInfiltration: evaluated.metrics.qInfiltration,
    ecaTotal: evaluated.metrics.ecaTotal,
    ecaACH: evaluated.metrics.ecaACH,
  });
  V.drawTrend($('trendCanvas'), evaluated.run, hoverIndex, evaluated.baseline, evaluated.params.schedule);
  renderPareto();
}

function recompute() {
  const params = physicsParams();
  evaluated = E.evaluateScenario(params);
  optimization = E.optimizeRetrofits(params);
  verification = E.verifyAnalytics(params);
  convergence = E.convergenceCheck(params);
  if (selectedIntervention >= optimization.affordable.length) selectedIntervention = -1;
  renderMetrics();
  renderTable();
  renderVerification();
  renderCharts();
  renderActionCard();
}

function applyPreset(id, overrides = {}) {
  const preset = E.getPreset(id);
  state.presetId = preset.id;
  Object.assign(state, preset.params, overrides);
  state.masks = false;
  selectedIntervention = -1;
  hoverIndex = null;
  hoverPareto = null;
  syncControls();
  recompute();
}

function renderExperiments() {
  $('expRow').innerHTML = E.EXPERIMENTS.map(
    (exp) => `<button type="button" class="exp-btn" data-exp="${exp.id}">${E.escapeHtml(exp.name)}</button>`,
  ).join('');
  for (const button of $('expRow').querySelectorAll('.exp-btn')) {
    button.addEventListener('click', () => {
      const exp = E.getExperiment(button.dataset.exp);
      if (!exp) return;
      applyPreset(exp.presetId, exp.overrides);
      for (const b of $('expRow').querySelectorAll('.exp-btn')) b.classList.toggle('is-active', b === button);
      $('expNote').textContent = exp.watch;
      showToast(`Experiment loaded: ${exp.name}`);
    });
  }
}

function readHash() {
  const result = E.decodeShare(window.location.hash || '');
  if (result.ok) {
    Object.assign(state, result.state);
    state.masks = false;
    syncControls();
    recompute();
    showToast('Shared scenario loaded');
  } else if (window.location.hash && window.location.hash.length > 1) {
    showToast('Share link rejected. Parameters were invalid');
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

function bindControls() {
  for (const id of Object.keys(CONTROL_MAP)) {
    const el = $(id);
    el.addEventListener('input', () => {
      const engineKey = id === 'wind' ? 'windSpeed' : id;
      state[engineKey] = CONTROL_MAP[id](el.value);
      selectedIntervention = -1;
      syncControls();
      recompute();
    });
  }
  for (const radio of document.querySelectorAll('input[name="windowMode"]')) {
    radio.addEventListener('change', () => {
      state.windowMode = radio.value;
      selectedIntervention = -1;
      recompute();
    });
  }
  for (const id of ['merv13', 'uvgi', 'masks']) {
    $(id).addEventListener('change', (event) => {
      state[id] = event.target.checked;
      selectedIntervention = -1;
      recompute();
    });
  }
  $('presetSelect').addEventListener('change', (event) => {
    for (const b of $('expRow').querySelectorAll('.exp-btn')) b.classList.remove('is-active');
    applyPreset(event.target.value);
  });
  $('resetBtn').addEventListener('click', () => applyPreset('standard28'));
  $('shareBtn').addEventListener('click', async () => {
    const hash = E.encodeShare({ ...state, presetId: state.presetId });
    const url = `${window.location.origin}${window.location.pathname}${window.location.search}${hash}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Share link copied to clipboard');
    } catch {
      showToast('Share link generated in the address bar');
    }
    history.replaceState(null, '', hash);
  });
  $('printBtn').addEventListener('click', () => window.print());
  $('inspApply').addEventListener('click', () => {
    if (selectedIntervention >= 0) applyIntervention(selectedIntervention);
    else {
      const inspected = inspectedOption();
      if (inspected) applyIntervention(inspected.index);
    }
  });
  $('tableToggle').addEventListener('click', (event) => {
    const table = $('dataTable');
    table.hidden = !table.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!table.hidden));
    event.currentTarget.textContent = table.hidden ? 'Table view' : 'Hide table';
  });

  const trendCanvas = $('trendCanvas');
  const trendTooltip = $('chartTooltip');
  trendCanvas.addEventListener('pointermove', (event) => {
    hoverIndex = V.trendIndexFromEvent(trendCanvas, event, evaluated.run);
    if (hoverIndex === null) { trendTooltip.hidden = true; }
    else {
      const i = hoverIndex;
      trendTooltip.innerHTML = `<strong>${fmt(evaluated.run.times[i])} min</strong>
        <div class="tt-row"><span>CO2</span><span>${fmt(evaluated.run.co2[i])} ppm</span></div>
        <div class="tt-row"><span>PM2.5</span><span>${fmt(evaluated.run.pm[i], 1)} ug/m3</span></div>
        <div class="tt-row"><span>Wells-Riley</span><span>${fmt(evaluated.run.risk[i], 2)}%</span></div>`;
      const rect = trendCanvas.getBoundingClientRect();
      const x = Math.min(event.clientX - rect.left + 14, rect.width - 190);
      trendTooltip.style.left = `${Math.max(4, x)}px`;
      trendTooltip.style.top = `${Math.max(4, event.clientY - rect.top - 20)}px`;
      trendTooltip.hidden = false;
    }
    V.drawTrend(trendCanvas, evaluated.run, hoverIndex, evaluated.baseline, evaluated.params.schedule);
  });
  trendCanvas.addEventListener('pointerleave', () => {
    hoverIndex = null;
    trendTooltip.hidden = true;
    V.drawTrend(trendCanvas, evaluated.run, null, evaluated.baseline, evaluated.params.schedule);
  });

  const paretoCanvas = $('paretoCanvas');
  const paretoTooltip = $('paretoTooltip');
  paretoCanvas.addEventListener('pointermove', (event) => {
    hoverPareto = V.paretoIndexFromEvent(paretoCanvas, event, optimization.affordable);
    if (hoverPareto === null) { paretoTooltip.hidden = true; }
    else {
      const p = optimization.affordable[hoverPareto];
      paretoTooltip.innerHTML = `<strong>${E.escapeHtml(describeOption(p))}</strong>
        <div class="tt-row"><span>Cost</span><span>$${fmt(p.cost)}</span></div>
        <div class="tt-row"><span>Risk left</span><span>${fmt(p.riskRemaining, 1)}%</span></div>
        <div class="tt-row"><span>Device CADR</span><span>${fmt(p.quantaCADR)} m3/h</span></div>
        <div class="tt-row"><span>Noise</span><span>${fmt(p.dBA, 0)} dBA</span></div>`;
      const rect = paretoCanvas.getBoundingClientRect();
      paretoTooltip.style.left = `${Math.min(Math.max(4, event.clientX - rect.left + 12), rect.width - 200)}px`;
      paretoTooltip.style.top = `${Math.max(4, event.clientY - rect.top - 20)}px`;
      paretoTooltip.hidden = false;
    }
    V.drawPareto(paretoCanvas, optimization.affordable, optimization.frontier, selectedIntervention, hoverPareto);
    renderInspector();
  });
  paretoCanvas.addEventListener('pointerleave', () => {
    hoverPareto = null;
    paretoTooltip.hidden = true;
    V.drawPareto(paretoCanvas, optimization.affordable, optimization.frontier, selectedIntervention, null);
    renderInspector();
  });
  paretoCanvas.addEventListener('click', (event) => {
    const index = V.paretoIndexFromEvent(paretoCanvas, event, optimization.affordable);
    if (index !== null) selectIntervention(index);
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderCharts, 90);
  });
  window.addEventListener('hashchange', readHash);
}

renderExperiments();
syncControls();
bindControls();
recompute();
readHash();

// Small test hook used for coordinate verification only.
window.VentiLab = {
  state,
  get metrics() { return evaluated && evaluated.metrics; },
  get verification() { return verification; },
  get convergence() { return convergence; },
  get optimization() { return optimization; },
  recompute,
};
