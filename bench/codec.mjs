/**
 * Codec experiment — measures what the scheme choice actually costs.
 *
 * The design goal was "experiment with different schemes instead of picking one
 * by accident". This is the measurable half of that: the codecs are pure
 * JavaScript and behave identically in the app and here, so their cost per
 * message is a real property rather than a property of a mock.
 *
 * What this DOES measure: envelope construction, framing and parsing cost.
 * What it does NOT measure: the transport. `invoke`, `Channel` and `emit` cross
 * the IPC boundary, which needs a running webview — so this answers "which codec
 * is cheaper for this payload shape", not "which carrier is faster".
 *
 *   npm run bench
 */

import { performance } from 'node:perf_hooks';

import * as Envelope from '../src/protocol/envelope.js';
import {
  jsonEnvelope,
  lineJson,
  encodeRaw,
  decodeRaw,
  payloadBytes,
  rawToEnvelope,
} from '../src/protocol/codec.js';

// ------------------------------- harness ------------------------------------

const enc = new TextEncoder();

/** Median of `rounds` runs of `fn`, in ms. Median, not mean: one GC pause
 *  otherwise dominates a micro-benchmark. */
function medianMs(fn, rounds = 7) {
  const samples = [];
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function bench(label, iters, fn, bytesPerOp = 0) {
  for (let i = 0; i < Math.min(iters, 2000); i++) fn(); // warm up the JIT
  const ms = medianMs(() => {
    for (let i = 0; i < iters; i++) fn();
  });
  return {
    label,
    nsPerOp: (ms * 1e6) / iters,
    mbps: bytesPerOp ? (bytesPerOp * iters) / (ms / 1000) / (1024 * 1024) : 0,
  };
}

function report(title, results) {
  console.log(`\n${title}`);
  for (const r of results) {
    const ns = r.nsPerOp.toFixed(0).padStart(8);
    const mb = r.mbps ? `${r.mbps.toFixed(1).padStart(7)} MB/s` : '';
    console.log(`  ${r.label.padEnd(40)} ${ns} ns/op  ${mb}`);
  }
  return results;
}

/** How much slower `b` is than `a`, in percent. Negative = faster. */
const slower = (a, b) => ((b.nsPerOp / a.nsPerOp - 1) * 100).toFixed(0);

// ------------------------------- payloads -----------------------------------

const FRAME = { n: 42, t: 1757851234567 };
const DOC = { title: 'a stored note', body: 'x'.repeat(1000), tags: ['a', 'b', 'c'], meta: { at: 1757851234567, rev: 7 } };
const CHUNK = new Uint8Array(4096).map((_, i) => (i * 31) & 0xff);

const envFrame = Envelope.data('s1', FRAME);
const envDoc = Envelope.data('s1', DOC);

const jsonFrame = jsonEnvelope.encode(envFrame);
const lineFrame = lineJson.encode(envFrame);
const rawFrame = encodeRaw(Envelope.Kind.DATA, payloadBytes(FRAME));
const rawChunk = encodeRaw(Envelope.Kind.DATA, CHUNK);
const jsonChunk = jsonEnvelope.encode(Envelope.data('p', Array.from(CHUNK)));

const N = 200_000;
const N_BIG = 20_000;

// --------------------------------- runs -------------------------------------

console.log('codec experiment — JS codec cost per message (transport excluded)');
console.log(`node ${process.version} · ${process.arch} · median of 7 runs`);

const structured = report('structured stream frame {n,t} — a ticker frame', [
  bench('json-envelope  encode+decode', N, () => jsonEnvelope.decode(jsonEnvelope.encode(envFrame))),
  bench('line-json      encode+decode', N, () => lineJson.decode(lineJson.encode(envFrame))),
  bench('raw-binary     encode+decode', N, () => decodeRaw(encodeRaw(Envelope.Kind.DATA, payloadBytes(FRAME)))),
]);

const binary = report('binary chunk 4 KiB — a PTY output chunk', [
  bench(
    'json-envelope  (byte array as JSON numbers)',
    N_BIG,
    () => jsonEnvelope.decode(jsonEnvelope.encode(Envelope.data('p', Array.from(CHUNK)))),
    CHUNK.length,
  ),
  bench(
    'raw-binary     encode+decode',
    N_BIG,
    () => decodeRaw(encodeRaw(Envelope.Kind.DATA, CHUNK)),
    CHUNK.length,
  ),
]);

report('document 1 KB nested object — a storage payload', [
  bench('json-envelope  encode+decode', N_BIG, () => jsonEnvelope.decode(jsonEnvelope.encode(envDoc))),
  bench('line-json      encode+decode', N_BIG, () => lineJson.decode(lineJson.encode(envDoc))),
]);

report('raw consumer path 4 KiB (what a pty consumer runs per frame)', [
  bench('rawToEnvelope  (kind byte + payload)', N_BIG, () => rawToEnvelope(rawChunk, 'p'), CHUNK.length),
]);

// ------------------------------- conclusions --------------------------------

console.log('\nwire size per frame');
for (const [name, bytes] of [
  ['json-envelope  {n,t}', enc.encode(jsonFrame).length],
  ['line-json      {n,t}', enc.encode(lineFrame).length],
  ['raw-binary     {n,t}', rawFrame.length],
  ['raw-binary     4 KiB chunk', rawChunk.length],
  ['json-envelope  4 KiB chunk', enc.encode(jsonChunk).length],
]) {
  console.log(`  ${name.padEnd(30)} ${String(bytes).padStart(7)} B`);
}

console.log('\ntakeaways');
console.log(
  `  · for a 4 KiB chunk, JSON is ${Math.abs(Number(slower(binary[1], binary[0])))}% slower and inflates the ` +
    `frame ${(enc.encode(jsonChunk).length / rawChunk.length).toFixed(1)}x — raw-binary is the only sane carrier for bytes`,
);
console.log(
  `  · line-json costs ${slower(structured[0], structured[1])}% more than json-envelope for the same payload ` +
    '(same codec plus a newline and a trailing-newline trim)',
);
console.log(
  `  · a {n,t} frame is ${Math.abs(Number(slower(structured[0], structured[2])))}% ` +
    `${Number(slower(structured[0], structured[2])) < 0 ? 'cheaper' : 'costlier'} as raw-binary — but raw-binary ` +
    'cannot carry a nested object, so for control frames this is a capability limit, not a trade-off',
);
console.log(
  '  · so the scheme table encodes a real trade-off: JSON for self-describing control/events,\n' +
    '    raw-binary for byte streams. Measured, not assumed.',
);
console.log('\n  NOTE: transport cost (invoke / Channel / emit) is NOT included — it needs a live webview.');
