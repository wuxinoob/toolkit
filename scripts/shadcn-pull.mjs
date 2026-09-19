/**
 * Pull shadcn-vue components into `src/components/ui/`.
 *
 * Why this script exists rather than just running `npx shadcn-vue add`:
 *
 *   1. **The CLI's fetch layer fails here** (`Failed to fetch from registry`)
 *      even though the registry itself answers HTTP 200. Fetching the registry
 *      JSON directly and writing the files ourselves sidesteps that entirely.
 *   2. **Copy-in components are normally untraceable.** The whole point of the
 *      model is that you own the code, but that also means "which upstream
 *      revision is this?" is lost. This script records the source URL, the date
 *      and a content hash per file, so an update is a reviewable diff instead
 *      of a mystery.
 *   3. **It is auditable before it writes.** Every file is printed and every
 *      npm dependency is collected, so nothing arrives unannounced.
 *
 * Usage:
 *   node scripts/shadcn-pull.mjs                 # the curated set below
 *   node scripts/shadcn-pull.mjs dialog tooltip  # specific components
 *   node scripts/shadcn-pull.mjs --list          # what is available upstream
 *
 * Components are TypeScript. That is fine: Vite strips types from `.vue`
 * `<script setup lang="ts">` and `.ts` files via esbuild without a tsconfig, so
 * keeping the upstream files verbatim means future updates apply cleanly.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const REGISTRY = 'https://shadcn-vue.com/r/styles/new-york-v4';
const OUT_DIR = path.join(root, 'src', 'components', 'ui');
const LOCK = path.join(root, 'src', 'components', 'ui', '.shadcn-lock.json');

/**
 * The curated set — this IS the plugin-facing vocabulary (docs/UI.md).
 *
 * Deliberately not "everything upstream ships": every component here becomes
 * part of the API that external plugins can rely on, and a bigger surface is a
 * bigger promise. Additions should be driven by an actual plugin needing one.
 */
const DEFAULT_SET = [
  // primitives — what a plugin view is built from
  'button',
  'card',
  'input',
  'label',
  'badge',
  'table',
  'separator',
  'textarea',
  'skeleton',
  'spinner',
  // form controls
  'select',
  'checkbox',
  'switch',
  'slider',
  // structure
  'tabs',
  'scroll-area',
  'collapsible',
];

const args = process.argv.slice(2);

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

if (args.includes('--list')) {
  const index = await getJson(`${REGISTRY.replace(/\/styles\/.*/, '')}/index.json`);
  console.log(index.filter((x) => x.type === 'registry:ui').map((x) => x.name).join('\n'));
  process.exit(0);
}

const wanted = args.filter((a) => !a.startsWith('--'));
const components = wanted.length ? wanted : DEFAULT_SET;

/** registry path -> written path, so a re-run can tell "unchanged" from "new". */
const lock = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : { registry: REGISTRY, files: {} };
lock.registry = REGISTRY;
lock.pulledAt = new Date().toISOString();

const deps = new Set();
const summary = [];

for (const name of components) {
  let entry;
  try {
    entry = await getJson(`${REGISTRY}/${name}.json`);
  } catch (e) {
    console.error(`FAILED  ${name}: ${e.message}`);
    process.exitCode = 1;
    continue;
  }
  for (const d of entry.dependencies ?? []) deps.add(d);

  let added = 0;
  let changed = 0;
  let same = 0;

  for (const file of entry.files ?? []) {
    // `registry/new-york-v4/ui/button/Button.vue` -> `button/Button.vue`
    const m = file.path.match(/^registry\/[^/]+\/ui\/(.+)$/);
    if (!m) {
      console.error(`FAILED  ${name}: unexpected registry path "${file.path}"`);
      process.exitCode = 1;
      continue;
    }
    const rel = m[1];
    const dest = path.join(OUT_DIR, rel);

    // Safety: never write outside src/components/ui, whatever the registry says.
    if (!path.resolve(dest).startsWith(path.resolve(OUT_DIR) + path.sep)) {
      console.error(`REFUSED ${name}: "${rel}" escapes ${OUT_DIR}`);
      process.exitCode = 1;
      continue;
    }

    const hash = createHash('sha256').update(file.content).digest('hex').slice(0, 12);
    const before = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    if (before === null) added += 1;
    else if (before !== file.content) changed += 1;
    else same += 1;

    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, file.content, 'utf8');
    lock.files[rel] = { component: name, sha256: hash };
  }

  summary.push({ name, added, changed, same });
}

writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');

const w = (n, s) => String(s).padStart(n);
console.log(`registry: ${REGISTRY}`);
console.log(`target:   src/components/ui/`);
console.log('');
console.log('component          new  updated  unchanged');
for (const s of summary) {
  console.log(`${s.name.padEnd(18)} ${w(3, s.added)}  ${w(7, s.changed)}  ${w(9, s.same)}`);
}
console.log('');
console.log(`npm dependencies needed: ${[...deps].sort().join(', ') || '(none)'}`);
console.log(`lockfile written: src/components/ui/.shadcn-lock.json`);
