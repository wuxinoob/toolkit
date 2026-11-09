// Browser boundaries for exercising the real main entry without starting Tauri.
export async function resolve(specifier, context, next) {
  if (!context.parentURL?.includes('/src/main.js')) return next(specifier, context);
  const sources = {
    vue: `
      export function createApp() {
        return { mount() { globalThis.__startupTest.trace.push('mount'); } };
      }
      export async function nextTick() { globalThis.__startupTest.trace.push('dom-ready'); }
    `,
    '@tauri-apps/api/window': `
      export function getCurrentWindow() {
        if (globalThis.__startupTest.browser) throw new Error('no Tauri window');
        return {
          label: globalThis.__startupTest.label,
          show() {
            globalThis.__startupTest.trace.push('show');
            globalThis.__startupTest.onShow?.();
            return globalThis.__startupTest.show;
          },
        };
      }
    `,
    './host/theme.js': 'export function initTheme() {}',
    './host/boot.js': `
      globalThis.__startupTest.trace.push('host-module');
      export async function boot() { globalThis.__startupTest.trace.push('boot'); }
    `,
    './App.vue': `
      globalThis.__startupTest.trace.push('app-module');
      export default {};
    `,
    './assets/app.css': 'export default {};',
  };
  const source = sources[specifier];
  return source === undefined ? next(specifier, context) : {
    url: `data:text/javascript,${encodeURIComponent(source)}`,
    shortCircuit: true,
  };
}
