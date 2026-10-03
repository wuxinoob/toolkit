/**
 * Development harness: render a built-in plugin view without Tauri.
 *
 * A plugin cannot activate in a plain browser — the first thing the loader does
 * is register with the native permission gate — so there is otherwise NO way to
 * look at a plugin's view while migrating it. This page supplies a mock `ctx`
 * (the same shape `host/ctx.js` builds) and drives the plugin's real `activate`
 * and `registerView`, so what you see is the plugin's actual render output.
 *
 *   npm run dev  ->  http://127.0.0.1:1420/plugin-preview.html?plugin=notepad
 *
 * Everything the plugins touch is faked EXCEPT the parts that matter for
 * rendering: `ctx.ui` is the real component factory, and `ctx.protocol` is the
 * real contract. Storage and the bus are in-memory, and the process/stream
 * calls reject — a plugin that depends on them will show its error path, which
 * is itself worth seeing.
 *
 * DEV ONLY: `vite build` takes only `index.html` as an entry, so this never
 * reaches the bundle.
 */
import '../src/assets/app.css';
import { createUiKit, loadUiKit } from '../src/host/ui.js';
import { protocolContract } from '../src/protocol/contract.js';
import { describeSchemes } from '../src/protocol/registry.js';

const modules = {
  ...import.meta.glob('../src/plugins/*.js'),
  ...import.meta.glob('../tests/fixtures/plugins/*/main.js'),
  ...import.meta.glob('../tests/fixtures/calc-plugin/main.js'),
};

const q = new URLSearchParams(location.search);
const want = q.get('plugin');

const notImplemented = (what) => () => Promise.reject(new Error(`${what} is not available in the preview`));

/** An in-memory `ctx` — same shape as host/ctx.js, minus anything native. */
function makeCtx(manifest, views, kit) {
  const store = new Map();
  const listeners = new Map();
  const disposers = [];

  const emit = (topic, payload) => {
    for (const fn of listeners.get(topic) ?? []) {
      try {
        fn({ kind: 'evt', topic, svc: manifest.id, p: payload });
      } catch (e) {
        console.error('[preview] listener failed', e);
      }
    }
  };

  return {
    id: manifest.id,
    manifest,
    protocol: protocolContract(),

    registerView: (viewId, render) => {
      const decl = (manifest.contributes?.views ?? []).find((v) => v.id === viewId);
      views.set(viewId, { render, decl });
    },
    cleanup: (fn) => disposers.push(fn),

    storage: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => {
        store.set(k, v);
        return true;
      },
      remove: async (k) => store.delete(k),
      keys: async () => [...store.keys()],
    },

    bus: {
      subscribe: async (topic, fn) => {
        if (!listeners.has(topic)) listeners.set(topic, []);
        listeners.get(topic).push(fn);
        return () => listeners.set(topic, (listeners.get(topic) ?? []).filter((f) => f !== fn));
      },
      publish: async (topic, payload) => {
        emit(topic, payload);
        return { delivered: (listeners.get(topic) ?? []).length };
      },
    },
    events: {
      on: async (topic, fn) => {
        if (!listeners.has(topic)) listeners.set(topic, []);
        listeners.get(topic).push(fn);
        return () => listeners.set(topic, (listeners.get(topic) ?? []).filter((f) => f !== fn));
      },
      emit: async (topic, payload) => emit(topic, payload),
    },

    log: { info: (...a) => console.info('[plugin]', ...a), warn: (...a) => console.warn('[plugin]', ...a) },

    ui: {
      notify: (msg, type) => console.info(`[notify:${type ?? 'info'}] ${msg}`),
      mountOverlay: (el) => document.body.appendChild(el),
      unmountOverlay: (el) => el?.remove(),
      ...kit,
    },

    // Host-side reads that are safe to fake.
    sessions: async () => [],
    schemes: () => describeSchemes(),
    schema: notImplemented('host/schema'),
    rpc: notImplemented('rpc'),
    request: notImplemented('request'),

    // Anything that needs native code. Failing loudly is better than a silent
    // no-op: a plugin that reaches for these shows its error path.
    pty: notImplemented('pty'),
    stream: notImplemented('stream'),
    streamRaw: notImplemented('streamRaw'),
    sidecar: notImplemented('sidecar'),
    uplink: notImplemented('uplink'),
    windows: {
      create: notImplemented('windows.create'),
      control: notImplemented('windows.control'),
      exists: async () => false,
      onCloseRequested: async () => {},
    },

    dispose: () => {
      for (const fn of disposers.reverse()) {
        try {
          fn();
        } catch {
          /* already gone */
        }
      }
    },
  };
}

function show(message, detail) {
  const root = document.getElementById('app');
  root.className = 'tb-content';
  root.style.padding = '14px';
  root.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'tb-card tb-card-body';
  box.style.maxWidth = '640px';
  box.innerHTML = `<div class="tb-t-bold" style="font-weight:500;margin-bottom:6px"></div><div class="tb-hint tb-mono" style="white-space:pre-wrap"></div>`;
  box.children[0].textContent = message;
  box.children[1].textContent = detail ?? '';
  root.appendChild(box);
}

async function main() {
  const kit = createUiKit({});
  await loadUiKit();

  const entries = Object.entries(modules).filter(([p]) => !/-(supervisor|shared|widget)\.js$/.test(p));
  // `src/plugins/foo.js` -> `foo`, `tests/fixtures/plugins/bar/main.js` -> `bar`
  const nameOf = (p) => {
    const m = p.match(/tests\/fixtures\/plugins\/([^/]+)\/main\.js$/);
    return m ? m[1] : p.replace(/.*\/([^/]+)\.js$/, '$1');
  };
  const names = entries.map(([p]) => nameOf(p));

  const bar = document.createElement('div');
  bar.className = 'tb-toolbar';
  bar.style.cssText = 'padding:10px 14px;border-bottom:1px solid var(--color-line);background:var(--color-surface);position:sticky;top:0;z-index:5;';
  const label = document.createElement('span');
  label.className = 'tb-hint';
  label.textContent = 'plugin preview (mock ctx, no Tauri):';
  bar.appendChild(label);
  for (const n of names) {
    const a = document.createElement('a');
    a.href = `?plugin=${n}`;
    a.className = `tb-btn tb-btn-sm${n === want ? ' tb-btn-primary' : ''}`;
    a.textContent = n;
    a.style.textDecoration = 'none';
    bar.appendChild(a);
  }

  const host = document.getElementById('app');
  host.className = 'tb-content';
  host.style.cssText = 'padding:14px;';
  // `#app` already exists in the page and app.css gives it `height: 100%`.
  // Adding a SECOND element with the same id pushed everything a full viewport
  // down (the first card measured at y≈997 in an 860px window) — a blank
  // screenshot with the text present in the DOM.
  document.body.insertBefore(bar, host);

  if (!want) {
    show('Pick a plugin above.', `available: ${names.join(', ')}`);
    return;
  }

  const entry = entries.find(([p]) => nameOf(p) === want);
  if (!entry) {
    show(`No plugin module named "${want}".`, `available: ${names.join(', ')}`);
    return;
  }

  let mod;
  try {
    mod = await entry[1]();
  } catch (e) {
    show('Failed to import the plugin module.', String(e?.stack ?? e));
    return;
  }

  const plugin = mod.default ?? mod;
  const manifest = plugin.manifest;
  const views = new Map();
  const ctx = makeCtx(manifest, views, kit);

  try {
    if (typeof plugin.activate === 'function') await plugin.activate(ctx);
  } catch (e) {
    show('activate() threw — the view below may be incomplete.', String(e?.stack ?? e));
  }

  const wanted = q.get('view') ?? [...views.keys()][0];
  const view = views.get(wanted);
  if (!view) {
    show(
      `The plugin registered no view${wanted ? ` named "${wanted}"` : ''}.`,
      `registered: ${[...views.keys()].join(', ') || '(none)'}`,
    );
    return;
  }

  // `data-plugin` is what ViewHost sets; the theme scope and any
  // contributes.theme overrides hang off it.
  host.setAttribute('data-plugin', manifest.id);
  const panel = document.createElement('div');
  // An explicit height, because plugin views commonly use `height: 100%` and
  // the real view host fills the content area. Without it a view that relies on
  // that collapses to its content and looks broken for the wrong reason.
  panel.style.height = 'calc(100vh - 130px)';
  host.appendChild(panel);

  try {
    view.render(panel);
  } catch (e) {
    show('view render() threw.', String(e?.stack ?? e));
  }
}

main().catch((e) => show('preview harness failed', String(e?.stack ?? e)));
