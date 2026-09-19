/**
 * Screenshot a local page in a chosen colour scheme.
 *
 * The app's theme is decided at first paint from `prefers-color-scheme` (or the
 * stored preference), so a plain `--screenshot` run can only ever show whichever
 * scheme the headless browser happens to report. Verifying the light/dark pair
 * therefore needs the colour scheme emulated BEFORE navigation — which means
 * driving the browser over CDP rather than using the one-shot CLI flag.
 *
 * No dependencies: Node 22 ships a global WebSocket, and CDP is just JSON over
 * one. Edge is already on the machine (the app runs on WebView2).
 *
 * Usage:
 *   node scripts/shot.mjs <url> <out.png> [--theme dark|light] [--size WxH]
 *   node scripts/shot.mjs http://127.0.0.1:1420 .shots/shell-dark.png --theme dark
 *
 * `--eval "<expr>"` prints the value of an expression in the page instead of
 * (well, as well as) screenshotting. A screenshot shows what LOOKS wrong; this
 * is how you find out WHY — read a computed style, an attribute, a store value.
 * Pass `--no-shot` to skip the image and use it as a headless assertion tool.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const [url, out] = positional;

if (!url || !out) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [--theme dark|light] [--size WxH]');
  process.exit(1);
}

const theme = flag('theme', 'dark');
const [w, h] = (flag('size', '1280x860')).split('x').map(Number);
const port = Number(flag('port', 9333));

const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!edge) {
  console.error('no Edge binary found');
  process.exit(1);
}

const profile = path.join(tmpdir(), `tb-shot-${process.pid}`);
mkdirSync(profile, { recursive: true });
mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

const child = spawn(
  edge,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${w},${h}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until the DevTools endpoint answers. */
async function version() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('devtools endpoint never came up');
}

/** Minimal CDP client: send/await over one websocket, route events by method. */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else p.resolve(msg.result);
      } else {
        for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}, sessionId) {
          const id = ++seq;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        },
        on(method, fn) {
          if (!listeners.has(method)) listeners.set(method, []);
          listeners.get(method).push(fn);
        },
        close: () => ws.close(),
      }),
    );
  });
}

try {
  const v = await version();
  const cdp = await connect(v.webSocketDebuggerUrl);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => cdp.send(m, p, sessionId);

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 2,
    mobile: false,
  });
  // Must precede navigation: the theme is read at first paint.
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: theme }],
  });

  const loaded = new Promise((res) => cdp.on('Page.loadEventFired', res));
  await send('Page.navigate', { url });
  await Promise.race([loaded, sleep(20000)]);
  // Give the app a beat to mount and for late async work (boot, fonts) to settle.
  await sleep(Number(flag('settle', 2500)));

  const expr = flag('eval', null);
  if (expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      console.error('eval threw:', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(r.result.value, null, 2));
    }
  }

  if (!argv.includes('--no-shot')) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(out, Buffer.from(data, 'base64'));
    console.log(`wrote ${out} (${theme}, ${w}x${h})`);
  }
  cdp.close();
} finally {
  child.kill();
  await sleep(400);
  rmSync(profile, { recursive: true, force: true });
}
