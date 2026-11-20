/**
 * Canvas renderers for VentiLab. No dependencies. Every renderer reads colors
 * from CSS custom properties so the validated palette lives in one place.
 */

const css = (name, fallback) => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.width * (canvas.dataset.ratio ? Number(canvas.dataset.ratio) : rect.height / rect.width || 0.4));
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

export function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function label(ctx, text, x, y, color, align = 'left', size = 11, weight = '500') {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function dashedLine(ctx, x1, y1, x2, y2, color, pattern = [5, 5]) {
  ctx.save();
  ctx.setLineDash(pattern);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function hexToRgb(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function mixColor(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const m = ca.map((x, i) => Math.round(x + (cb[i] - x) * t));
  return `${m[0]},${m[1]},${m[2]}`;
}

/** Classroom airflow diagram with window paths, desk grid, plume and devices. */
export function drawClassroom(canvas, state) {
  canvas.dataset.ratio = '0.385';
  const { ctx, width, height } = setupCanvas(canvas);
  const accent = css('--accent', '#14624a');
  const accentWash = css('--accent-wash', '#e5f1eb');
  const ink = css('--ink', '#10231d');
  const ink2 = css('--ink-2', '#40554d');
  const ink3 = css('--ink-3', '#5f726a');
  const line = css('--line', '#d6e1db');
  const surface = css('--surface', '#ffffff');
  const co2 = css('--series-1', '#2a78d6');
  const particle = css('--series-2', '#eb6834');
  const risk = css('--series-3', '#1baf7a');

  const room = { x: 34, y: 34, w: width - 68, h: height - 84 };
  ctx.fillStyle = surface;
  roundRect(ctx, room.x, room.y, room.w, room.h, 10);
  ctx.fill();
  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Daylight band and ceiling.
  ctx.save();
  roundRect(ctx, room.x + 2, room.y + 2, room.w - 4, room.h - 4, 8);
  ctx.clip();
  const sky = ctx.createLinearGradient(0, room.y, 0, room.y + room.h * 0.5);
  sky.addColorStop(0, '#eef7f2');
  sky.addColorStop(1, '#ffffff');
  ctx.fillStyle = sky;
  ctx.fillRect(room.x, room.y, room.w, room.h * 0.5);
  ctx.restore();

  const windowY = room.y + room.h * 0.13;
  const windowW = Math.min(84, room.w * 0.11);
  const windows = [room.x + room.w * 0.08, room.x + room.w * 0.42, room.x + room.w * 0.76];
  const open = state.windowOpen > 0 && state.windowMode !== 'closed';
  for (const wx of windows) {
    ctx.fillStyle = open ? '#d9ebf5' : '#f3f6f4';
    ctx.strokeStyle = open ? accent : line;
    ctx.lineWidth = 2;
    roundRect(ctx, wx, windowY, windowW, 18, 3);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(wx + windowW / 2, windowY);
    ctx.lineTo(wx + windowW / 2, windowY + 18);
    ctx.stroke();
  }

  // Ventilation arrows.
  if (open) {
    const strength = state.windowMode === 'cross' ? 1 : 0.6;
    ctx.strokeStyle = co2;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.35 + 0.45 * state.windowOpen * strength;
    for (const wx of windows) {
      for (let k = 0; k < 3; k += 1) {
        const y = windowY + 34 + k * 18;
        ctx.beginPath();
        ctx.moveTo(wx + windowW * 0.2, y - 6);
        ctx.quadraticCurveTo(wx + windowW * 0.8, y + 4, wx + windowW + 38 * strength, y + 12);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
  if (state.mechOA > 0) {
    const x = room.x + room.w - 30;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, room.y + 12);
    ctx.lineTo(x, room.y + 46);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 5, room.y + 40);
    ctx.lineTo(x, room.y + 46);
    ctx.lineTo(x + 5, room.y + 40);
    ctx.stroke();
  }

  // Desk grid and occupants.
  const cols = Math.min(7, Math.max(3, Math.ceil(Math.sqrt(state.students * 1.4))));
  const rows = Math.max(1, Math.ceil(state.students / cols));
  const deskArea = { x: room.x + 50, y: room.y + room.h * 0.38, w: room.w - 100, h: room.h * 0.44 };
  const shown = Math.min(state.students, cols * rows);
  for (let i = 0; i < shown; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const dx = deskArea.x + (col + 0.5) * (deskArea.w / cols);
    const dy = deskArea.y + (row + 0.5) * (deskArea.h / rows);
    ctx.fillStyle = '#eef2ef';
    ctx.strokeStyle = '#c9d6ce';
    ctx.lineWidth = 1;
    roundRect(ctx, dx - 17, dy - 5, 34, 15, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = accentWash;
    ctx.beginPath();
    ctx.arc(dx, dy - 11, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.stroke();
    if (i === 0 && state.infectious > 0) {
      ctx.strokeStyle = particle;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(dx, dy - 11, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (state.masks) {
      ctx.strokeStyle = ink2;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(dx - 4, dy - 10);
      ctx.lineTo(dx + 4, dy - 10);
      ctx.stroke();
    }
  }
  if (state.infectious > 0) label(ctx, `${state.infectious} source${state.infectious === 1 ? '' : 's'}`, deskArea.x - 46, deskArea.y - 4, particle, 'left', 10, '650');
  if (state.students > shown) label(ctx, `+${state.students - shown} more`, room.x + room.w - 16, deskArea.y + deskArea.h - 10, ink3, 'right', 10);

  // Plume grows with CO2 and shifts toward the particle hue as PM2.5 dominates.
  const co2Rise = Math.max(0, state.co2Peak - state.outdoorCO2);
  const plumeIntensity = Math.min(1, co2Rise / 1800);
  const pmLoad = Math.min(1, Math.max(0, ((state.pmMean || 0) - 15) / 120));
  const plumeRgb = mixColor('#2a78d6', '#eb6834', pmLoad);
  if (plumeIntensity > 0.02 || pmLoad > 0.25) {
    const strength = Math.max(plumeIntensity, pmLoad * 0.9);
    const px = room.x + room.w * 0.5;
    const py = deskArea.y - 8;
    const plume = ctx.createRadialGradient(px, py, 4, px, py, room.w * 0.27);
    plume.addColorStop(0, `rgba(${plumeRgb},${0.2 + 0.28 * strength})`);
    plume.addColorStop(1, `rgba(${plumeRgb},0)`);
    ctx.fillStyle = plume;
    ctx.beginPath();
    ctx.ellipse(px, py - 12, room.w * 0.27, room.h * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Filtration devices.
  const devices = state.crBoxes + state.hepaUnits;
  if (devices > 0) {
    const bx = room.x + room.w - 72;
    for (let i = 0; i < Math.min(devices, 4); i += 1) {
      const by = room.y + room.h - 48 - i * 26;
      ctx.fillStyle = i < state.crBoxes ? '#fff3e8' : '#eef7f2';
      ctx.strokeStyle = i < state.crBoxes ? particle : risk;
      ctx.lineWidth = 1.6;
      roundRect(ctx, bx, by, 34, 20, 3);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx + 4, by + 15);
      ctx.lineTo(bx + 30, by + 5);
      ctx.stroke();
    }
    label(ctx, `${state.crBoxes} fan box${state.crBoxes === 1 ? '' : 'es'}, ${state.hepaUnits} HEPA`, bx - 8, room.y + room.h - 12, ink2, 'right', 10);
  }

  if (state.merv13 || state.uvgi) {
    const tags = [state.merv13 ? 'MERV-13' : '', state.uvgi ? 'UVGI' : ''].filter(Boolean).join(' + ');
    label(ctx, tags, room.x + 16, room.y + room.h - 14, accent, 'left', 11, '700');
  }

  // Legend-like annotations under the room.
  const footerY = room.y + room.h + 22;
  label(ctx, `Ventilation: ${state.qNatural.toFixed(0)} m3/h natural + ${state.mechOA.toFixed(0)} m3/h mechanical + ${(state.qInfiltration || 0).toFixed(0)} m3/h infiltration`, room.x + 2, footerY, ink2, 'left', 11);
  label(ctx, `Equivalent clean airflow: ${state.ecaTotal.toFixed(0)} m3/h (${(state.ecaACH || 0).toFixed(1)} eACH, CDC guide >=5)`, room.x + room.w, footerY, accent, 'right', 11, '700');
}

/**
 * Three-series six-hour chart. Different units are shown as three labeled
 * traces with a shared time axis; reference guides are dashed lines and the
 * closed-window, no-retrofit baseline is drawn as a ghost trace for contrast.
 */
export function drawTrend(canvas, run, hoverIndex, baseline, schedule) {
  canvas.dataset.ratio = '0.404';
  const { ctx, width, height } = setupCanvas(canvas);
  const ink = css('--ink', '#10231d');
  const ink2 = css('--ink-2', '#40554d');
  const ink3 = css('--ink-3', '#5f726a');
  const grid = css('--grid', '#dce6e0');
  const surface = css('--surface', '#ffffff');
  const co2 = css('--series-1', '#2a78d6');
  const particle = css('--series-2', '#eb6834');
  const risk = css('--series-3', '#1baf7a');
  const m = { l: 52, r: 54, t: 22, b: 34 };
  const pw = Math.max(10, width - m.l - m.r);
  const ph = Math.max(10, height - m.t - m.b);
  const maxTime = run.times[run.times.length - 1] || 360;
  const maxCO2 = Math.max(1600, Math.ceil(Math.max(...run.co2, ...(baseline ? baseline.co2 : [0])) / 400) * 400);
  const maxPM = Math.max(50, Math.ceil(Math.max(...run.pm, ...(baseline ? baseline.pm : [0])) / 50) * 50);
  const x = (t) => m.l + (t / maxTime) * pw;
  const yCO2 = (v) => m.t + ph - (v / maxCO2) * ph;
  const yPM = (v) => m.t + ph - (v / maxPM) * ph;
  const yRisk = (v) => m.t + ph - (v / 100) * ph;

  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, width, height);

  // Low-occupancy blocks shaded so peaks read against the class schedule.
  if (Array.isArray(schedule)) {
    ctx.fillStyle = 'rgba(214,225,219,0.38)';
    for (const block of schedule) {
      if (block.occupancy >= 0.5) continue;
      const bx = x(Math.max(0, block.start));
      const bw = x(Math.min(maxTime, block.end)) - bx;
      if (bw > 1) ctx.fillRect(bx, m.t, bw, ph);
    }
  }

  for (let i = 0; i <= 4; i += 1) {
    const y = m.t + (ph * i) / 4;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(m.l, y);
    ctx.lineTo(m.l + pw, y);
    ctx.stroke();
    label(ctx, String(Math.round(maxCO2 * (1 - i / 4))), m.l - 9, y, ink3, 'right', 10);
    label(ctx, String(Math.round(maxPM * (1 - i / 4))), m.l + pw + 9, y, particle, 'left', 10);
  }
  for (let t = 0; t <= maxTime; t += 60) {
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(x(t), m.t);
    ctx.lineTo(x(t), m.t + ph);
    ctx.stroke();
    label(ctx, `${Math.round(t / 60)}h`, x(t), height - 14, ink3, 'center', 10);
  }

  // Reference guides: CO2 monitoring levels on the left axis, PM2.5 on the right.
  const co2Guides = [
    { v: 800, text: 'guide 800', color: css('--good', '#0ca30c') },
    { v: 1000, text: 'check 1000', color: css('--warning', '#fab219') },
    { v: 1500, text: 'poor 1500', color: css('--critical', '#d03b3b') },
  ];
  co2Guides.forEach((g) => {
    if (g.v > maxCO2) return;
    dashedLine(ctx, m.l, yCO2(g.v), m.l + pw, yCO2(g.v), g.color, [6, 4]);
    label(ctx, `CO2 ${g.text}`, m.l + pw - 4, yCO2(g.v) - 8, g.color, 'right', 10, '650');
  });
  const pmGuides = [
    { v: 15, text: 'WHO 24h PM2.5 15', color: '#8a6500', dash: [3, 4] },
    { v: 35, text: 'EPA 24h PM2.5 35', color: css('--serious', '#ec835a'), dash: [8, 3] },
  ];
  pmGuides.forEach((g, gi) => {
    if (g.v > maxPM) return;
    dashedLine(ctx, m.l, yPM(g.v), m.l + pw, yPM(g.v), g.color, g.dash);
    label(ctx, g.text, m.l + 4, yPM(g.v) - 8 - gi * 12, g.color, 'left', 10, '650');
  });

  // Ghost trace: the same classroom with closed windows and no retrofit.
  if (baseline) {
    for (const s of [
      { data: baseline.co2, y: yCO2, color: co2 },
      { data: baseline.risk, y: yRisk, color: risk },
    ]) {
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = 0.38;
      ctx.setLineDash([7, 5]);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      s.data.forEach((v, i) => {
        const px = x(baseline.times[i]);
        const py = s.y(v);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    label(ctx, 'dashed: closed-window baseline', m.l + pw - 4, m.t + 10, ink3, 'right', 10, '650');
  }

  const series = [
    { data: run.co2, y: yCO2, color: co2 },
    { data: run.pm, y: yPM, color: particle },
    { data: run.risk, y: yRisk, color: risk },
  ];
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.data.forEach((v, i) => {
      const px = x(run.times[i]);
      const py = s.y(v);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  // Direct labels at the final point, never a number on every point.
  const last = series.length - 1;
  series.forEach((s, i) => {
    const v = s.data[s.data.length - 1];
    const py = s.y(v);
    ctx.fillStyle = surface;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x(maxTime), py, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const text = i === 0 ? `${Math.round(v)} ppm` : i === 1 ? `${v.toFixed(1)} ug` : `${v.toFixed(1)}%`;
    label(ctx, text, x(maxTime) - 8, py + (i === last ? 13 : -13), s.color, 'right', 10, '700');
  });

  if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < run.times.length) {
    const hx = x(run.times[hoverIndex]);
    dashedLine(ctx, hx, m.t, hx, m.t + ph, 'rgba(64,85,77,0.55)', [4, 4]);
    series.forEach((s) => {
      const py = s.y(s.data[hoverIndex]);
      ctx.fillStyle = surface;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(hx, py, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    label(ctx, `${Math.round(run.times[hoverIndex])} min`, hx, m.t + 8, ink, hx > width - 90 ? 'right' : 'left', 10, '700');
  }
  label(ctx, 'ppm', m.l - 9, m.t - 10, co2, 'right', 10, '700');
  label(ctx, 'ug/m3', m.l + pw + 9, m.t - 10, particle, 'left', 10, '700');
  label(ctx, 'risk %', m.l + pw - 2, height - 14, risk, 'right', 10, '700');
  ctx.strokeStyle = ink3;
  ctx.beginPath();
  ctx.moveTo(m.l, m.t + ph);
  ctx.lineTo(m.l + pw, m.t + ph);
  ctx.stroke();

  canvas._plot = { m, pw, ph, maxTime, x };
  return canvas._plot;
}

/** Cost versus remaining-risk scatter with exact Pareto points highlighted. */
export function drawPareto(canvas, points, frontier, selectedIndex, hoveredIndex) {
  canvas.dataset.ratio = '0.365';
  const { ctx, width, height } = setupCanvas(canvas);
  const ink = css('--ink', '#10231d');
  const ink3 = css('--ink-3', '#5f726a');
  const grid = css('--grid', '#dce6e0');
  const surface = css('--surface', '#ffffff');
  const accent = css('--accent', '#14624a');
  const co2 = css('--series-1', '#2a78d6');
  const m = { l: 54, r: 24, t: 20, b: 40 };
  const pw = Math.max(10, width - m.l - m.r);
  const ph = Math.max(10, height - m.t - m.b);
  const maxCost = Math.max(100, Math.ceil(Math.max(...points.map((p) => p.cost)) / 200) * 200);
  const x = (v) => m.l + (v / maxCost) * pw;
  const y = (v) => m.t + ph - (clamp01(v / 100)) * ph;
  const xf = (px) => ((px - m.l) / pw) * maxCost;
  const yf = (py) => (1 - (py - m.t) / ph) * 100;

  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, width, height);
  for (let i = 0; i <= 4; i += 1) {
    const gy = m.t + (ph * i) / 4;
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(m.l, gy);
    ctx.lineTo(m.l + pw, gy);
    ctx.stroke();
    label(ctx, `${100 - i * 25}%`, m.l - 8, gy, ink3, 'right', 10);
  }
  for (let c = 0; c <= maxCost; c += Math.max(200, Math.ceil(maxCost / 5 / 200) * 200)) {
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(x(c), m.t);
    ctx.lineTo(x(c), m.t + ph);
    ctx.stroke();
    label(ctx, `$${c}`, x(c), height - 14, ink3, 'center', 10);
  }
  label(ctx, 'Remaining transmission risk', m.l + 6, m.t + 10, ink3, 'left', 10);
  label(ctx, 'Retrofit cost (USD)', m.l + pw - 4, m.t + 10, ink3, 'right', 10);

  const frontierSet = new Set(frontier.map((p) => p.label));
  const dominated = points.filter((p) => !frontierSet.has(p.label));
  for (const p of dominated) {
    ctx.fillStyle = 'rgba(159,177,168,0.7)';
    ctx.beginPath();
    ctx.arc(x(p.cost), y(p.riskRemaining), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // Connect the frontier in cost order to make the trade-off legible.
  ctx.strokeStyle = 'rgba(42,120,214,0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  frontier.forEach((p, i) => {
    if (i === 0) ctx.moveTo(x(p.cost), y(p.riskRemaining));
    else ctx.lineTo(x(p.cost), y(p.riskRemaining));
  });
  ctx.stroke();
  frontier.forEach((p) => {
    const idx = points.indexOf(p);
    const isSelected = selectedIndex === idx;
    const isHovered = hoveredIndex === idx;
    ctx.fillStyle = isSelected ? accent : co2;
    ctx.strokeStyle = surface;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x(p.cost), y(p.riskRemaining), isSelected ? 7 : 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (isHovered && !isSelected) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(x(p.cost), y(p.riskRemaining), 9, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
  // Non-frontier points can also be inspected; ring them when hovered.
  if (hoveredIndex !== null && hoveredIndex >= 0 && hoveredIndex < points.length && !frontierSet.has(points[hoveredIndex].label)) {
    const p = points[hoveredIndex];
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x(p.cost), y(p.riskRemaining), 8, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (frontier.length) {
    const best = frontier.reduce((a, b) => (b.riskRemaining < a.riskRemaining ? b : a), frontier[0]);
    ctx.fillStyle = accent;
    ctx.font = '700 10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('lowest risk', x(best.cost) - 8, y(best.riskRemaining) + 4);
  }
  ctx.strokeStyle = ink3;
  ctx.beginPath();
  ctx.moveTo(m.l, m.t + ph);
  ctx.lineTo(m.l + pw, m.t + ph);
  ctx.stroke();

  canvas._plot = { m, pw, ph, x, y, xf, yf, maxCost, points };
  return canvas._plot;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/** Map a pointer event to the nearest sample index, or null when outside. */
export function trendIndexFromEvent(canvas, event, run) {
  const plot = canvas._plot;
  if (!plot) return null;
  const rect = canvas.getBoundingClientRect();
  const cssX = event.clientX - rect.left;
  if (cssX < plot.m.l - 8 || cssX > plot.m.l + plot.pw + 8) return null;
  const t = ((cssX - plot.m.l) / plot.pw) * plot.maxTime;
  let best = 0;
  let bestDist = Infinity;
  run.times.forEach((time, i) => {
    const d = Math.abs(time - t);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

/** Map a pointer event to the nearest frontier point within a generous radius. */
export function paretoIndexFromEvent(canvas, event, points) {
  const plot = canvas._plot;
  if (!plot) return null;
  const rect = canvas.getBoundingClientRect();
  const cssX = event.clientX - rect.left;
  const cssY = event.clientY - rect.top;
  let best = null;
  let bestDist = 16 * 16;
  points.forEach((p, i) => {
    const px = plot.x(p.cost);
    const py = plot.y(p.riskRemaining);
    const d = (px - cssX) ** 2 + (py - cssY) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}
