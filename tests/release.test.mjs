import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = rel => readFileSync(join(root, rel), 'utf8');
const index = read('index.html');
const app = read('src/app.js');
const sw = read('sw.js');
const manifest = JSON.parse(read('manifest.webmanifest'));
const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\]/)[1];
const shellEntries = [...shellBlock.matchAll(/'([^']+)'/g)].map(match => match[1]);

test('citable metadata includes canonical, OpenGraph and educational JSON-LD', () => {
  assert.ok(index.includes('<link rel="canonical" href="https://aariv.me/ventilab/">'));
  assert.ok(index.includes('property="og:url" content="https://aariv.me/ventilab/"'));
  assert.ok(index.includes('property="og:image" content="https://aariv.me/ventilab/og-image.png"'));
  assert.ok(index.includes('name="twitter:card" content="summary_large_image"'));
  const ld = index.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(ld, 'JSON-LD block missing');
  const data = JSON.parse(ld[1]);
  const software = data['@graph'].find(item => item['@type'] === 'SoftwareApplication');
  assert.equal(software.name, 'VentiLab');
  assert.equal(software.applicationCategory, 'EducationalApplication');
  assert.equal(software.isAccessibleForFree, true);
  assert.ok(data['@graph'].some(item => item['@type'] === 'LearningResource'));
});

test('PWA manifest is valid, local and points at existing icons', () => {
  assert.equal(manifest.name, 'VentiLab - Classroom Clean-Air Workbench');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.icons.length, 4);
  assert.ok(manifest.icons.some(icon => icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    assert.ok(statSync(join(root, icon.src)).size > 1000, `${icon.src} missing or empty`);
    assert.ok(!icon.src.startsWith('http'), 'icons must stay local');
  }
  assert.ok(index.includes('<link rel="manifest" href="manifest.webmanifest">'));
});

test('service worker precaches every source module and every shell entry exists', () => {
  const modules = readdirSync(join(root, 'src')).filter(name => name.endsWith('.js'));
  for (const name of modules) assert.ok(shellEntries.includes(`src/${name}`), `src/${name} missing from sw.js`);
  for (const entry of shellEntries) assert.doesNotThrow(() => statSync(join(root, entry)), `${entry} missing`);
  assert.match(sw, /const VERSION = `\$\{PREFIX\}v\d+`;/);
  assert.match(sw, /request\.mode === 'navigate'/);
  assert.match(app, /serviceWorker\.register/);
});

test('OpenGraph image and icons are real PNG assets of the declared sizes', () => {
  const pngSize = rel => {
    const bytes = readFileSync(join(root, rel));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${rel} is not a PNG`);
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  };
  assert.deepEqual(pngSize('og-image.png'), [1200, 630]);
  assert.deepEqual(pngSize('icon-192.png'), [192, 192]);
  assert.deepEqual(pngSize('icon-512.png'), [512, 512]);
});

test('the page loads no external script, stylesheet, font or image resource', () => {
  const resources = [...index.matchAll(/<(?:script|img|link)[^>]+(?:src|href)="(https?:)?\/\/[^"]+"[^>]*>/g)]
    .map(match => match[0])
    .filter(tag => !tag.includes('rel="canonical"'));
  assert.deepEqual(resources, []);
});

test('classroom quick start controls exist and are wired to real targets', () => {
  for (const key of ['observe', 'compare', 'plan']) assert.ok(index.includes(`data-quickstart="${key}"`), `${key} missing`);
  assert.match(app, /QUICK_STARTS/);
  assert.match(app, /targetId: 'trendCanvas'/);
  assert.match(app, /targetId: 'paretoCanvas'/);
  assert.match(app, /targetId: 'planPrint'/);
  assert.match(app, /aria-pressed/);
});

test('UI source and shell copy use no em or en dashes', () => {
  const files = ['index.html', 'styles.css', 'sw.js', 'manifest.webmanifest', ...readdirSync(join(root, 'src')).filter(name => name.endsWith('.js')).map(name => `src/${name}`)];
  for (const file of files) {
    const text = read(file);
    assert.ok(!text.includes('\u2014') && !text.includes('\u2013'), `${file} contains an em or en dash`);
  }
});
