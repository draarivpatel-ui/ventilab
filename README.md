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
- Opens a **How airflow physics works** drawer that walks the eight core
  equations (outdoor air per person, air changes per hour, exchange time
  constant, CO2 source rate, CO2 steady state, PM2.5 steady state, equivalent
  clean air and the Wells-Riley infection dose) with the live classroom
  numbers substituted into every formula, so a slider move is visible inside
  the math itself.
- Builds a **Classroom and community shared-air plan**: a printable and
  copyable plain-language checklist split into teacher, student and
  family/community roles, where every task is generated from the solved
  scenario (window guidance follows the indoor/outdoor PM comparison, device
  tasks name the installed units, the family ask quotes the live steady
  state). Checks persist across re-solves, and the plain-text export marks
  completed tasks with `[x]`.
- Runs a **one-at-a-time parameter sensitivity (tornado) analysis** where
  outdoor airflow, occupancy, infiltration and device CADR are each perturbed
  20% below and above the current classroom, and the exact closed-form deltas
  are shown for CO2 peak, PM2.5 mean, daily conditioning energy and
  Wells-Riley risk.
- Exports a **deterministic audit report** (JSON and formula-safe CSV) holding
  the scenario, solved metrics, sensitivity table, optimizer summary and
  solver verification numbers, fingerprinted with FNV-1a and SHA-256 so the
  same scenario always produces byte-identical output. The recorded scenario
  carries every effective input (schedule, start values, solver steps and
  model version), so feeding it back into the report replays the exact same
  peaks, means and fingerprint.
- Compares a **multi-scenario IAQ retrofit comparator**: the as-is baseline
  versus five deterministic interventions (two Corsi-Rosenthal fan boxes, a
  MERV-13 filter upgrade, two commercial HEPA 400-CFM units, a cross-ventilation
  window schedule, and a combined low-cost school package), the live custom
  controls, and the optimizer's best pick under the current budget. Each row
  shows effective ACH, steady-state and peak CO2, Wells-Riley risk reduction,
  PM2.5 90% clearance time, a CDC/ASHRAE-style compliance verdict, a disclosed
  annualized cost estimate and risk reduction per $100.
- Simulates a **full school day (8:00 AM - 3:30 PM)**: periods, recess, lunch,
  passing and dismissal as a piecewise-constant occupancy schedule, drawn as a
  before/after CO2 and aerosol chart with grey unoccupied bands and shaded
  regions where CO2 exceeds 800 or 1000 ppm. Exact minutes above each guide
  come from the closed-form trajectory, not sampling.
- Exports a **signed engineering brief** (JSON, formula-safe CSV or Markdown)
  carrying the scenario, closed-form metrics, compliance verdict, comparator
  table, school-day summary and solver verification, fingerprinted with
  FNV-1a-32 and a pure-JS FIPS 180-4 SHA-256 digest over the canonical payload.
  The signature is tamper evidence, not a digital signature: the in-page
  verifier recomputes it and replays the recorded scenario through the solver
  to confirm every recorded metric, and a tamper-test button demonstrates
  detection of an edited copy.
- Bookmarks rooms through a second URL-hash format, `#room=...`, a
  base64url-JSON bookmark that also carries the selected comparator retrofit.
  Decoding is strict: size and charset limits, a version gate, allowlisted
  keys only, and per-field type, integer and range checks; a malformed
  bookmark is rejected without touching the current scenario.
- Ships a scoped service worker and web manifest that precache the full shell,
  so the workbench reloads offline after first load.
- Runs an in-page **self-test panel** that live-checks the SHA-256 FIPS 180-4
  known answers, CO2 mass-balance convergence, Wells-Riley bounds and ACH
  monotonicity, PM2.5 decay conservation, multi-period schedule conservation,
  CSV formula-injection escaping, brief tamper detection, the bookmark codec,
  comparator consistency and canonical-JSON determinism.
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
node --test
```

## Observed results

Measured on Node v26.8.1 (Apple Silicon) with the standard 28-student reference
classroom:

| Check | Observed |
|---|---|
| Tests | **475 passed, 0 failed** |
| CO2 RK4 vs closed form RMSE | **2.38e-8 %** (5.09e-7 ppm), target < 0.05 % |
| PM2.5 RMSE vs closed form | **4.80e-10 ug/m3** |
| Integrated quanta RMSE | **1.01e-12** |
| RK4 observed convergence order | **4.03** (h, h/2, h/4 refinement) |
| Refinement delta h/2 vs h/4 | **9.53e-7** worst series |
| CO2 steady-state residual | **0.072 %** of approach |
| CO2 approach after one time constant | **63.21 %** (exact 1 - 1/e) |
| CO2 time constant | **0.83 h** (210 m3 / 253.5 m3/h exchange incl. infiltration) |
| Retrofit enumeration | **700 options, 259 affordable, 246 Pareto-optimal** (661 over all configs, 9 on the cost-risk frontier) |
| Retrofit optimizer latency | **10.8 ms median** (max 18.8 ms over 10 runs) |
| Wildfire preset indoor PM2.5 mean | **149.47 ug/m3** with outdoor 180 ug/m3 |
| School-day minutes above 800 ppm (standard room) | **439.5 min before, 272.9 min after** the low-cost school package |
| School-day minutes above 1000 ppm | **432.9 min before, 0.0 min after** |
| In-page self-tests | **10/10 pass** |

Preset peaks (closed baseline unless the preset specifies ventilation):

| Preset | CO2 peak (ppm) | PM2.5 mean (ug/m3) | Wells-Riley risk (%) | eACH |
|---|---:|---:|---:|---:|
| Standard 28-student classroom | 2254.2 | 10.02 | 38.72 | 1.21 |
| Crowded science lab | 2437.7 | 12.75 | 56.72 | 1.66 |
| Rural natural-ventilation room | 466.5 | 7.95 | 1.48 | 34.98 |
| Wildfire smoke day | 1890.2 | 149.47 | 38.12 | 1.50 |
| DIY Corsi-Rosenthal comparison | 739.2 | 14.51 | 8.01 | 9.62 |

## Browser verification

A 56-check audit ran the live UI in real headless Chrome at 1440x900 and
390x844 (zero-dependency CDP harness):

- **Zero console errors, zero uncaught exceptions, zero page-level errors and
  zero external network requests**; no horizontal overflow at either size
  (`document.documentElement.scrollWidth === innerWidth`).
- The preset select re-solves; the comparator renders all 8 rows and a real
  `Input.dispatchMouseEvent` click on a row's Apply button writes the override
  into live state (CR boxes 0 -> 2).
- The school-day chart renders its SVG with both guide bands, reports
  before/after threshold minutes, switches the after-curve on the retrofit
  select, and arrow keys drive the keyboard cursor and guide line.
- Run Self-Tests fills the panel with 10/10 passes on a real pointer click;
  the signed brief verifies intact, replays all 14 recorded metrics and the
  tamper test rejects an edited copy; the JSON export triggers a real
  `ventilab-brief-<fnv>.json` download and the signature line shows the
  SHA-256 digest.
- The physics drawer opens on a real click and renders all 8 equation rows
  with live substituted values; the shared-air plan renders its three role
  groups, a real checkbox click advances the counter and the `[x]` mark, and
  the copy and plan-only print controls respond to real pointer clicks.
- Room bookmark writes a `#room=...` hash; reloading through it restores
  `crBoxes: 2` and the `cross-vent` day selection, and a malformed
  `#room=AAAA` is rejected with the current scenario preserved.
- Mobile at 390x844 keeps the comparator, school-day chart, plan groups,
  physics rows and self-test panel reachable and inside the viewport with
  10/10 self-tests on a real click.

Earlier, the demo choreography in `video/steps.json` was replayed in isolated
headless Chrome against the rebuilt UI at 1920x1080 and again at 1440x900:

- Every selector step hit-tested via `document.elementFromPoint`; all click
  targets received real `Input.dispatchMouseEvent` clicks and produced the
  expected state changes (radio, checkbox, intervention select, table toggle).
- A guided experiment button applied its preset plus overrides; a real pointer
  click on a Pareto frontier point populated the inspector panel.
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
| `src/retrofit.js` | Multi-scenario retrofit comparator, disclosed annualized cost model, PM2.5 clearance and compliance verdicts |
| `src/schoolday.js` | 8:00 AM - 3:30 PM schedule integrator, exact CO2 threshold exceedance and the before/after SVG chart |
| `src/brief.js` | Signed engineering brief (JSON/CSV/Markdown), integrity verification and solver replay |
| `src/roomcodec.js` | Strict `#room=` base64url bookmark codec |
| `src/plan.js` | Shared-air checklist builder and live physics-equation explainer |
| `src/selftest.js` | In-page self-test suite |
| `src/sha256.js` | Dependency-free FIPS 180-4 SHA-256 |
| `src/app.js` | Controls, state, inspector, experiments, keyboard access and DOM wiring |
| `src/viz.js` | Canvas classroom diagram, trend chart, Pareto chart and tornado chart |
| `index.html`, `styles.css` | Offline UI with citable metadata and the classroom quick start |
| `sw.js`, `manifest.webmanifest` | Scoped offline precache and install metadata |
| `tests/engine.test.mjs` | 75 deterministic unit tests |
| `tests/wave3.test.mjs` | 63 sensitivity, export and conservation-invariant tests |
| `tests/wave-b.test.mjs` | 18 regression tests for clean-air accounting, exact means, verification and export fixes |
| `tests/wave-d.test.mjs` | 88 comparator and school-day tests |
| `tests/wave-e.test.mjs` | 199 SHA-256, brief, bookmark codec, self-test and integration tests |
| `tests/plan.test.mjs` | 25 shared-air plan and physics-explainer tests |
| `tests/release.test.mjs` | 7 metadata, PWA shell, asset, quick-start and text-hygiene tests |
| `video/narration.txt`, `video/steps.json` | Demo script and choreography |

## License

MIT. See `LICENSE`.
