"""One-off patch: move plugin call sites to the unified async event API.

Kept as a script file rather than a shell heredoc because the sources contain
template literals (${...}) that a shell would try to expand.
"""
import pathlib
import sys

changed = []


def patch(rel, old, new, required=True):
    p = pathlib.Path(rel)
    s = p.read_text(encoding='utf-8')
    if old not in s:
        if required:
            print(f'MISS  {rel}: pattern not found')
            sys.exit(1)
        return
    p.write_text(s.replace(old, new, 1), encoding='utf-8')
    changed.append(rel)


# ---- streamlab: the in-process experiment must await the new async shapes ----
patch(
    'src/plugins/streamlab.js',
    """async function runLocal() {
  const { ctx } = state;
  log('tx', 'in-process → emit lab.local');
  const off = ctx.events.on('lab.local', (p) => log('rx', `in-process ← ${JSON.stringify(p)} (synchronous)`));
  ctx.events.emit('lab.local', { n: 1 });
  off();
}""",
    """async function runLocal() {
  const { ctx } = state;
  log('tx', 'in-process → emit lab.local');
  // every subscription is async and every scheme has the same shape, so this
  // call site is identical to the event-bus one above
  const off = await ctx.events.on('lab.local', (p) => log('rx', `in-process ← ${JSON.stringify(p)}`));
  await ctx.events.emit('lab.local', { n: 1 });
  off();
}""",
)

# ---- probe: same shape, plus a schema and a hotkey step ----
patch(
    'examples/plugins/probe/main.js',
    """  await step('local event', 'in-process', async () => {
    let got = null;
    const off = ctx.events.on('probe.local', (p) => (got = p));
    ctx.events.emit('probe.local', { n: 1 });
    off();
    if (got?.n !== 1) throw new Error('not delivered synchronously');
    return 'delivered synchronously, zero IPC';
  });""",
    """  await step('local event', 'in-process', async () => {
    let got = null;
    const off = await ctx.events.on('probe.local', (p) => (got = p));
    await ctx.events.emit('probe.local', { n: 1 });
    off();
    if (got?.n !== 1) throw new Error('not delivered');
    return 'delivered over the in-process scheme, zero IPC';
  });

  // ---- 7. negotiation surface: ask what the host supports ----
  await step('host schema', 'rpc', async () => {
    const schema = await ctx.schema();
    if (schema.protocol !== 1) throw new Error('protocol version not reported');
    const services = Object.keys(schema.services || {});
    if (services.length < 5) throw new Error('services not listed: ' + JSON.stringify(services));
    if (!schema.services.storage?.includes('get')) throw new Error('storage actions missing');
    if (!Array.isArray(schema.schemes) || schema.schemes.length !== 7) throw new Error('schemes missing');
    return services.length + ' services, ' + schema.schemes.length + ' schemes, providers=' + schema.providers;
  });

  // ---- 8. a declared hotkey is registered by the host on our behalf ----
  await step('hotkey registration', 'rpc', async () => {
    const { keys } = await ctx.rpc('hotkey', 'list', {});
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error('no hotkey registered (declared in contributes.hotkeys)');
    }
    return 'host holds ' + JSON.stringify(keys) + ' for this plugin';
  });""",
)

# ---- hello example: await the subscription so it is live before activate ends ----
patch(
    'examples/plugins/hello/main.js',
    """  // A broadcast from ANY window lands here (this is the cross-window path).
  ctx.bus.subscribe('hello.ping', (env) => log(`broadcast from ${env.svc}: ${JSON.stringify(env.p)}`, '#9fe8a9'));""",
    """  // A broadcast from ANY window lands here (this is the cross-window path).
  // Subscriptions are async on every scheme, so this is awaited like any other.
  await ctx.bus.subscribe('hello.ping', (env) =>
    log(`broadcast from ${env.svc}: ${JSON.stringify(env.p)}`, '#9fe8a9'),
  );""",
)

# ---- floatwin: settings-changed subscription must be awaited too ----
patch(
    'src/plugins/notepad.js',
    """  const off = await ctx.bus.subscribe('notepad.changed', (env) => {
    if (env.svc === ctx.id) return; // ignore our own echo
    ctx.log.info('notepad.changed from another window', env.p);
  });
  ctx.cleanup(off);""",
    """  const off = await ctx.bus.subscribe('notepad.changed', (env) => {
    if (env.svc === ctx.id) return; // ignore our own echo
    ctx.log.info('notepad.changed from another window', env.p);
  });
  ctx.cleanup(off);""",
    required=False,
)

# ---- probe manifest: declare the hotkey and the permission to read it back ----
patch(
    'examples/plugins/probe/plugin.json',
    """  "contributes": {
    "views": [{ "slot": "tool", "id": "probe", "title": "Plane Probe", "icon": "🧭" }]
  },
  "permissions": ["rpc:storage", "rpc:host", "rpc:stream", "rpc:bus"]""",
    """  "contributes": {
    "views": [{ "slot": "tool", "id": "probe", "title": "Plane Probe", "icon": "🧭" }],
    "hotkeys": [{ "key": "ctrl+alt+shift+p", "action": "probe" }]
  },
  "permissions": ["rpc:storage", "rpc:host", "rpc:stream", "rpc:bus", "rpc:hotkey"]""",
)

patch(
    'examples/plugins/probe/main.js',
    """  contributes: {
    views: [{ slot: 'tool', id: 'probe', title: 'Plane Probe', icon: '🧭' }],
  },
  permissions: ['rpc:storage', 'rpc:host', 'rpc:stream', 'rpc:bus'],""",
    """  contributes: {
    views: [{ slot: 'tool', id: 'probe', title: 'Plane Probe', icon: '🧭' }],
    // Declared here and registered by the HOST at activate — a plugin never
    // touches the shortcut API itself.
    hotkeys: [{ key: 'ctrl+alt+shift+p', action: 'probe' }],
  },
  permissions: ['rpc:storage', 'rpc:host', 'rpc:stream', 'rpc:bus', 'rpc:hotkey'],""",
)

print('patched: ' + ', '.join(dict.fromkeys(changed)))
