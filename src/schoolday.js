/**
 * Full school-day occupancy schedule simulator: 8:00 AM to 3:30 PM.
 *
 * Runs the same coupled CO2 / unit-source-quanta / PM2.5 model as the main
 * workbench across a fixed 14-block day (periods, passing time, recess,
 * lunch, dismissal). Threshold exceedance minutes above the CO2 monitoring
 * levels are computed exactly from the closed-form piecewise exponentials,
 * not by counting chart samples.
 */
import {
  normalizeParams,
  baselineParams,
  ventilationRates,
  occupancyAt,
  simulate,
  escapeHtml,
} from './engine.js';
import { resolveRetrofit } from './retrofit.js';

const EPS = 1e-9;

/** 8:00 AM is t=0; 3:30 PM is t=450. Occupancy is a fraction of full class. */
export const SCHOOL_DAY_SCHEDULE = Object.freeze([
  Object.freeze({ start: 0, end: 50, label: 'Period 1', occupancy: 1 }),
  Object.freeze({ start: 50, end: 55, label: 'Passing', occupancy: 0.35 }),
  Object.freeze({ start: 55, end: 105, label: 'Period 2', occupancy: 1 }),
  Object.freeze({ start: 105, end: 110, label: 'Passing', occupancy: 0.35 }),
  Object.freeze({ start: 110, end: 160, label: 'Period 3', occupancy: 1 }),
  Object.freeze({ start: 160, end: 175, label: 'Recess', occupancy: 0.1 }),
  Object.freeze({ start: 175, end: 225, label: 'Period 4', occupancy: 1 }),
  Object.freeze({ start: 225, end: 255, label: 'Lunch', occupancy: 0.2 }),
  Object.freeze({ start: 255, end: 305, label: 'Period 5', occupancy: 1 }),
  Object.freeze({ start: 305, end: 310, label: 'Passing', occupancy: 0.35 }),
  Object.freeze({ start: 310, end: 360, label: 'Period 6', occupancy: 1 }),
  Object.freeze({ start: 360, end: 365, label: 'Passing', occupancy: 0.35 }),
  Object.freeze({ start: 365, end: 415, label: 'Period 7', occupancy: 1 }),
  Object.freeze({ start: 415, end: 450, label: 'Dismissal', occupancy: 0 }),
]);

export const SCHOOL_DAY_MINUTES = 450;
export const SCHOOL_DAY_START = '8:00 AM';
export const SCHOOL_DAY_END = '3:30 PM';
export const CO2_THRESHOLDS = Object.freeze([800, 1000]);

/** Wall-clock label for a minute offset from 8:00 AM, e.g. 95 -> '9:35 AM'. */
export function schoolDayClock(minute) {
  const total = 8 * 60 + Math.round(minute);
  const h24 = Math.floor(total / 60) % 24;
  const m = total % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

/**
 * Exact measure of {t : C(t) > threshold} inside one span of the closed-form
 * CO2 trajectory, plus the crossing intervals for chart shading. Within a
 * span C(t) = css + (c0 - css) exp(-rate t), or c0 + source t when the
 * exchange rate is ~0. Both forms are monotonic, so each span contributes at
 * most one contiguous above-threshold interval.
 */
function spanExceedance(c0, c1, css, rate, source, spanMin, threshold) {
  const hi = Math.max(c0, c1);
  const lo = Math.min(c0, c1);
  if (hi <= threshold) return { minutes: 0, interval: null };
  if (lo > threshold) return { minutes: spanMin, interval: [0, spanMin] };
  let tc;
  if (rate <= EPS) {
    if (Math.abs(source) <= EPS) return { minutes: 0, interval: null };
    tc = ((threshold - c0) / source) * 60;
  } else {
    const ratio = (threshold - css) / (c0 - css);
    if (!(ratio > 0)) return { minutes: 0, interval: null };
    tc = (-Math.log(ratio) / rate) * 60;
  }
  if (!(tc >= 0)) return { minutes: 0, interval: null };
  if (tc >= spanMin) {
    // The crossing lands at or beyond the span end: the whole span stays on
    // the same side of the threshold as its start.
    return c0 > threshold
      ? { minutes: spanMin, interval: [0, spanMin] }
      : { minutes: 0, interval: null };
  }
  return c0 < c1
    ? { minutes: spanMin - tc, interval: [tc, spanMin] }
    : { minutes: tc, interval: [0, tc] };
}

/**
 * Exact minutes above each CO2 threshold over the scenario's schedule,
 * with the crossing intervals and the day peak. Uses the same closed-form
 * span coefficients as the simulator, so results match the RK4 curve to
 * solver tolerance without depending on sampling density.
 */
export function co2ThresholdExceedance(input = {}, thresholds = CO2_THRESHOLDS) {
  const p = normalizeParams(input);
  const vent = ventilationRates(p);
  const qExchange = vent.qNatural + p.mechOA + vent.qInfiltration;
  const rate = qExchange / p.volume;
  const duration = p.durationMin;
  const bounds = p.schedule
    .flatMap((s) => [s.start, s.end])
    .filter((t) => t > 0 && t < duration);
  const nodes = [...new Set([0, duration, ...bounds])].sort((a, b) => a - b);
  const minutes = {};
  const intervals = {};
  for (const th of thresholds) {
    minutes[th] = 0;
    intervals[th] = [];
  }
  let c = p.co2Start;
  let peak = c;
  let peakTime = 0;
  for (let n = 0; n < nodes.length - 1; n += 1) {
    const a = nodes[n];
    const b = nodes[n + 1];
    const spanMin = b - a;
    if (spanMin <= EPS) continue;
    const occ = occupancyAt((a + b) / 2, p);
    const source = (occ * p.students * p.co2Generation * 1000) / p.volume;
    const css = rate > EPS ? p.outdoorCO2 + source / rate : Infinity;
    const spanHours = spanMin / 60;
    const c1 = rate > EPS
      ? css + (c - css) * Math.exp(-rate * spanHours)
      : c + source * spanHours;
    for (const th of thresholds) {
      const part = spanExceedance(c, c1, css, rate, source, spanMin, th);
      minutes[th] += part.minutes;
      if (part.interval) intervals[th].push([a + part.interval[0], a + part.interval[1]]);
    }
    if (c1 > peak + EPS) {
      peak = c1;
      peakTime = b;
    }
    c = c1;
  }
  return { minutes, intervals, peak, peakTime, final: c };
}

/**
 * Before-versus-after report over the school day. `before` is the as-is
 * room (closed windows, no added devices); `after` resolves the chosen
 * retrofit id (default 'custom': the live control settings). Series come
 * from the RK4 simulator; exceedance minutes come from the closed-form
 * solver.
 */
export function schoolDayReport(input = {}, retrofitId = 'custom') {
  const p = normalizeParams(input);
  const simOpts = { schedule: SCHOOL_DAY_SCHEDULE, durationMin: SCHOOL_DAY_MINUTES, stepMin: 1, sampleMin: 2 };
  const beforeParams = normalizeParams({ ...baselineParams(p), ...simOpts });
  const afterResolved = typeof retrofitId === 'string'
    ? resolveRetrofit(p, retrofitId)
    : normalizeParams(retrofitId);
  const afterParams = normalizeParams({ ...afterResolved, ...simOpts });
  const before = simulate(beforeParams);
  const after = simulate(afterParams);
  const excBefore = co2ThresholdExceedance(beforeParams);
  const excAfter = co2ThresholdExceedance(afterParams);

  const peakIn = (times, values, a, b) => {
    let pk = -Infinity;
    for (let i = 0; i < times.length; i += 1) {
      if (times[i] >= a - EPS && times[i] <= b + EPS && values[i] > pk) pk = values[i];
    }
    return pk;
  };
  const periods = SCHOOL_DAY_SCHEDULE.map((block) => ({
    label: block.label,
    start: block.start,
    end: block.end,
    clockStart: schoolDayClock(block.start),
    occupancy: block.occupancy,
    co2BeforePeak: peakIn(before.times, before.co2, block.start, block.end),
    co2AfterPeak: peakIn(after.times, after.co2, block.start, block.end),
  }));

  return {
    schedule: SCHOOL_DAY_SCHEDULE,
    minutes: SCHOOL_DAY_MINUTES,
    startLabel: SCHOOL_DAY_START,
    endLabel: SCHOOL_DAY_END,
    retrofitId,
    before: { times: before.times, co2: before.co2, quanta: before.quanta, pm: before.pm },
    after: { times: after.times, co2: after.co2, quanta: after.quanta, pm: after.pm },
    exceedance: { before: excBefore, after: excAfter },
    periods,
    metrics: {
      before: { co2Peak: before.metrics.co2Peak, riskFinal: before.metrics.riskFinal, pmMean: before.metrics.pmMean, ecaACH: before.metrics.ecaACH },
      after: { co2Peak: after.metrics.co2Peak, riskFinal: after.metrics.riskFinal, pmMean: after.metrics.pmMean, ecaACH: after.metrics.ecaACH },
    },
  };
}

const SVG_COLORS = {
  co2Before: '#7d95c9',
  co2After: '#2a78d6',
  aerBefore: '#e9b08c',
  aerAfter: '#eb6834',
  grid: '#dce6e0',
  ink: '#10231d',
  ink3: '#5f726a',
  band: 'rgba(214,225,219,0.45)',
  t800: '#c98f12',
  t1000: '#d03b3b',
};

function pathFrom(times, values, x, y) {
  let d = '';
  for (let i = 0; i < times.length; i += 1) {
    d += `${i === 0 ? 'M' : 'L'}${x(times[i]).toFixed(1)},${y(values[i]).toFixed(1)}`;
  }
  return d;
}

/**
 * Pure SVG markup for the school-day comparison chart. Interactive layers
 * (hover guide, tooltip) are bound by the app on top of this static markup;
 * everything here is deterministic for a given report.
 */
export function schoolDaySvg(report, { width = 1000, height = 380 } = {}) {
  const m = { l: 56, r: 64, t: 30, b: 46 };
  const pw = Math.max(10, width - m.l - m.r);
  const ph = Math.max(10, height - m.t - m.b);
  const x = (t) => m.l + (t / report.minutes) * pw;
  const maxCO2 = Math.max(
    1200,
    Math.ceil(Math.max(...report.before.co2, ...report.after.co2, 1) / 400) * 400,
  );
  const maxAer = Math.max(
    0.02,
    Math.max(...report.before.quanta, ...report.after.quanta, 0) * 1.15,
  );
  const yCO2 = (v) => m.t + ph - (v / maxCO2) * ph;
  const yAer = (v) => m.t + ph - (v / maxAer) * ph;
  const parts = [];
  parts.push(`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="School day CO2 and aerosol curves before and after retrofit" xmlns="http://www.w3.org/2000/svg">`);

  // Low-occupancy bands with short labels.
  for (const block of report.schedule) {
    if (block.occupancy >= 0.5) continue;
    const bx = x(block.start);
    const bw = x(block.end) - bx;
    if (bw <= 1) continue;
    parts.push(`<rect x="${bx.toFixed(1)}" y="${m.t}" width="${bw.toFixed(1)}" height="${ph}" fill="${SVG_COLORS.band}"/>`);
    parts.push(`<text x="${(bx + bw / 2).toFixed(1)}" y="${m.t + 10}" text-anchor="middle" font-size="9" fill="${SVG_COLORS.ink3}">${escapeHtml(block.label)}</text>`);
  }

  // Gridlines and axes.
  for (let i = 0; i <= 4; i += 1) {
    const y = m.t + (ph * i) / 4;
    parts.push(`<line x1="${m.l}" y1="${y.toFixed(1)}" x2="${m.l + pw}" y2="${y.toFixed(1)}" stroke="${SVG_COLORS.grid}"/>`);
    parts.push(`<text x="${m.l - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${SVG_COLORS.ink3}">${Math.round(maxCO2 * (1 - i / 4))}</text>`);
    const aer = maxAer * (1 - i / 4);
    parts.push(`<text x="${m.l + pw + 8}" y="${(y + 3).toFixed(1)}" text-anchor="start" font-size="10" fill="${SVG_COLORS.aerAfter}">${aer >= 0.01 ? aer.toFixed(3) : aer.toExponential(1)}</text>`);
  }
  for (let t = 0; t <= report.minutes; t += 60) {
    parts.push(`<line x1="${x(t).toFixed(1)}" y1="${m.t}" x2="${x(t).toFixed(1)}" y2="${m.t + ph}" stroke="${SVG_COLORS.grid}"/>`);
    parts.push(`<text x="${x(t).toFixed(1)}" y="${m.t + ph + 16}" text-anchor="middle" font-size="10" fill="${SVG_COLORS.ink3}">${escapeHtml(schoolDayClock(t))}</text>`);
  }

  // Threshold exceedance bands along the top of the plot.
  const bandRow = { before: 0, after: 9 };
  for (const [series, row] of [['before', bandRow.before], ['after', bandRow.after]]) {
    const ex = report.exceedance[series];
    for (const [th, color] of [[800, SVG_COLORS.t800], [1000, SVG_COLORS.t1000]]) {
      for (const [a, b] of ex.intervals[th] || []) {
        parts.push(`<rect x="${x(a).toFixed(1)}" y="${m.t - 14 + row}" width="${Math.max(1, x(b) - x(a)).toFixed(1)}" height="6" fill="${color}" opacity="0.55"><title>${escapeHtml(series)} above ${th} ppm, ${schoolDayClock(a)} to ${schoolDayClock(b)}</title></rect>`);
      }
    }
  }

  // CO2 guide lines.
  for (const [th, color] of [[800, SVG_COLORS.t800], [1000, SVG_COLORS.t1000]]) {
    if (th > maxCO2) continue;
    const y = yCO2(th);
    parts.push(`<line x1="${m.l}" y1="${y.toFixed(1)}" x2="${m.l + pw}" y2="${y.toFixed(1)}" stroke="${color}" stroke-dasharray="6,4"/>`);
    parts.push(`<text x="${m.l + pw - 6}" y="${(y - 6).toFixed(1)}" text-anchor="end" font-size="10" font-weight="650" fill="${color}">CO2 ${th} ppm</text>`);
  }

  // Curves: before dashed, after solid; CO2 left axis, aerosol right axis.
  const series = [
    { times: report.before.times, data: report.before.co2, y: yCO2, color: SVG_COLORS.co2Before, dash: '7,5', name: 'CO2 before' },
    { times: report.after.times, data: report.after.co2, y: yCO2, color: SVG_COLORS.co2After, name: 'CO2 after' },
    { times: report.before.times, data: report.before.quanta, y: yAer, color: SVG_COLORS.aerBefore, dash: '5,5', name: 'aerosol before' },
    { times: report.after.times, data: report.after.quanta, y: yAer, color: SVG_COLORS.aerAfter, name: 'aerosol after' },
  ];
  for (const s of series) {
    parts.push(`<path d="${pathFrom(s.times, s.data, x, s.y)}" fill="none" stroke="${s.color}" stroke-width="2"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}><title>${escapeHtml(s.name)}</title></path>`);
  }

  // Axis labels.
  parts.push(`<text x="${m.l}" y="${m.t - 20}" font-size="10" font-weight="700" fill="${SVG_COLORS.co2After}">CO2 ppm</text>`);
  parts.push(`<text x="${m.l + pw}" y="${m.t - 20}" text-anchor="end" font-size="10" font-weight="700" fill="${SVG_COLORS.aerAfter}">aerosol quanta/m3</text>`);
  parts.push(`<text x="${m.l + pw / 2}" y="${height - 6}" text-anchor="middle" font-size="10" fill="${SVG_COLORS.ink3}">${escapeHtml(report.startLabel)} to ${escapeHtml(report.endLabel)}</text>`);
  parts.push(`<line x1="${m.l}" y1="${m.t + ph}" x2="${m.l + pw}" y2="${m.t + ph}" stroke="${SVG_COLORS.ink3}"/>`);
  parts.push('</svg>');
  return parts.join('');
}
