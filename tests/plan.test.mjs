import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';
import * as R from '../src/retrofit.js';
import * as P from '../src/plan.js';

const params = () => E.normalizeParams({ ...E.DEFAULTS, maskEfficiency: 0, stepMin: 2, sampleMin: 6, infectious: 1 });
const metricsOf = (p) => E.evaluateScenario(p).metrics;
const planOf = (p, name = 'Standard 28-student classroom') => P.sharedAirPlan(p, metricsOf(p), name);

const itemsOf = (plan, roleId) => plan.roles.find((r) => r.id === roleId).items;
const allText = (plan) => plan.roles.flatMap((r) => r.items.map((i) => i.text)).join(' ');

test('1. the plan covers teacher, student and family roles with nonempty checklists', () => {
  const plan = planOf(params());
  assert.deepEqual(plan.roles.map((r) => r.id), ['teacher', 'students', 'families']);
  for (const role of plan.roles) {
    assert.ok(role.items.length >= 3, `${role.id} has ${role.items.length} items`);
    for (const item of role.items) {
      assert.ok(item.id.length > 0 && item.text.length > 20, `thin item ${role.id}:${item.id}`);
    }
  }
});

test('2. every plan item id is unique within its role and stable across calls', () => {
  const a = planOf(params());
  const b = planOf(params());
  for (const role of a.roles) {
    const ids = role.items.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate ids in ${role.id}`);
    assert.deepEqual(ids, b.roles.find((r) => r.id === role.id).items.map((i) => i.id));
  }
});

test('3. plan numbers track the solved metrics, not canned text', () => {
  const p = params();
  const m = metricsOf(p);
  const plan = planOf(p);
  assert.match(plan.summary, new RegExp(`CO2 peak ${P.fmtNum(m.co2Peak)} ppm`));
  assert.match(plan.summary, new RegExp(`${P.fmtNum(m.ecaACH, 1)} eACH`));
  assert.match(allText(plan), /ug\/m3/);
});

test('4. high outdoor PM flips the window guidance to filtered recirculation', () => {
  const clean = allText(planOf(params()));
  assert.match(clean, /clean enough to use|window opening/);
  const smoky = planOf({ ...params(), outdoorPM: 180 });
  assert.match(itemsOf(smoky, 'teacher').find((i) => i.id === 'windows').text, /keep windows closed/i);
});

test('5. an open-window classroom gets hold-the-opening guidance with its percent', () => {
  const plan = planOf({ ...params(), windowMode: 'cross', windowOpen: 0.5 });
  const windows = itemsOf(plan, 'teacher').find((i) => i.id === 'windows');
  assert.match(windows.text, /50% cross/);
});

test('6. a compliant room praises the 800 ppm band, a breached one prescribes outdoor air first', () => {
  const calm = planOf({ ...params(), windowMode: 'cross', windowOpen: 1 });
  assert.match(itemsOf(calm, 'teacher').find((i) => i.id === 'co2').text, /inside the 800 ppm guide band/);
  const tight = planOf(params());
  assert.match(itemsOf(tight, 'teacher').find((i) => i.id === 'co2').text, /over the 800 ppm guide band/);
});

test('7. device guidance names the actual installed devices and the CO2 caveat', () => {
  const plan = planOf({ ...params(), crBoxes: 2, hepaUnits: 1, merv13: true });
  const devices = itemsOf(plan, 'teacher').find((i) => i.id === 'devices');
  assert.match(devices.text, /2 Corsi-Rosenthal boxes/);
  assert.match(devices.text, /1 HEPA unit/);
  assert.match(devices.text, /MERV-13/);
  assert.match(devices.text, /never CO2/);
});

test('8. the family cost line only appears when devices are installed', () => {
  const bare = planOf(params());
  assert.equal(itemsOf(bare, 'families').some((i) => i.id === 'cost'), false);
  const withDevices = planOf({ ...params(), crBoxes: 1 });
  assert.match(itemsOf(withDevices, 'families').find((i) => i.id === 'cost').text, /\$[0-9,]+ one-time/);
});

test('9. the family ask line quotes the live steady state and eACH', () => {
  const p = params();
  const plan = planOf(p);
  const ask = itemsOf(plan, 'families').find((i) => i.id === 'ask');
  const steady = R.steadyStateCo2(p);
  assert.match(ask.text, new RegExp(`${P.fmtNum(steady)} ppm`));
  assert.match(ask.text, /eACH\./);
});

test('10. masks guidance switches on the live mask efficiency', () => {
  const off = planOf(params());
  assert.match(itemsOf(off, 'students').find((i) => i.id === 'masks').text, /price them in/);
  const on = planOf({ ...params(), maskEfficiency: 0.7 });
  assert.match(itemsOf(on, 'students').find((i) => i.id === 'masks').text, /70% effective masks/);
});

test('11. planPlainText renders role headers, checkboxes and the foot', () => {
  const plan = planOf(params());
  const done = new Set(['teacher:read', 'students:speak']);
  const text = P.planPlainText(plan, done);
  assert.match(text, /^Classroom and community shared-air plan/m);
  assert.match(text, /^TEACHER$/m);
  assert.match(text, /^STUDENTS$/m);
  assert.match(text, /^FAMILIES AND COMMUNITY$/m);
  assert.match(text, /\[x\] Check outdoor air before first period/);
  assert.match(text, /\[ \] Keep air paths/);
  assert.match(text, /Educational estimate/);
});

test('12. planPlainText is deterministic and marks exactly the done set', () => {
  const plan = planOf(params());
  const done = new Set(['families:ask']);
  const a = P.planPlainText(plan, done);
  assert.equal(a, P.planPlainText(plan, done));
  assert.equal((a.match(/\[x\]/g) || []).length, 1);
});

test('13. all plan text is ASCII with zero em or en dashes', () => {
  for (const scenario of [params(), { ...params(), outdoorPM: 180, masks: true }, { ...params(), windowMode: 'cross', windowOpen: 1, crBoxes: 2, hepaUnits: 1, merv13: true, uvgi: true }]) {
    const plan = planOf(scenario);
    const blob = plan.summary + plan.foot + allText(plan) + P.planPlainText(plan);
    assert.ok(!/[\u2010\u2011\u2012\u2013\u2014\u2015]/.test(blob), 'unicode dash found');
    assert.ok(/^[\x00-\x7F]*$/.test(blob), 'non-ASCII found');
  }
});

test('14. physicsExplainer reports the live ACH, tau and steady state', () => {
  const p = params();
  const m = metricsOf(p);
  const rows = P.physicsExplainer(p, m);
  const vent = E.ventilationRates(p);
  const qExchange = vent.qNatural + p.mechOA + vent.qInfiltration;
  const ach = rows.find((r) => r.id === 'ach');
  assert.equal(ach.result, `${P.fmtNum(qExchange / p.volume, 2)} /h`);
  const tau = rows.find((r) => r.id === 'tau');
  assert.equal(tau.result, `${P.fmtNum(p.volume / qExchange, 2)} h`);
  const steady = rows.find((r) => r.id === 'steady');
  assert.equal(steady.result, `${P.fmtNum(R.steadyStateCo2(p))} ppm`);
  const source = rows.find((r) => r.id === 'source');
  assert.equal(source.result, `${P.fmtNum((p.students * p.co2Generation * 1000) / p.volume, 1)} ppm/h`);
});

test('15. physicsExplainer substitutes real numbers into every formula row', () => {
  const p = params();
  const rows = P.physicsExplainer(p, metricsOf(p));
  assert.equal(rows.length, 8);
  for (const row of rows) {
    assert.ok(row.name && row.formula && row.result && row.why, `sparse row ${row.id}`);
    assert.match(row.substitution, /\d/, `no numbers substituted in ${row.id}`);
  }
  assert.match(rows.find((r) => r.id === 'eca').substitution, /\+/);
  assert.match(rows.find((r) => r.id === 'oa-person').result, /L\/s/);
  assert.match(rows.find((r) => r.id === 'wells-riley').substitution, /quanta/);
});

test('16. physicsExplainer handles the no-exchange edge without NaN', () => {
  const p = { ...params(), mechOA: 0, windowMode: 'closed', infiltrationACH: 0, students: 0 };
  const rows = P.physicsExplainer(p, metricsOf(p));
  assert.equal(rows.find((r) => r.id === 'ach').result, 'no exchange');
  assert.equal(rows.find((r) => r.id === 'tau').result, 'no exchange');
  assert.equal(rows.find((r) => r.id === 'steady').result, 'no steady state');
  assert.ok(rows.every((r) => !/NaN|Infinity/.test(r.result + r.substitution)));
});

test('17. physics explainer text is ASCII with zero em or en dashes', () => {
  const rows = P.physicsExplainer(params(), metricsOf(params()));
  const blob = rows.map((r) => r.name + r.formula + r.substitution + r.result + r.why).join(' ');
  assert.ok(!/[\u2014\u2013\u2012\u2010\u2015]/.test(blob), 'unicode dash found');
  assert.ok(/^[\x00-\x7F]*$/.test(blob), 'non-ASCII found');
});

test('18. fmtNum groups thousands and keeps digits and signs', () => {
  assert.equal(P.fmtNum(0), '0');
  assert.equal(P.fmtNum(18.54, 1), '18.5');
  assert.equal(P.fmtNum(2408.4), '2,408');
  assert.equal(P.fmtNum(-12.5, 1), '-12.5');
  assert.equal(P.fmtNum(NaN), 'n/a');
  assert.equal(P.fmtNum(Infinity), 'n/a');
});

test('19. plan survives zero students and an empty room', () => {
  const plan = planOf({ ...params(), students: 0 });
  assert.ok(plan.roles.every((r) => r.items.length >= 3));
  const rows = P.physicsExplainer({ ...params(), students: 0 }, metricsOf({ ...params(), students: 0 }));
  assert.ok(rows.every((r) => !/NaN/.test(r.result + r.substitution)));
});

test('20. every guided preset produces a coherent plan', () => {
  for (const preset of E.PRESETS) {
    const p = { ...preset.params, presetId: preset.id, infectious: 1 };
    const plan = planOf(p, preset.name);
    assert.match(plan.summary, /CO2 peak [0-9,]+ ppm/);
    assert.ok(/[0-9]/.test(P.planPlainText(plan)));
    assert.ok(!/[\u2010\u2011\u2012\u2013\u2014\u2015]/.test(plan.summary + allText(plan)));
  }
});
