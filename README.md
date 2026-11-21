# VentiLab

**Live workbench:** [https://aariv.me/ventilab/](https://aariv.me/ventilab/)

**Classroom Clean-Air and Airborne Risk Physics Workbench**

An offline, zero-dependency browser workbench for exploring how ventilation,
filtration and occupancy change classroom air. Built for the UNICEF Clean Air /
Climate Action track at unihacks (ages 13-18).

Everything runs locally: no build step, no packages, no network calls, no fonts
or scripts from external hosts. Open `index.html` through any static file
server, or load it from disk in a browser that permits local ES modules.

## What it does

- Solves the transient CO2 mass balance with a fixed-step **RK4** integrator.
  Integration nodes land exactly on class-period and sampling boundaries, and
  each boundary-bounded span uses its single interior occupancy, so the
  piecewise-constant schedule introduces no order reduction.
- Estimates natural ventilation for single-sided and cross ventilation from
  wind and stack effect (root-sum-square), then adds mechanical outdoor air and
  envelope infiltration to the exchange rate.
- Integrates a **Wells-Riley** dose model with mask efficiency and equivalent
  clean airflow from HEPA, Corsi-Rosenthal fan boxes, MERV-13 and UVGI.
- Tracks indoor **PM2.5** during wildfire smoke with an infiltration/filtration
  mass-balance ODE (70% particle penetration through the envelope).
- Computes an **exact Pareto frontier** over 700 retrofit configurations under
  a budget, across cost, watts, noise, CO2 peak, PM2.5 mean and remaining risk.
- Offers **four one-click guided experiments** (winter closed-window spike,
  wildfire PM2.5 event, Corsi-Rosenthal vs MERV-13, cross-breeze recovery) and
  an inspector panel: click any frontier point to see exact cost, noise, clean
  air delivered, CO2 peak, PM2.5 peak and risk delta versus the baseline.
- Overlays honest reference guides on the trend chart: CO2 monitoring levels at
  800, 1000 and 1500 ppm, WHO 15 and EPA 35 ug/m3 PM2.5 references, a dashed
  closed-window baseline ghost trace, and grey low-occupancy schedule bands.
- Shares scenarios through a strictly validated URL hash and prints a
  classroom action card.
- Runs a **one-at-a-time parameter sensitivity (tornado) analysis** where
  outdoor airflow, occupancy, infiltration and device CADR are each perturbed
  20% below and above the current classroom, and the exact closed-form deltas
  are shown for CO2 peak, PM2.5 mean, daily conditioning energy and
  Wells-Riley risk.
- Exports a **deterministic audit report** (JSON and formula-safe CSV) holding
  the scenario, solved metrics, sensitivity table, optimizer summary and
  solver verification numbers, fingerprinted with FNV-1a and SHA-256 so the
  same scenario always produces byte-identical output.
- Supports full keyboard operation. Arrow keys inspect the trend chart and
  walk the Pareto frontier, Enter applies a point, and a polite live region
  announces every committed change. Out-of-range inputs are clamped and
  recover cleanly.

## Run it

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

Run the deterministic test suite:

```sh
node --test tests/
```

## Observed results

Measured on Node v26.8.1 (Apple Silicon) with the standard 28-student reference
classroom:

| Check | Observed |
|---|---|
| Tests | **138 passed, 0 failed** |
| CO2 RK4 vs closed form RMSE | **2.40e-8 %** (5.09e-7 ppm), target < 0.05 % |
| PM2.5 RMSE vs closed form | **4.80e-10 ug/m3** |
| Integrated quanta RMSE | **1.16e-12** |
| RK4 observed convergence order | **4.03** (h, h/2, h/4 refinement) |
| Refinement delta h/2 vs h/4 | **9.53e-7** worst series |
| CO2 steady-state residual | **0.072 %** of approach |
| CO2 time constant | **0.83 h** (210 m3 / 253.5 m3/h exchange incl. infiltration) |
| Retrofit enumeration | **700 options, 259 affordable, 246 Pareto-optimal** (661 over all configs, 9 on the cost-risk frontier) |
| Retrofit optimizer latency | **13.5 ms median** (max 21.2 ms over 10 runs) |
| Wildfire preset indoor PM2.5 mean | **149.49 ug/m3** with outdoor 180 ug/m3 |

Preset peaks (closed baseline unless the preset specifies ventilation):

| Preset | CO2 peak (ppm) | PM2.5 mean (ug/m3) | Wells-Riley risk (%) | eACH |
|---|---:|---:|---:|---:|
| Standard 28-student classroom | 2254.2 | 10.02 | 37.33 | 1.28 |
| Crowded science lab | 2437.7 | 12.75 | 54.82 | 1.76 |
| Rural natural-ventilation room | 466.5 | 7.93 | 1.48 | 34.98 |
| Wildfire smoke day | 1890.2 | 149.49 | 36.78 | 1.58 |
| DIY Corsi-Rosenthal comparison | 739.2 | 14.50 | 7.97 | 9.68 |

## Browser verification

The demo choreography in `video/steps.json` was replayed in isolated headless
Chrome against the rebuilt UI at 1920x1080 and again at 1440x900:

- Every selector step hit-tested via `document.elementFromPoint`; all click
  targets received real `Input.dispatchMouseEvent` clicks and produced the
  expected state changes (radio, checkbox, intervention select, table toggle).
- A guided experiment button applied its preset plus overrides; a real pointer
  click on a Pareto frontier point populated the inspector panel.
- **Zero console errors** and **zero external requests**.
- No horizontal scroll at 1920x1080, 1440x900 or 390x844
  (`document.documentElement.scrollWidth === innerWidth`).
- Trend, classroom and Pareto canvas regions were captured and inspected at
  1440px and 390px: guide captions keep their line order, end-point labels
  keep 11px vertical separation with leader ticks when detached, and no
  caption clips or overlaps.

The narration in `video/narration.txt` is 300 words.

## Model scope

All five classroom presets and the four guided experiments are **synthetic
reference models**. They are not measurements, pilots or claims about real
schools. The physics is deliberately simplified for teaching: well-mixed room
air, constant emission rates, simplified natural-ventilation coefficients,
partial particle penetration through infiltration and fixed filtration
efficiencies. The full assumption list is in the app's "Model assumptions and
limits" panel. Do not use VentiLab for ventilation-system design or health
decisions.

## Files

| Path | Purpose |
|---|---|
| `src/engine.js` | Pure ES module physics engine, optimizer, experiments, share codec, sensitivity analyzer and audit export |
| `src/app.js` | Controls, state, inspector, experiments, keyboard access and DOM wiring |
| `src/viz.js` | Canvas classroom diagram, trend chart, Pareto chart and tornado chart |
| `index.html`, `styles.css` | Offline UI |
| `tests/engine.test.mjs` | 75 deterministic unit tests |
| `tests/wave3.test.mjs` | 63 sensitivity, export and conservation-invariant tests |
| `video/narration.txt`, `video/steps.json` | Demo script and choreography |

## License

MIT. See `LICENSE`.
