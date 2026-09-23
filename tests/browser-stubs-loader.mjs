/**
 * Node module customization hook: stub browser-only modules.
 *
 * Three things cannot be resolved by Node but are handled natively by Vite:
 *
 *   1. CSS imports            `import '@xterm/xterm/css/xterm.css'`
 *   2. browser-only packages  `@xterm/xterm` (UMD build has no named ESM exports)
 *   3. Vue SFCs + `import.meta.glob`
 *
 * Stubbing them lets the REAL plugin modules be imported under `node --test`,
 * so the boot path can be smoke-tested outside the webview. Only what module
 * evaluation touches is faked — the render functions that would need a real
 * terminal are never called by the boot path.
 *
 * ## Why the component stubs matter
 *
 * Built-in plugin views are built through `ctx.ui` (see src/host/ui.js), which
 * loads `src/components/ui/*` — `.vue` and `.ts` files, plus an
 * `import.meta.glob` that simply does not exist in Node. Without stubs the boot
 * test would fail for a reason that has nothing to do with the boot path.
 *
 * The stubs keep the SHAPE of every module real: the tag names come from the
 * actual `index.ts` files on disk, so `ctx.ui.el('card-header')` still resolves
 * and a typo still throws. What is faked is only the rendering — a stub
 * component renders its slot and nothing else. That means the boot test still
 * catches bad tag names and malformed trees, which is the part worth testing
 * outside a browser.
 *
 * Registered from a test via `register('./browser-stubs-loader.mjs', import.meta.url)`
 * before anything is dynamically imported.
 *
 * ## Why `@tauri-apps/api/core` is NOT stubbed here
 *
 * It was, briefly, and it broke the boot test. The reason is worth keeping:
 * `boot.test.mjs` installs `window.__TAURI_INTERNALS__.invoke` and records the
 * calls, which works precisely BECAUSE the real `@tauri-apps/api/core` is still
 * in play — it is a thin wrapper over that global. Stubbing the module replaces
 * the wrapper and quietly disconnects the recorder.
 *
 * So to control host calls, shim `window.__TAURI_INTERNALS__` in the test, not
 * this module. Same trick, and it keeps the layer under test real.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const UI_DIR = fileURLToPath(new URL('../src/components/ui', import.meta.url));

const STUBS = new Map([
  [
    '@xterm/xterm',
    `export class Terminal {
       constructor(o = {}) { this.options = o; this.cols = o.cols ?? 80; this.rows = o.rows ?? 24; }
       open() {} loadAddon() {} write() {} dispose() {} onData() { return { dispose() {} }; }
     }`,
  ],
  [
    '@xterm/addon-fit',
    `export class FitAddon { fit() {} activate() {} dispose() {} }`,
  ],
]);

/** Component export names in one `index.ts`, without importing it. */
function componentNames(indexSrc) {
  const names = new Set();
  for (const m of indexSrc.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = (part.includes(' as ') ? part.split(' as ')[1] : part).trim();
      if (/^[A-Z]/.test(name)) names.add(name);
    }
  }
  return [...names];
}

/** `src/components/ui` -> { 'button': [names], … } */
function componentDirs() {
  const out = new Map();
  if (!existsSync(UI_DIR)) return out;
  for (const dir of readdirSync(UI_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const index = path.join(UI_DIR, dir.name, 'index.ts');
    if (!existsSync(index)) continue;
    out.set(dir.name, componentNames(readFileSync(index, 'utf8')));
  }
  return out;
}

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.css')) {
    return { url: 'data:text/javascript,export%20default%20{}', shortCircuit: true };
  }
  if (STUBS.has(specifier)) {
    const src = encodeURIComponent(STUBS.get(specifier));
    return { url: `data:text/javascript,${src}`, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  // `import.meta.glob` is a Vite macro with no Node equivalent. Hand back the
  // same shape it would produce: tag dir -> lazy module loader.
  if (url.includes('/src/host/uiComponents.js')) {
    const entries = [...componentDirs().keys()]
      .map((d) => `  ${JSON.stringify(d)}: () => import(${JSON.stringify(`../components/ui/${d}/index.ts`)}),`)
      .join('\n');
    return {
      format: 'module',
      shortCircuit: true,
      source: `export const componentModules = {\n${entries}\n};\n`,
    };
  }

  // A component index: real export names, stubbed implementations.
  if (url.includes('/src/components/ui/') && url.endsWith('/index.ts')) {
    const src = readFileSync(fileURLToPath(url), 'utf8');
    const names = componentNames(src);
    const body = names
      .map(
        (n) =>
          `export const ${n} = { name: ${JSON.stringify(n)}, ` +
          `render() { return this.$slots?.default?.() ?? null; } };`,
      )
      .join('\n');
    return { format: 'module', shortCircuit: true, source: `${body}\n` };
  }

  // A component SFC referenced directly (never by the kit, but keep it cheap).
  if (url.includes('/src/components/ui/') && url.includes('.vue')) {
    return { format: 'module', shortCircuit: true, source: 'export default { render() { return null; } };\n' };
  }

  return next(url, context);
}
