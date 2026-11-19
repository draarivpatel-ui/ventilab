/**
 * VentiLab application controller. Wires controls, physics engine, charts,
 * share codec and print card. Only DOM APIs and local modules are used.
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
  const isValid = Number.isFinite(m.co2Peak) && Number.isFinite(m.pmMean) && Number.isFinite(m.riskFinal);
  const status = !isValid ? 'Solver error' : m.co2Peak >= 1500 ? 'High CO2 load' : m.co2Peak >= 1000 ? 'Elevated CO2' : 'Good air quality';
  const chip = $('statusChip');
  chip.textContent = status;
  chip.className = `status-chip${!isValid || m.co2Peak >= 1500 ? ' chip-alert' : ''}`;
  $('metricGrid').innerHTML = [
    metricCard('CO2 peak', fmt(m.co2Peak), 'ppm', (m.co2Peak / 2500) * 100, '', 'six-hour maximum'),
    metricCard('PM2.5 indoor mean', fmt(m.pmMean, 1), 'ug/m3', (m.pmMean / 200) * 100, 'is-particles', 'six-hour mean'),
    metricCard('Wells-Riley risk', fmt(m.riskFinal, 1), '%', m.riskFinal, 'is-risk', 'end of day'),
    metricCard('Risk reduction', fmt(m.riskReduction, 1), '% vs closed baseline', m.riskReduction, 'is-money', 'same class, no retrofit'),
    metricCard('Clean airflow', fmt(m.ecaTotal), 'm3/h equivalent', Math.min(100, (m.ecaPerPersonLps / 15) * 100), '', `${fmt(m.ecaPerPersonLps, 1)} L/s per person`),
    metricCard('Natural ventilation', fmt(m.qNatural), 'm3/h', Math.min(100, (m.qNatural / 2000) * 100), '', 'wind and stack estimate'),
    metricCard('Retrofit cost', `$${fmt(m.cost)}`, 'one-time estimate', Math.min(100, (m.cost / 4000) * 100), 'is-money', 'for selected devices'),
    metricCard('Device power', fmt(m.watts), 'W', Math.min(100, (m.watts / 500) * 100), '', `${fmt(m.dBA, 0)} dBA combined`),
  ].join('');
  const threshold = m.co2Peak >= 1000 ? 'above' : 'below';
  $('metricCaption').textContent = `Peak CO2 is ${threshold} the 1,000 ppm teaching guide. Equivalent clean airflow is ${fmt(m.ecaPerPersonLps, 1)} L/s per student; the ASHRAE 241 reference target shown on the chart is 800 ppm.`;
  $('diagramCaption').textContent = state.windowMode === 'closed'
    ? `Windows closed. Incoming mechanical outdoor air is ${fmt(state.mechOA)} m3/h; filtration recirculates indoor air but does not remove the body-generated CO2.`
    : `${state.windowMode === 'cross' ? 'Cross' : 'Single-sided'} ventilation at ${Math.round(state.windowOpen * 100)}% opening contributes ${fmt(m.qNatural)} m3/h of outdoor air.`;
}

function renderTable() {
  const rows = evaluated.run.times.map((t, i) => `<tr><td>${fmt(t)}</td><td>${fmt(evaluated.run.co2[i])}</td><td>${fmt(evaluated.run.pm[i], 1)}</td><td>${fmt(evaluated.run.risk[i], 2)}</td></tr>`).join('');
  $('dataTable').innerHTML = `<table><thead><tr><th>Time (min)</th><th>CO2 (ppm)</th><th>PM2.5 (ug/m3)</th><th>Risk (%)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function describeOption(option) {
  const parts = [];
  if (option.params.windowMode !== 'closed') parts.push(`${option.params.windowMode} windows ${Math.round(option.params.windowOpen * 100)}%`);
  if (option.params.crBoxes) parts.push(`${option.params.crBoxes} fan box${option.params.crBoxes > 1 ? 'es' : ''}`);
  if (option.params.hepaUnits) parts.push(`${option.params.hepaUnits} HEPA`);
  if (option.params.merv13) parts.push('MERV-13');
  if (option.params.uvgi) parts.push('UVGI');
  return parts.length ? parts.join(' + ') : 'No retrofit (baseline)';
}

function renderPareto() {
  const affordable = optimization.affordable;
  const frontier = optimization.frontier;
  $('paretoCaption').textContent = `${frontier.length} exact Pareto-optimal options from ${affordable.length} affordable configurations. Every point on the frontier is unbeatable on all six objectives at once.`;
  const cards = frontier.slice(0, 6).map((p) => {
    const index = affordable.indexOf(p);
    return `<button type="button" class="intervention${index === selectedIntervention ? ' is-active' : ''}" data-index="${index}" aria-pressed="${index === selectedIntervention}">
      <div class="intervention-title">${E.escapeHtml(describeOption(p))}</div>
      <div class="intervention-sub">$${fmt(p.cost)} - risk ${fmt(p.riskRemaining, 1)}% - ${fmt(p.dBA, 0)} dBA - ${fmt(p.co2Peak)} ppm CO2 - ${fmt(p.pmMean, 1)} ug/m3 PM</div>
    </button>`;
  }).join('');
  $('interventionList').innerHTML = cards || '<p class="viz-caption">No option fits the selected budget. Raise the budget to explore retrofits.</p>';
  for (const button of $('interventionList').querySelectorAll('.intervention')) {
    button.addEventListener('click', () => applyIntervention(Number(button.dataset.index)));
  }
  V.drawPareto($('paretoCanvas'), affordable, frontier, selectedIntervention);
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
  $('verifyChip').textContent = v.passed ? 'PASS' : 'CHECK FAILED';
  $('verifyChip').className = `status-chip ${v.passed ? 'chip-good' : ''}`;
  $('verifyGrid').innerHTML = `
    <div class="verify-item"><span>CO2 RK4 vs closed form</span><strong>${v.co2RmsePercent.toExponential(2)}%</strong></div>
    <div class="verify-item"><span>PM2.5 RMSE</span><strong>${v.pmRmseUg.toExponential(2)} ug/m3</strong></div>
    <div class="verify-item"><span>Integrated quanta</span><strong>${v.quantaRmse.toExponential(2)}</strong></div>
    <div class="verify-item"><span>CO2 time constant</span><strong>${fmt(v.timeConstantHours, 2)} h</strong></div>
    <div class="verify-item"><span>Approach after one tau</span><strong>${fmt(v.approachFraction * 100, 1)}%</strong></div>
    <div class="verify-item"><span>PM indoor/outdoor ratio</span><strong>${fmt(v.pmRatio, 3)}</strong></div>`;
}

function renderActionCard() {
  const m = evaluated.metrics;
  const top = optimization.recommended;
  const recommendation = top ? `${describeOption(top)} (${fmt(top.riskReduction, 0)}% lower risk)` : 'No retrofit within budget';
  const actions = [
    `Track CO2: aim to keep it under ${fmt(Math.min(m.co2Peak, 1000))} ppm during class.`,
    state.outdoorPM > 80
      ? 'Wildfire day: keep windows closed and run filtered recirculation; outdoor PM2.5 is high.'
      : `Use ${state.windowMode === 'closed' ? 'short mid-class window breaks' : `${Math.round(state.windowOpen * 100)}% window opening`} when outdoor air is clean.`,
    top && top.cost > 0 ? `Budget priority: ${recommendation}.` : 'No new purchase needed: timing and window use come first.',
    'Recheck the numbers after changing seats, occupancy or weather.',
  ];
  $('actionCard').innerHTML = `
    <p class="card-title">Clean-Air Action Card</p>
    <p class="card-sub">Synthetic reference classroom: ${E.escapeHtml(E.getPreset(state.presetId).name)}</p>
    <div class="card-grid">
      <div class="card-cell"><span>CO2 peak</span><strong>${fmt(m.co2Peak)} ppm</strong></div>
      <div class="card-cell"><span>Indoor PM2.5</span><strong>${fmt(m.pmMean, 1)} ug/m3</strong></div>
      <div class="card-cell"><span>Airborne risk</span><strong>${fmt(m.riskFinal, 1)}%</strong></div>
      <div class="card-cell"><span>Budget</span><strong>$${fmt(state.budget)}</strong></div>
    </div>
    <ol class="card-steps">${actions.map((a) => `<li>${E.escapeHtml(a)}</li>`).join('')}</ol>
    <p class="card-foot">Educational estimate from a simplified physics model. Not a measurement from a real classroom and not ventilation-system design guidance. Generated offline by VentiLab.</p>`;
}

function renderCharts() {
  V.drawClassroom($('classCanvas'), {
    ...state,
    co2Peak: evaluated.metrics.co2Peak,
    qNatural: evaluated.metrics.qNatural,
    ecaTotal: evaluated.metrics.ecaTotal,
  });
  V.drawTrend($('trendCanvas'), evaluated.run, hoverIndex);
  renderPareto();
}

function recompute() {
  const params = physicsParams();
  evaluated = E.evaluateScenario(params);
  optimization = E.optimizeRetrofits(params);
  verification = E.verifyAnalytics(params);
  if (selectedIntervention >= optimization.affordable.length) selectedIntervention = -1;
  renderMetrics();
  renderTable();
  renderVerification();
  renderCharts();
  renderActionCard();
}

function applyPreset(id) {
  const preset = E.getPreset(id);
  state.presetId = preset.id;
  Object.assign(state, preset.params);
  state.masks = false;
  selectedIntervention = -1;
  hoverIndex = null;
  syncControls();
  recompute();
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
    showToast('Share link rejected: invalid parameters');
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
  $('presetSelect').addEventListener('change', (event) => applyPreset(event.target.value));
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
    V.drawTrend(trendCanvas, evaluated.run, hoverIndex);
  });
  trendCanvas.addEventListener('pointerleave', () => {
    hoverIndex = null;
    trendTooltip.hidden = true;
    V.drawTrend(trendCanvas, evaluated.run, null);
  });

  const paretoCanvas = $('paretoCanvas');
  const paretoTooltip = $('paretoTooltip');
  paretoCanvas.addEventListener('pointermove', (event) => {
    hoverPareto = V.paretoIndexFromEvent(paretoCanvas, event, optimization.affordable);
    if (hoverPareto === null) { paretoTooltip.hidden = true; return; }
    const p = optimization.affordable[hoverPareto];
    paretoTooltip.innerHTML = `<strong>${E.escapeHtml(describeOption(p))}</strong>
      <div class="tt-row"><span>Cost</span><span>$${fmt(p.cost)}</span></div>
      <div class="tt-row"><span>Risk left</span><span>${fmt(p.riskRemaining, 1)}%</span></div>
      <div class="tt-row"><span>Power</span><span>${fmt(p.watts)} W</span></div>
      <div class="tt-row"><span>Noise</span><span>${fmt(p.dBA, 0)} dBA</span></div>`;
    const rect = paretoCanvas.getBoundingClientRect();
    paretoTooltip.style.left = `${Math.min(Math.max(4, event.clientX - rect.left + 12), rect.width - 200)}px`;
    paretoTooltip.style.top = `${Math.max(4, event.clientY - rect.top - 20)}px`;
    paretoTooltip.hidden = false;
  });
  paretoCanvas.addEventListener('pointerleave', () => { paretoTooltip.hidden = true; });
  paretoCanvas.addEventListener('click', (event) => {
    const index = V.paretoIndexFromEvent(paretoCanvas, event, optimization.affordable);
    if (index !== null) applyIntervention(index);
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderCharts, 90);
  });
  window.addEventListener('hashchange', readHash);
}

syncControls();
bindControls();
recompute();
readHash();

// Small test hook used for coordinate verification only.
window.VentiLab = {
  state,
  get metrics() { return evaluated && evaluated.metrics; },
  get verification() { return verification; },
  recompute,
};
