/**
 * Evaluate JavaScript inside the RUNNING app's WebView2.
 *
 * `scripts/shot.mjs` drives a headless Edge against the dev server, which is
 * fine for pages that need no native side. It cannot see the real app: plugin
 * activation, the native permission gate and the window layout only exist inside
 * Tauri. This attaches to the app instead.
 *
 * The app must have been started with WebView2 remote debugging on:
 *
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
 *
 * Usage:
 *
 *   node scripts/app-eval.mjs "<expression>"        # expression, awaited
 *   node scripts/app-eval.mjs --file probe.js       # expression from a file
 *
 * The expression is evaluated as an async function body, so `await` and `return`
 * both work. The result is printed as JSON.
 *
 * Zero dependencies: Node's built-in WebSocket speaks CDP directly.
 */
const PORT = Number(process.env.CDP_PORT ?? 9222);

const arg = process.argv[2];
const fileArg = process.argv[3];
let expr;
if (arg === '--file') {
  const { readFileSync } = await import('node:fs');
  expr = readFileSync(fileArg, 'utf8');
} else {
  expr = arg;
}
if (!expr) {
  console.error('usage: node scripts/app-eval.mjs "<expression>" | --file <path>');
  process.exit(2);
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

let list;
try {
  list = await targets();
} catch {
  console.error(`no CDP endpoint on ${PORT}.`);
  console.error('start the app with:');
  console.error(`  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${PORT} npm run tauri dev`);
  process.exit(1);
}

const page = list.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target — is the window open?');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
});

const result = await send('Runtime.evaluate', {
  expression: `(async () => { ${expr} })()`,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});

if (result.exceptionDetails) {
  const d = result.exceptionDetails;
  console.error('threw:', d.exception?.description ?? d.text);
  process.exit(1);
}

const value = result.result?.value;
console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
ws.close();
