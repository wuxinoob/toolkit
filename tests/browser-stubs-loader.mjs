/**
 * Node module customization hook: stub browser-only modules.
 *
 * Two things in the plugin modules cannot be resolved by Node but are handled
 * natively by Vite:
 *
 *   1. CSS imports            `import '@xterm/xterm/css/xterm.css'`
 *   2. browser-only packages  `@xterm/xterm` (UMD build has no named ESM exports)
 *
 * Stubbing them lets the REAL plugin modules be imported under `node --test`,
 * so the boot path can be smoke-tested outside the webview. Only what module
 * evaluation touches is faked — the render functions that would need a real
 * terminal are never called by the boot path.
 *
 * Registered from a test via `register('./browser-stubs-loader.mjs', import.meta.url)`
 * before anything is dynamically imported.
 */

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
