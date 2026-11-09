import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { store, saveSettings, toast, closeToTray } from './store.js';
import { armBeacon, disarmBeacon } from './liveness.js';
import { Origin, reconcilePlugins } from './plugins.js';
import { installDebug } from './debug.js';
import { logger } from '../core/logger.js';
import { hub, setTraceSink } from '../protocol/hub.js';
import { withTimeout } from '../protocol/transports/rpc.js';
import { events, DROP_TOPIC } from './events.js';
import { loadUiKit } from './ui.js';
import { checkForUpdate } from './updater.js';

/** Global hotkey that summons (shows + focuses) the main window. */
/** Host identity: the only caller allowed to revoke a plugin registration. */
const HOST_ID = '__host__';

/**
 * The host's own summon hotkey, registered through the SAME service plugins use.
 *
 * It used to go through `@tauri-apps/plugin-global-shortcut` directly, and that
 * was broken in two ways:
 *
 * 1. **It wiped every plugin hotkey.** That JS `unregisterAll()` calls the
 *    plugin's `unregister_all`, which does `mem::take` on the shortcut manager —
 *    and `hotkey/register` puts plugin shortcuts in that same manager. `boot()`
 *    registers plugins first and then called this, so on every launch every
 *    plugin hotkey was registered and immediately erased. The feature had never
 *    worked. The service's `unregister_all` is scoped by OWNER, so going through
 *    it releases only the host's own binding.
 *
 * 2. **It could not restore a minimised window.** `show()` + `setFocus()` on a
 *    minimised window does nothing on Windows — the same silent failure the
 *    `raise` op exists to fix for plugins. A summon key that cannot summon is
 *    the one case where the failure is guaranteed to be noticed, and only at the
 *    moment the user needed it.
 *
 * So: one registration path, one release path, and the same three calls in the
 * same order as `ctx.windows.control(label, 'raise')`.
 */
export async function applySummonShortcut() {
  const shortcut = store.settings.summonShortcut;

  // Owner-scoped, so plugin hotkeys survive. Best-effort: nothing registered
  // yet is the normal case on the first call.
  await hub
    .request(HOST_ID, 'hotkey', 'unregister_all', { owner: HOST_ID })
    .catch(() => {});

  if (!shortcut) return;

  try {
    await hub.request(HOST_ID, 'hotkey', 'register', {
      key: shortcut,
      action: 'summon',
      owner: HOST_ID,
    });
  } catch (e) {
    toast(`Hotkey "${shortcut}" failed: ${e}`, 'error');
    console.error('[boot] summon shortcut failed', e);
  }
}

/**
 * Run the summon when the host's own hotkey fires. Subscribed once.
 *
 * The handler mirrors `raise`: unminimize, show, focus — in that order, because
 * the first two are what make the third visible.
 */
function subscribeSummon() {
  hub
    .subscribe(HOST_ID, 'hotkey:summon', () => {
      const win = getCurrentWindow();
      win.unminimize().catch(() => {});
      win.show().catch(() => {});
      win.setFocus().catch(() => {});
    })
    .catch((e) => console.error('[boot] summon subscription failed', e));
}

/**
 * Closing the main window HIDES it.
 *
 * The app has a tray icon, and the tray menu's "退出" is the real exit — so the
 * ✕ puts the window away instead of ending the session. The tray is therefore
 * load-bearing: the Rust side treats a tray that will not build as fatal, because
 * an app that hides on close with no tray cannot be quit from its own UI.
 *
 * Registered by the HOST rather than by a plugin, because it has to happen
 * whether or not any plugin is listening. A plugin may still register its own
 * handler through `ctx.windows.onCloseRequested`, and `ctx.js` deliberately does
 * NOT call it while this is in effect — the window did not close, so telling a
 * plugin "the app is going away" would make it tear down windows it should have
 * kept, and there is no signal on the way back to rebuild them.
 *
 * `preventDefault()` is what stops Tauri destroying the window; `hide()` is what
 * the user sees. If this never installs — a frontend that failed to load — the ✕
 * behaves normally and the app quits, which is the safe direction to fail in.
 */
function installCloseToTray() {
  if (!closeToTray()) return;
  try {
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        await getCurrentWindow().hide();
      })
      .catch((e) => console.error('[boot] could not install close-to-tray', e));
  } catch (e) {
    // No Tauri (node --test, a plain browser): there is no window to close.
    console.info('[boot] close-to-tray not installed', e?.message ?? e);
  }
}

/**
 * Persist diagnostics independently of gateway dispatch. This still requires
 * working IPC, so each attempt is bounded and failures stay in the console.
 */
async function report(line) {
  // Timestamped at the SOURCE. The watchdog's own lines used to be the only
  // evidence of an outage and they had no time on them, which made "when did
  // this start, and was the machine asleep?" unanswerable after the fact.
  // UTC, to match the `--- boot <ISO> ---` lines in the same file.
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const text = `${ts} ${line}`;
  try {
    await withTimeout(invoke('host_note', { line: text }), 3_000, 'host_note');
  } catch (e) {
    console.error('[boot] could not write debug.log', e);
  }
}

/**
 * Ask the host where it is stuck, with a hard ceiling.
 *
 * `host_diag` is a raw command (not a gateway action) on purpose: it has to be
 * answerable when the gateway is the thing that stopped. Its answer separates
 * "the UI thread is not pumping" from "a gateway call is stuck" from "the
 * request never arrived" — three problems with three different fixes, and the
 * log could not tell them apart before.
 */
async function diagOnce() {
  let timer = null;
  const ceiling = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ error: 'no answer within 3000ms' }), 3000);
  });
  try {
    return await Promise.race([invoke('host_diag'), ceiling]);
  } catch (e) {
    return { error: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is the host still answering? — a bridge watchdog.
 *
 * ## What it is for
 *
 * `invoke` is a `fetch` to `http://ipc.localhost/<cmd>` (see Tauri's
 * `ipc-protocol.js`). A fetch that never settles is not an error the JS layer
 * can see: Tauri's fallback to `postMessage` only triggers on a **rejection**,
 * so a bridge that stops answering leaves every pending call pending forever.
 * `rpc` has a 45 s ceiling, which means the control plane eventually fails —
 * but a plugin that catches its errors, or a stream open with no ceiling at all,
 * turns that into "I clicked and nothing happened", with no trace anywhere.
 *
 * A resume from standby is exactly when this can happen (an in-flight request
 * is suspended with the machine), and the report from the field is exactly that
 * shape: after a long standby most controls do nothing, one plugin's view is
 * blank and another's buttons are dead — with **no CPU burning**, which rules
 * out a busy loop.
 *
 * ## What it does — and deliberately does not do
 *
 * It probes `host/info` (the cheapest call that goes all the way through the
 * gateway) every 20 s with a 5 s ceiling, and after three consecutive misses:
 * writes what it saw to `debug.log`, shows a toast that names the recovery
 * (the tray's 重启应用), and records the outage in `localStorage` so the NEXT
 * boot reports it even if the user recovered by restarting.
 *
 * It does **not** reload or restart on its own. A reload re-runs `boot()`, which
 * reaps host sessions — and a false positive (a machine busy compiling) would
 * then kill the user's running terminals. Telling someone is recoverable;
 * guessing is not.
 */
const WATCHDOG = {
  intervalMs: 20_000,
  timeoutMs: 5_000,
  strikes: 3,
  key: 'toolbox.bridgeOutage',
};

/**
 * The page's JS heap, in MB — Chromium's non-standard counter, the only
 * in-page memory signal there is.
 *
 * Reported with an outage because it separates the two ways a bridge dies: a
 * small heap means the host's message queue filled (too many frames), a huge
 * one means the renderer is holding hundreds of megabytes and stalling on GC.
 * Those need opposite fixes, and the number costs one line.
 */
function jsHeapMb() {
  const m = globalThis.performance?.memory;
  return m && m.usedJSHeapSize ? Math.round(m.usedJSHeapSize / 1048576) : null;
}

/** Report an outage left by the previous run, then clear it. */
async function reportPreviousOutage() {
  try {
    const prev = globalThis.localStorage?.getItem(WATCHDOG.key);
    const beacon = globalThis.localStorage?.getItem('toolbox.beacon');
    // Either one is worth a line: `prev` means the probes failed, and a
    // surviving beacon means the app ended WHILE it was in distress — which is
    // the shape of "I gave up and killed it", and the only record of it.
    if (!prev && !beacon) return;
    if (prev) globalThis.localStorage.removeItem(WATCHDOG.key);
    // The beacon's last words. If it is here, the page was still running
    // JavaScript when the outage ended — which points at the bridge, not the
    // renderer. If it is absent, the page never got far enough to arm it.
    await report(
      `previous run: the host stopped answering — ${prev ?? '(probes were still passing)'}` +
        (beacon ? ` — beacon ${beacon}` : ' — no beacon (the page never armed it)'),
    );
  } catch {
    // A locked-down profile must not break boot over a diagnostic.
  }
}

function installBridgeWatchdog() {
  let strikes = 0;
  let warned = false;
  let dueAt = Date.now() + WATCHDOG.intervalMs;

  const probe = async () => {
    // A timer that fires hours late means the machine was asleep, and that is
    // the ONE fact worth having in the log when the bridge is dead: the two
    // reported outages both followed a long standby, and nothing else in the
    // app records that it happened.
    const lateBy = Date.now() - dueAt;
    if (lateBy > 60_000) {
      void report(
        `bridge watchdog: the frontend was suspended for ~${Math.round(lateBy / 1000)}s ` +
          `(timer fired ${Math.round(lateBy / 1000)}s late) — resume detected`,
      );
    }
    dueAt = Date.now() + WATCHDOG.intervalMs;
    try {
      await hub.request(HOST_ID, 'host', 'info', {}, { timeoutMs: WATCHDOG.timeoutMs });
      if (strikes > 0) {
        // The bridge is back: stop publishing the distress counter and restore
        // the title the plugin had chosen.
        disarmBeacon();
        await report(`bridge watchdog: answering again after ${strikes} missed probe(s)`);
        strikes = 0;
        warned = false;
        try {
          globalThis.localStorage?.removeItem(WATCHDOG.key);
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      strikes += 1;
      try {
        // Survives a restart, unlike sessionStorage — and a restart is exactly
        // how someone recovers, which is when the evidence would otherwise go.
        globalThis.localStorage?.setItem(
          WATCHDOG.key,
          `${strikes} missed probe(s) in a row at ${new Date().toISOString()}`,
        );
      } catch {
        /* ignore */
      }
      // Once per outage, not once per tick: `report` goes through the very
      // bridge that is failing, so it is best-effort and can itself hang.
      if (strikes === 1) {
        // Arm the OUT-OF-BAND probe. From here on the title carries a counter
        // the host can read without IPC, which is the only way anyone can tell
        // "this renderer is dead" from "this renderer is fine, its bridge is
        // not". The timer that drives it lives in this window: if it stops, the
        // host sees a frozen title and knows the renderer stopped running JS.
        armBeacon(e?.message ?? 'no answer');
        const heap = jsHeapMb();
        // The busiest channel is the OTHER half of the report: "the bridge is
        // dead" says what happened, "channel X was doing 400 frames/s" says
        // what to fix. Reading it here (not from the host) is deliberate — the
        // counters live in this window and survive the bridge dying.
        const top = hub.trafficReport()[0];
        // The call that never came back, named. The host's `oldest` says a call
        // is stuck but not whether its answer was lost on the way here.
        const stuck = hub.stuckCalls(5_000)[0];
        const base =
          `bridge watchdog: no answer within ${WATCHDOG.timeoutMs}ms ` +
          `(${e?.code ?? 'error'}: ${e?.message ?? e})` +
          (heap === null ? '' : ` — js heap ${heap} MB`) +
          (top
            ? ` — busiest: ${top.key} ${top.framesPerSec} frames/s ` +
              `${Math.round(top.bytesPerSec / 1024)} KiB/s`
            : '') +
          (stuck ? ` — stuck: ${stuck.key} ${Math.round(stuck.ageMs / 1000)}s` : '');
        // The host side is asked separately, and its answer is the difference
        // between "the UI thread is blocked" and "one gateway call is stuck".
        void (async () => {
          const diag = await diagOnce();
          await report(`${base} — diag ${JSON.stringify(diag)}`);
        })();
      } else if (strikes % 10 === 0) {
        // Keep sampling while it lasts: a growing `oldest.ms` is the signature
        // of a stuck call, a constant one is a wedged UI thread.
        void diagOnce().then((diag) => report(`bridge watchdog: still out — diag ${JSON.stringify(diag)}`));
      }
      if (strikes >= WATCHDOG.strikes && !warned) {
        warned = true;
        // The HOST is already acting on the same signal (`ui_heartbeat`): it
        // reloads the page, then rebuilds the webview, then notifies. This
        // toast is for the case where the bridge is merely SLOW — and it names
        // the tray first, because the tray is the only thing that still works
        // when the bridge is truly gone.
        toast(
          '宿主没有响应（界面与后台的连接可能已断开）。宿主会自动尝试恢复；若仍无反应，' +
            '请用托盘菜单的「重新加载界面」，最后再「重启应用」。',
          'error',
          15_000,
        );
      }
    }
    schedule(probe);
  };

  /**
   * A repeating timer that must not keep the process alive.
   *
   * In the browser this is just `setTimeout`. Under `node --test` a pending
   * timer IS a live handle, so the boot smoke test would never exit — and an
   * app-level watchdog should never be the reason a test hangs. `unref` exists
   * on Node timers only, hence the optional call.
   */
  const schedule = (fn) => setTimeout(fn, WATCHDOG.intervalMs)?.unref?.();

  schedule(probe);
}

/**
 * Drop sessions a previous frontend left behind.
 *
 * A page reload replaces this JS context while the host process keeps running —
 * in dev that is every HMR update. The previous incarnation's sessions stay
 * registered, and they hold real OS processes, so they leak: reload a few times
 * and the in-app selftest starts reporting failures that are not failures
 * (its own `selftest-pty` is already open, so t10 and t11 go red).
 *
 * Exit and Ctrl+C both drain sessions; a reload passes through neither, so the
 * new frontend says so itself. Outside the app (tests, a plain browser) there is
 * no host to talk to, and that is not an error worth reporting.
 */
async function reapOrphanSessions() {
  try {
    // The tray's 重新加载界面 sets this before reloading: the sessions are still
    // watched by the UI that is coming back, so reaping them would turn
    // "reload the window" into "kill my terminals". One-shot by construction —
    // the flag is cleared here, whether or not the host honours it.
    let keep = false;
    try {
      keep = globalThis.sessionStorage?.getItem('toolbox.keepSessions') === '1';
      globalThis.sessionStorage?.removeItem('toolbox.keepSessions');
    } catch {
      /* no sessionStorage: nothing to keep */
    }
    const n = await invoke('plugin_reap_orphans', { keep });
    if (n > 0) await report(`reaped ${n} session(s) left by a previous frontend`);
  } catch {
    // No host (browser, node --test) — nothing to reap.
  }
}

/**
 * Route OS file drops to the plugin view the user dropped them on.
 *
 * `onDragDropEvent` is CORE (`@tauri-apps/api/webview`) — no plugin needed. The
 * host listens ONCE and republishes on the window-local bus, so a plugin does
 * not have to touch a Tauri API (it cannot import one) and does not have to
 * care which window it is in.
 *
 * **Only the ACTIVE view receives it.** A drop lands on what the user is
 * looking at; broadcasting to every plugin would let one silently harvest paths
 * meant for another. That routing is what lets `ctx.onDrop` need no permission.
 *
 * Deliberately not awaited by `boot()`: a window that cannot report drops is
 * still a usable window, and this must never be the reason startup fails.
 */
async function watchDrops() {
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event?.payload;
      const type = payload?.type ?? 'unknown';

      // Every phase is reported, not just the drop.
      //
      // `enter` / `over` / `leave` used to be discarded silently, which made
      // "drag and drop does not work" impossible to answer from the log: a drop
      // that never arrived and a drop that arrived and found nobody listening
      // left exactly the same trace — none. This feature has no other
      // instrument: the in-app selftest cannot cover it, because it has no user
      // to drag a file.
      //
      // `over` is the exception — it fires continuously while the pointer moves
      // — so it would be a log flood rather than a signal.
      if (type !== 'over') report(`file drop: ${type}`);

      if (type !== 'drop') return;

      const viewId = store.activeViewId;
      if (!viewId) {
        report('file drop: ignored — no active view');
        return;
      }

      // Naming the owner is what makes this answerable. "3 listener(s)" only
      // says how many wrappers ran — every one of them may have declined,
      // because a drop is routed to the ACTIVE view and a plugin only accepts
      // drops aimed at its own. Without the owner in the line, "the drop
      // arrived and was declined" is indistinguishable from "nothing arrived".
      const owner = store.views.find((v) => v.viewId === viewId)?.pluginId;
      const delivered = events.emit(DROP_TOPIC, { paths: payload.paths ?? [], viewId });
      const where = `view ${viewId}${owner ? ` (plugin ${owner})` : ' (host page)'}`;
      report(
        delivered === 0
          ? `file drop: ignored — no listener at all for ${where}`
          : `file drop: ${payload.paths?.length ?? 0} path(s) → ${where}, ${delivered} listener(s) called`,
      );
    });
    await report('file drops: watching');
  } catch (e) {
    // No host (browser, node --test) or a platform without the event. Not fatal.
    logger.warn('boot', `file drop watch unavailable: ${e}`);
    // …but not silent either: this is the one line that distinguishes "the
    // watcher never started" from "the watcher started and no drop arrived".
    await report(`file drops: UNAVAILABLE — ${e?.message ?? e}`);
  }
}

export async function boot() {
  // A startup budget. Without one, "startup feels slow" is unanswerable — the
  // window now appears as soon as the shell has painted (see main.js), so every
  // millisecond between that and the plugin list showing up is visible to the
  // user as an empty sidebar.
  const t0 = performance.now();
  const marks = [];
  const mark = (label) => {
    marks.push(`${label} ${Math.round(performance.now() - t0)}`);
  };

  await report(`--- boot ${new Date().toISOString()} ---`);
  try {
    const startup = performance.getEntriesByType('mark')
      .filter((entry) => entry.name.startsWith('toolkit:'))
      .map((entry) => `${entry.name.slice('toolkit:'.length)} ${Math.round(entry.startTime)}`);
    if (startup.length) await report(`startup timing (ms since navigation): ${startup.join(' | ')}`);
    const styles = performance.getEntriesByType('resource')
      .filter((entry) => /\.css(?:\?|$)/.test(entry.name))
      .map((entry) => `${new URL(entry.name).pathname} ${Math.round(entry.duration)}`);
    if (styles.length) await report(`startup CSS requests (ms): ${styles.join(' | ')}`);
    installDebug(); // window.__toolbox before plugins attach their own handles
    mark('debug');

    // Trace lines belong in the debug log, not just the console — the whole
    // point is that they survive the webview and can be read after the fact.
    // Installed before anything else can call the gateway.
    setTraceSink((line) => {
      void report(`  ${line}`);
    });

    // Before anything opens a session of its own.
    await reapOrphanSessions();
    mark('reap');

    // The component factory loads the whole vocabulary (~377 exports). `activate()` awaits it too,
    // but whoever gets there FIRST pays for it — which used to be whichever
    // plugin happened to be first, making the per-plugin timings a lie (the
    // first plugin's number was really the UI kit's).
    //
    // Loading it here gives it its own mark, so `plugin load (ms)` means what it
    // says.
    await loadUiKit();
    mark('uikit');

    // The scheme table is a static contract; snapshot it for the diagnostics view.
    store.schemes = hub.schemes();
    await report(`message plane: ${hub.transports().join(', ')}`);
    mark('schemes');

    // Two calls, one API. The two `mark()`s below are the only reason: the gap
    // between them is how you tell a slow bundle from a slow disk scan, and
    // merging them into one call would erase that distinction from the log.
    //
    // Boots the built-ins first so their views exist before external plugins
    // activate (those may want to publish to a view that is already there).
    const builtinPhase = await reconcilePlugins({ sources: [Origin.BUILTIN] });
    mark('builtins');

    await reconcilePlugins({ sources: [Origin.EXTERNAL] }); // drop-in plugins from {appData}/plugins/*
    mark('external');

    subscribeSummon();
    installCloseToTray();
    await applySummonShortcut();
    mark('hotkey');

    // Not awaited: see watchDrops.
    watchDrops();

    // Reported BEFORE the per-plugin lines and the selftest: those are
    // diagnostics, and their cost must not be attributed to the plugin list
    // the user is waiting for.
    await report(`boot timing (ms): ${marks.join(' | ')}`);
    await report(
      `  plugin load (ms): ${builtinPhase.builtin.timings
        .map((t) => `${t.id} ${t.ms}${t.failed ? ' FAILED' : ''}`)
        .join(' | ')}`,
    );

    store.booted = true;
    const line = `boot ok: ${store.plugins.length} plugins, ${store.views.length} views, active=${store.activeViewId}`;
    logger.info('boot', line);
    await report(line);
    for (const p of store.plugins) {
      const note = p.note ? ` [${p.note}]` : '';
      await report(`  plugin ${p.manifest.id}: ${p.status}${p.error ? ` — ${p.error}` : ''}${note}`);
    }

    // 上一轮如果失联过，先把证据写进 debug.log（重启会清掉 localStorage 之外的痕迹）。
    await reportPreviousOutage();
    // 桥的看门狗：只观测与告知，不自动重载（重载会回收会话，误判代价太大）。
    installBridgeWatchdog();

    // 更新检查是"顺带知道"，不是启动的一部分：**不 await**，失败也不吵
    // （没网、端点未配、公司代理都会失败，那些都不该看起来像启动出问题）。
    // 有更新时只更新状态，装不装由用户在设置页决定 —— 见 host/updater.js。
    void checkForUpdate({ silent: true });

    // `import.meta.env` is injected by Vite; the optional chain keeps this
    // module importable outside a bundler (node --test boot smoke test).
    if (import.meta.env?.DEV) await runStartupSelftest();
  } catch (e) {
    // A boot failure must leave a trace outside the webview.
    logger.error('boot', `boot failed: ${e}`);
    await report(`BOOT FAILED: ${e?.stack ?? e}`);
    throw e;
  }
}

/**
 * Run the in-app conformance suite and persist the report through the gateway
 * to {app_data_dir}/debug.log — readable from outside the webview without any
 * manual clicking.
 */
async function runStartupSelftest() {
  try {
    const { runSelftest } = await import('../core/selftest.js');
    const result = await runSelftest();
    await report(result.lines.join('\n'));
    console.info(`[selftest] ${result.pass}/${result.total} passed (see app data debug.log)`);
  } catch (e) {
    logger.error('selftest', `startup selftest pipeline failed: ${e}`);
    await report(`SELFTEST PIPELINE FAILED: ${e?.stack ?? e}`);
  }
}

export { saveSettings, installBridgeWatchdog };
