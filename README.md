# VentiLab

**Classroom Clean-Air and Airborne Risk Physics Workbench**

An offline, zero-dependency browser workbench for exploring how ventilation,
filtration and occupancy change classroom air. Built for the UNICEF Clean Air /
Climate Action track at unihacks (ages 13-18).

Everything runs locally: no build step, no packages, no network calls, no fonts
or scripts from external hosts. Open `index.html` through any static file
server, or load it from disk in a browser that permits local ES modules.

## What it does

- Solves the transient CO2 mass balance with a fixed-step **RK4** integrator,
  including class periods, breaks and recess.
- Estimates natural ventilation for single-sided and cross ventilation from
  wind and stack effect, then adds mechanical outdoor air.
- Integrates a **Wells-Riley** dose model with mask efficiency and equivalent
  clean airflow from HEPA, Corsi-Rosenthal fan boxes, MERV-13 and UVGI.
- Tracks indoor **PM2.5** during wildfire smoke with an infiltration/filtration
  mass-balance ODE.
- Computes an **exact Pareto frontier** over 120 retrofit configurations under
  a budget, across cost, watts, noise, CO2 peak, PM2.5 and remaining risk.
- Shares scenarios through a strictly validated URL hash and prints a
  classroom action card.

## Run it

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

Run the deterministic test suite:

```sh
node --test tests/engine.test.mjs
```

## Observed results

Measured on Node v26.8.1 (Apple Silicon) with the standard 28-student reference
classroom:

| Check | Observed |
|---|---|
| Tests | **29 passed, 0 failed** |
| CO2 RK4 vs closed form RMSE | **8.06e-9 %** (2.15e-7 ppm), target < 0.05 % |
| PM2.5 RMSE vs closed form | **4.80e-10 ug/m3** |
| Integrated quanta RMSE | **5.17e-13** |
| CO2 time constant | **1.17 h** (210 m3 / 180 m3/h) |
| Retrofit enumeration | **120 options, 77 Pareto-optimal, 40.6 ms** |
| Wildfire preset indoor PM2.5 mean | **149.49 ug/m3** with outdoor 180 ug/m3 |

Preset peaks (closed baseline unless the preset specifies ventilation):

| Preset | CO2 peak (ppm) | PM2.5 mean (ug/m3) | Wells-Riley risk (%) |
|---|---:|---:|---:|
| Standard 28-student classroom | 2918.4 | 10.02 | 45.55 |
| Crowded science lab | 3014.9 | 12.75 | 63.10 |
| Rural natural-ventilation room | 467.2 | 7.93 | 1.50 |
| Wildfire smoke day | 2549.7 | 149.49 | 46.98 |
| DIY Corsi-Rosenthal comparison | 756.0 | 14.50 | 8.29 |

## Browser verification

The demo choreography in `video/steps.json` was replayed in isolated headless
Chrome 158 at 1920x1080 using real coordinate clicks resolved through
`document.elementFromPoint`:

- **11 of 11 steps passed**, with zero offscreen clicks.
- **Zero console errors** and **zero external requests**.
- No horizontal scroll at 1920x1080, 1440x900 or 390x844
  (`document.documentElement.scrollWidth === innerWidth`).
- Screenshots were visually inspected at desktop and mobile widths.

The narration in `video/narration.txt` is 300 words.

## Model scope

All five classroom presets are **synthetic reference models**. They are not
measurements, pilots or claims about real schools. The physics is deliberately
simplified for teaching: well-mixed room air, constant emission rates, simplified
natural-ventilation coefficients and fixed filtration efficiencies. Do not use
VentiLab for ventilation-system design or health decisions.

## Files

| Path | Purpose |
|---|---|
| `src/engine.js` | Pure ES module physics engine and share codec |
| `src/app.js` | Controls, state and DOM wiring |
| `src/viz.js` | Canvas classroom diagram and charts |
| `index.html`, `styles.css` | Offline UI |
| `tests/engine.test.mjs` | 29 deterministic unit tests |
| `video/narration.txt`, `video/steps.json` | Demo script and choreography |

## License

MIT. See `LICENSE`.
