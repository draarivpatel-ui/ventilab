/**
 * Room bookmark codec: `#room=<base64url(JSON)>` URL-hash sharing.
 *
 * Complements the `v=1&...` share hash with a single-field bookmark that
 * also carries the selected comparator retrofit. Decoding is strict: size
 * and character limits, JSON shape, allowlisted keys, per-field type and
 * range checks, and a version gate. It never throws and never returns
 * non-allowlisted keys.
 */
import { normalizeParams, PRESETS } from './engine.js';
import { RETROFIT_IDS } from './retrofit.js';

const ROOM_VERSION = 1;
const MAX_HASH_LEN = 1200;
const PRESET_IDS = PRESETS.map((p) => p.id);

/**
 * Allowlisted bookmark fields. `values` lists allowed enum strings;
 * `min`/`max` bound numbers, `integer` requires whole values,
 * `scaleFrom` stores a 0..1 fraction as an integer percentage, and `map`
 * names the engine parameter.
 */
const ROOM_FIELDS = Object.freeze({
  v: Object.freeze({ version: true }),
  p: Object.freeze({ values: PRESET_IDS, map: 'presetId' }),
  s: Object.freeze({ min: 0, max: 60, integer: true, map: 'students' }),
  vol: Object.freeze({ min: 50, max: 800, integer: true, map: 'volume' }),
  co2: Object.freeze({ min: 300, max: 1200, integer: true, map: 'outdoorCO2' }),
  pm: Object.freeze({ min: 0, max: 400, integer: true, map: 'outdoorPM' }),
  wind: Object.freeze({ min: 0, max: 15, map: 'windSpeed' }),
  dt: Object.freeze({ min: -15, max: 25, map: 'deltaT' }),
  mode: Object.freeze({ values: ['closed', 'single', 'cross'], map: 'windowMode' }),
  open: Object.freeze({ min: 0, max: 100, integer: true, map: 'windowOpen', scaleFrom: 100 }),
  mech: Object.freeze({ min: 0, max: 2000, integer: true, map: 'mechOA' }),
  inf: Object.freeze({ min: 0, max: 5, integer: true, map: 'infectious' }),
  q: Object.freeze({ min: 0, max: 300, integer: true, map: 'quantaRate' }),
  mask: Object.freeze({ min: 0, max: 95, integer: true, map: 'maskEfficiency', scaleFrom: 100 }),
  cr: Object.freeze({ min: 0, max: 4, integer: true, map: 'crBoxes' }),
  hepa: Object.freeze({ min: 0, max: 4, integer: true, map: 'hepaUnits' }),
  merv: Object.freeze({ min: 0, max: 1, integer: true, map: 'merv13' }),
  uvgi: Object.freeze({ min: 0, max: 1, integer: true, map: 'uvgi' }),
  budget: Object.freeze({ min: 0, max: 10000, integer: true, map: 'budget' }),
  r: Object.freeze({ values: ['custom', ...RETROFIT_IDS, 'best-under-budget'], map: 'retrofitId' }),
});

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function b64urlEncode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += B64[(triple >> 18) & 63];
    out += B64[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(triple >> 6) & 63] : '';
    out += i + 2 < bytes.length ? B64[triple & 63] : '';
  }
  return out;
}

function b64urlDecode(text) {
  if (!/^[A-Za-z0-9\-_]+$/.test(text) || text.length % 4 === 1) return null;
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (const ch of text) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function utf8Encode(str) {
  return typeof TextEncoder === 'function'
    ? new TextEncoder().encode(str)
    : Uint8Array.from(unescape(encodeURIComponent(str)), (c) => c.charCodeAt(0));
}

function utf8Decode(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Encode the allowlisted scenario fields into a `#room=` bookmark. */
export function encodeRoom(state = {}) {
  const s = normalizeParams(state);
  const payload = { v: ROOM_VERSION, p: s.presetId || 'standard28' };
  for (const [key, spec] of Object.entries(ROOM_FIELDS)) {
    if (key === 'v' || key === 'p') continue;
    let value;
    if (key === 'r') {
      value = state.retrofitId && spec.values.includes(state.retrofitId) ? state.retrofitId : 'custom';
    } else {
      value = s[spec.map];
      if (spec.scaleFrom) value = Math.round(value * spec.scaleFrom);
      if (typeof value === 'boolean') value = value ? 1 : 0;
    }
    payload[key] = value;
  }
  return `#room=${b64urlEncode(utf8Encode(JSON.stringify(payload)))}`;
}

/**
 * Strictly decode a `#room=` bookmark. Returns { ok, state, fields } or
 * { ok:false, error }. Rejects malformed input, unknown keys, wrong types,
 * out-of-range values and prototype keys.
 */
export function decodeRoom(hash) {
  try {
    if (typeof hash !== 'string') return { ok: false, error: 'Invalid hash type' };
    let raw = hash.trim();
    if (raw.startsWith('#')) raw = raw.slice(1);
    if (!raw.startsWith('room=')) return { ok: false, error: 'Not a room bookmark' };
    const body = raw.slice(5);
    if (!body || raw.length > MAX_HASH_LEN) return { ok: false, error: 'Bookmark length out of range' };
    const bytes = b64urlDecode(body);
    if (!bytes || bytes.length > 800) return { ok: false, error: 'Malformed bookmark body' };
    const text = utf8Decode(bytes);
    if (text === null) return { ok: false, error: 'Bookmark is not valid UTF-8' };
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, error: 'Bookmark JSON parse failed' };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, error: 'Bookmark is not an object' };
    }
    const state = {};
    const fields = [];
    for (const [key, value] of Object.entries(payload)) {
      if (!Object.hasOwn(ROOM_FIELDS, key)) return { ok: false, error: `Unknown field ${key}` };
      const spec = ROOM_FIELDS[key];
      if (spec.version) {
        if (value !== ROOM_VERSION) return { ok: false, error: 'Unsupported version' };
        fields.push(key);
        continue;
      }
      if (spec.values) {
        if (typeof value !== 'string' || !spec.values.includes(value)) {
          return { ok: false, error: `Enum out of range: ${key}` };
        }
        if (key === 'p') {
          const preset = PRESETS.find((pr) => pr.id === value);
          state.presetId = value;
          Object.assign(state, preset.params);
        } else {
          state[spec.map] = value;
        }
        fields.push(key);
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: `Non-numeric field ${key}` };
      }
      if (value < spec.min || value > spec.max) return { ok: false, error: `Out of range: ${key}` };
      if (spec.integer && !Number.isInteger(value)) return { ok: false, error: `Expected integer: ${key}` };
      let v = value;
      if (spec.scaleFrom) v = v / spec.scaleFrom;
      if (key === 'merv' || key === 'uvgi') v = v === 1;
      state[spec.map] = v;
      fields.push(key);
    }
    if (!fields.includes('v')) return { ok: false, error: 'Missing version' };
    return { ok: true, state, fields };
  } catch {
    return { ok: false, error: 'Decode failed' };
  }
}
