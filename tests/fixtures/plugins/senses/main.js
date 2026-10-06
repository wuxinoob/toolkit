/**
 * Senses — a live check of the host's sensing surface.
 *
 * Three capabilities, all of which need a real machine and a real user, so none
 * of them can be covered by the in-app selftest:
 *
 *   ctx.clipboard.read / write     request/response
 *   ctx.clipboard.watch            a STREAM — the host pushes on change
 *   ctx.screen.monitors / capture  request/response (capture returns base64 PNG)
 *   ctx.onDrop                     OS drag-and-drop, routed to the active view
 *
 * ## Why it throws at activation
 *
 * Everything except the write probe runs inside `activate()` and a failure
 * throws, so a broken interface shows up as a red plugin in the boot log rather
 * than as a view that quietly renders nothing. That is the pattern in
 * `docs/plugin-dev/recipes.md` ("让插件出问题时启动日志直接变红"), and it is why
 * this plugin exists at all: `probe.demo` checks the message plane, this one
 * checks the three interfaces that reach OUT of the app.
 *
 * The cost is that `activate()` is slower than the docs recommend — one screen
 * capture is ~100–300 ms. That is deliberate for a check plugin and would not be
 * for a real one.
 *
 * ## The one thing it will NOT do on its own
 *
 * **It never writes to the clipboard without asking.** A write is destructive —
 * it replaces whatever the user had — so the round-trip check is a BUTTON, not
 * part of activation. A plugin that silently clobbers the clipboard while
 * checking that it can is a plugin that deserves to be uninstalled.
 */

export const manifest = {
  id: 'senses.demo',
  name: 'Senses',
  version: '0.1.0',
  api: 4,
  description: 'Live check of clipboard, screen capture and OS file drops.',
  contributes: {
    views: [{ slot: 'tool', id: 'senses', title: 'Senses', icon: 'lucide:eye' }],
    theme: {
      dark: { '--color-brand': '#c084fc', '--color-brand-hover': '#d0a0ff' },
      light: { '--color-brand': '#7c3aed', '--color-brand-hover': '#6d28d9' },
    },
  },
  // `rpc:stream` is not visible to the static permission audit (it is required
  // inside `ctx.stream`, which `ctx.clipboard.watch` calls), but it IS required
  // at runtime: `watch` opens a stream, and a provider may add a permission of
  // its own on top — `clipboard` does, which is why `rpc:clipboard` is here too.
  //
  // `rpc:screen` is spelled out even though it is *derived* (`plugin_rpc` checks
  // `rpc:<service>`, so registering the `screen` service creates it). Deriving a
  // permission is not the same as declaring it: `plugin_register` hands the host
  // exactly this list, and the gateway then checks membership. Omitting it is
  // how the first version of this plugin shipped broken — it failed activation
  // with `missing permission "rpc:screen"`, which is the failure mode this
  // plugin exists to make visible.
  permissions: ['rpc:clipboard', 'rpc:stream', 'rpc:screen'],
};

const state = {
  ctx: null,
  checks: [],
  clip: '',
  watch: null,
  drops: [],
  shot: null,
  writeNote: '',
  draw: null,
};

/* ------------------------------- activation -------------------------------- */

export async function activate(ctx) {
  state.ctx = ctx;

  // Ordered fastest-first, so a failure points at the first thing that broke
  // rather than at whatever happened to run.
  await check('clipboard.read', async () => {
    const r = await ctx.clipboard.read();
    if (!r || (r.text !== null && typeof r.text !== 'string')) {
      throw new Error(`expected { text }, got ${JSON.stringify(r)}`);
    }
    // `null` is a normal answer (empty clipboard, or it holds an image) — the
    // host only errors when it cannot OPEN the clipboard at all.
    return r.text === null ? 'empty (text: null)' : `${r.text.length} char(s)`;
  });

  await check('screen.monitors', async () => {
    const list = await ctx.screen.monitors();
    if (!Array.isArray(list) || list.length === 0) throw new Error('no monitors');
    return list
      .map((m) => `${m.name} ${m.width}×${m.height}${m.primary ? ' (primary)' : ''}`)
      .join(' · ');
  });

  await check('screen.capture', async () => {
    const shot = await ctx.screen.capture();
    if (!shot?.png) throw new Error('no png in the response');
    state.shot = shot;
    return `${shot.width}×${shot.height}, ${Math.round(shot.bytes / 1024)} KB png`;
  });

  await check('clipboard.watch', async () => {
    state.watch = await ctx.clipboard.watch('clip', {
      intervalMs: 400,
      onFrame: (env) => {
        state.clip = env?.p?.text ?? '';
        state.draw?.();
      },
      onEnd: () => {
        state.watch = null;
        state.draw?.();
      },
    });
    return 'stream open — copy something and it appears here';
  });

  await check('onDrop', async () => {
    ctx.onDrop((paths, info) => {
      state.drops.unshift({ paths, viewId: info.viewId, at: new Date().toISOString().slice(11, 19) });
      state.draw?.();
    });
    return 'subscribed — drop a file on THIS view to prove it';
  });

  ctx.registerView('senses', render);
  ctx.log.info(`ready — ${state.checks.length} interface check(s) passed`);
}

async function check(name, fn) {
  try {
    state.checks.push({ name, ok: true, detail: await fn() });
  } catch (e) {
    const detail = String(e?.message ?? e);
    state.checks.push({ name, ok: false, detail });
    // Fail the activation, so the boot log says `error` with the reason.
    throw new Error(`${name}: ${detail}`);
  }
}

export async function deactivate() {
  // The watch is a stream, so the host's disposer closes it either way — this is
  // here to show that a plugin CAN, and to drop the reference.
  state.watch = null;
  state.draw = null;
}

/* ------------------------------ the write probe ----------------------------- */

/**
 * Save → write → read back → restore.
 *
 * The restore is the point: a probe that leaves the user's clipboard holding
 * `senses-probe-…` has broken the thing it was checking.
 */
async function writeProbe() {
  const before = (await state.ctx.clipboard.read()).text;
  const probe = `senses-probe-${Date.now()}`;
  try {
    const w = await state.ctx.clipboard.write(probe);
    if (!w?.written) throw new Error('write did not report success');
    const back = (await state.ctx.clipboard.read()).text;
    if (back !== probe) throw new Error(`read back ${JSON.stringify(back)}, expected the probe`);
    state.writeNote = 'write → read round trip OK (clipboard restored)';
  } catch (e) {
    state.writeNote = `write probe FAILED: ${e?.message ?? e}`;
  } finally {
    // Best effort: if this fails the user's clipboard is left holding the probe,
    // which is worth a note rather than silence.
    try {
      if (before === null) await state.ctx.clipboard.write('');
      else await state.ctx.clipboard.write(before);
    } catch (e) {
      state.writeNote += ` — could not restore the clipboard: ${e?.message ?? e}`;
    }
    state.draw?.();
  }
}

/* --------------------------------- the view -------------------------------- */

function render(root) {
  const { el, render: draw } = state.ctx.ui;
  state.draw = draw;

  const row = (name, ok, detail) =>
    el(
      'div',
      { class: 'tb-row', style: 'align-items:flex-start;gap:8px;' },
      el('span', { class: `tb-dot ${ok ? 'tb-dot-ok' : 'tb-dot-bad'}`, style: 'margin-top:5px;' }),
      el(
        'div',
        { style: 'display:flex;flex-direction:column;gap:1px;min-width:0;' },
        el('span', { class: 'tb-mono' }, name),
        el('span', { class: 'tb-hint', style: 'word-break:break-word;' }, detail),
      ),
    );

  draw(
    root,
    el(
      'div',
      { class: 'tb-pane tb-pane-pad', style: 'display:flex;flex-direction:column;gap:12px;height:100%;' },

      el(
        'div',
        {},
        el('div', { class: 'tb-section-title', style: 'margin:0;' }, 'Senses'),
        el(
          'div',
          { class: 'tb-hint', style: 'margin-top:2px;' },
          'Clipboard, screen capture and OS file drops. The three interfaces that reach out of the ' +
            'app — none of them can be covered by the in-app selftest, because it has no screen and ' +
            'no user to copy or drag.',
        ),
      ),

      el(
        'div',
        { class: 'tb-card' },
        el('div', { class: 'tb-card-head' }, 'Checks at activation'),
        el(
          'div',
          { class: 'tb-card-body', style: 'display:flex;flex-direction:column;gap:6px;' },
          ...state.checks.map((c) => row(c.name, c.ok, c.detail)),
        ),
      ),

      el(
        'div',
        { class: 'tb-card' },
        el(
          'div',
          { class: 'tb-card-head' },
          'Clipboard watch',
          el('span', { class: `tb-badge ${state.watch ? 'tb-badge-ok' : 'tb-badge-warn'}` }, state.watch ? 'streaming' : 'not streaming'),
        ),
        el(
          'div',
          { class: 'tb-card-body', style: 'display:flex;flex-direction:column;gap:8px;' },
          el(
            'div',
            { class: 'tb-mono', style: 'white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto;' },
            state.clip === '' ? '(nothing on the clipboard)' : state.clip,
          ),
          el(
            'div',
            { style: 'display:flex;flex-wrap:wrap;gap:6px;' },
            el('button', { class: 'tb-btn tb-btn-sm', onClick: writeProbe }, 'Write round trip'),
            state.writeNote
              ? el('span', { class: 'tb-hint', style: 'align-self:center;' }, state.writeNote)
              : null,
          ),
          el(
            'div',
            { class: 'tb-hint' },
            'The write probe saves your clipboard first and restores it. Nothing here writes to it ' +
              'unless you press that button.',
          ),
        ),
      ),

      state.shot
        ? el(
            'div',
            { class: 'tb-card' },
            el(
              'div',
              { class: 'tb-card-head' },
              'Screen',
              el('span', { class: 'tb-badge' }, `${state.shot.width}×${state.shot.height}`),
            ),
            el(
              'div',
              { class: 'tb-card-body' },
              el('img', {
                src: `data:image/png;base64,${state.shot.png}`,
                style: 'max-width:100%;border-radius:6px;border:1px solid var(--color-border);',
                alt: 'captured screen',
              }),
            ),
          )
        : null,

      el(
        'div',
        { class: 'tb-card' },
        el(
          'div',
          { class: 'tb-card-head' },
          'File drops',
          el('span', { class: `tb-badge ${state.drops.length ? 'tb-badge-ok' : ''}` }, `${state.drops.length}`),
        ),
        el(
          'div',
          { class: 'tb-card-body', style: 'display:flex;flex-direction:column;gap:6px;' },
          el(
            'div',
            { class: 'tb-hint' },
            'Drop a file anywhere on this view. The host routes a drop to the ACTIVE view only, so ' +
              'this one has to be the one you are looking at — and if it is not, the boot log says ' +
              '"no listener for view …" rather than staying silent.',
          ),
          ...state.drops.map((d) =>
            el(
              'div',
              { class: 'tb-row' },
              el('span', { class: 'tb-t-dim tb-mono' }, d.at),
              el('span', { class: 'tb-mono', style: 'word-break:break-all;' }, d.paths.join(', ')),
            ),
          ),
        ),
      ),
    ),
  );
}

// The loader takes `mod.default || mod`, and both shapes work — the default
// export is what `docs/plugin-dev/api.md` prescribes and what the example audit
// looks for, so this is the documented shape rather than the built-in one.
export default { manifest, activate, deactivate };
