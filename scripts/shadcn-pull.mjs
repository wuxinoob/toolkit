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

/**
 * Rewrite the registry's internal import paths to the project's aliases.
 *
 * The registry ships components that import each other by their REGISTRY path,
 * e.g. `dialog/DialogFooter.vue` does
 * `import { Button } from "@/registry/new-york-v4/ui/button"` — which does not
 * exist in a real project. The official CLI rewrites these while writing; we
 * materialise files ourselves, so we have to do the same. Without it the build
 * fails with a confusing "could not load src/registry/…".
 */
function rewriteRegistryPaths(content) {
  return content.replace(/@\/registry\/[^/]+\/ui\//g, '@/components/ui/');
}

/**
 * Local patches, applied to the pulled content on EVERY run.
 *
 * A warning is not enough: a re-pull overwrites the working file, so a patch
 * that is merely *tracked* gets silently reverted the next time someone runs
 * this script. (That happened while writing this — hence the design.) Making the
 * patch a transformation means a pull is idempotent and the patch cannot be
 * lost, and because it re-runs on fresh upstream content it also cannot rot.
 *
 * `forwardPortalTo` exists because reka-ui's portals teleport to `document.body`
 * by default, which puts plugin popups OUTSIDE the plugin's `[data-plugin]`
 * scope — so `contributes.theme` would style a plugin's button but not its own
 * dropdown ("purple button, blue menu"). The upstream wrappers don't forward the
 * portal target, so we add it.
 */
function forwardPortalTo(content, { portalTag, propsType }) {
  // Regex, not an exact string: upstream's props blocks differ per component
  // (DialogContent already carries `showCloseButton`), and an exact match that
  // silently misses leaves a template referencing an undeclared prop — which
  // looks like it works, and quietly portals to <body>.
  const propsRe = new RegExp(`defineProps<\\s*${propsType}\\s*&\\s*\\{([^}]*)\\}\\s*>`);
  let out = content.replace(propsRe, (_m, inner) => {
    const cleaned = inner.trim().replace(/[;,]\s*$/, '');
    return `defineProps<${propsType} & { ${cleaned}; portalTo?: string }>`;
  });
  // It belongs on the Portal, not on the content element — keep it out of the
  // props that get forwarded there, or it lands as an invalid DOM attribute.
  out = out.replace('reactiveOmit(props, "class")', 'reactiveOmit(props, "class", "portalTo")');
  out = out.replace(`<${portalTag}>`, `<${portalTag} :to="props.portalTo">`);

  // All three edits must land. Checking only for the string "portalTo" would
  // pass on a partial patch — which is exactly the bug this replaces.
  const missing = [];
  if (!out.includes('portalTo?: string')) missing.push('props declaration');
  if (!out.includes('"portalTo")')) missing.push('reactiveOmit');
  if (!out.includes(`:to="props.portalTo"`)) missing.push(`${portalTag} target`);
  if (missing.length) {
    throw new Error(
      `forwardPortalTo(${propsType}): could not patch ${missing.join(', ')} — upstream shape changed`,
    );
  }
  return out;
}

const LOCAL_PATCHES = {
  'select/SelectContent.vue': {
    why: 'forwards portalTo to SelectPortal so a plugin dropdown stays theme-scoped',
    apply: (src) => forwardPortalTo(src, { portalTag: 'SelectPortal', propsType: 'SelectContentProps' }),
  },
  'dialog/DialogContent.vue': {
    why: 'forwards portalTo to DialogPortal so a plugin dialog stays theme-scoped',
    apply: (src) => forwardPortalTo(src, { portalTag: 'DialogPortal', propsType: 'DialogContentProps' }),
  },
};

/**
 * Bare imports actually present in the written files.
 *
 * The registry's own `dependencies` field is NOT trustworthy: `button` declares
 * only `reka-ui`, yet its `index.ts` imports `class-variance-authority`. Deriving
 * the list from the file contents means the report cannot miss one — which
 * matters because the report is the only warning that a new package is needed.
 */
function bareImportsIn(rel, content, acc) {
  for (const m of content.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    if (spec.startsWith('@/')) continue; // the app's own path alias, not a package
    // `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub` -> `pkg`
    const parts = spec.split('/');
    acc.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }
  return acc;
}

/** Packages that are part of the app or its toolchain, not component deps. */
const NOT_A_DEP = new Set(['vue']);

const deps = new Set();
const summary = [];
const warnings = [];

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

    let content = rewriteRegistryPaths(file.content);
    if (LOCAL_PATCHES[rel]) content = LOCAL_PATCHES[rel].apply(content);
    const hash = createHash('sha256').update(file.content).digest('hex').slice(0, 12);
    const before = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    // What upstream looked like at the LAST pull. Comparing against this (rather
    // than against the working file) is what lets a patched file differ from
    // upstream without crying wolf every run: a local patch is expected, an
    // upstream move is the thing that needs a human.
    const upstreamBefore = lock.files[rel]?.sha256 ?? null;
    if (before === null) added += 1;
    else if (before !== content) changed += 1;
    else same += 1;

    if (LOCAL_PATCHES[rel] && upstreamBefore && upstreamBefore !== hash) {
      // The patch re-applied cleanly (it throws otherwise), but a human should
      // still confirm it still means what it meant.
      warnings.push(
        `${rel}: upstream moved ${upstreamBefore} -> ${hash}; the local patch re-applied (${LOCAL_PATCHES[rel].why}) — please review`,
      );
    }

    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content, 'utf8');
    bareImportsIn(rel, content, deps);
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
console.log(`npm dependencies needed: ${[...deps].filter((d) => !NOT_A_DEP.has(d)).sort().join(', ')}`);
console.log(`lockfile written: src/components/ui/.shadcn-lock.json`);
if (warnings.length) {
  console.log('');
  console.log('!! locally patched files that upstream also changed:');
  for (const w of warnings) console.log(`   ${w}`);
}
