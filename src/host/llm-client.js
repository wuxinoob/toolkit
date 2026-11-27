import { ProtocolError } from '../protocol/errors.js';

const aborted = () => new DOMException('Model request cancelled', 'AbortError');
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const stop = () => reject(aborted());
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** Shared by ctx and bridge. Pulling next acknowledges consumption naturally. */
export function createLlmClient(call, disposer) {
  const active = new Set();
  let tracked = false;
  function track() {
    if (tracked) return;
    tracked = true;
    disposer.track(async () => {
      const cancelled = call('cancel_all', {});
      await Promise.allSettled([cancelled, ...[...active].map(stop => stop())]);
    });
  }
  async function* stream(request, { signal } = {}) {
    if (signal?.aborted) throw aborted();
    if (disposer.closed) throw new ProtocolError('not_found', 'plugin scope is closed');
    track();
    const pending = call('start', request);
    let completed = false;
    let started = false;
    let stopping;
    const stop = () => stopping ??= pending.then(
      ({ id }) => completed ? false : call('cancel', { id }),
      () => false,
    );
    const onAbort = () => { void stop().catch(() => {}); };
    active.add(stop);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const { id } = await abortable(pending, signal);
      started = true;
      if (disposer.closed || signal?.aborted) throw aborted();
      for (;;) {
        const event = await abortable(call('next', { id }), signal);
        if (event?.type === 'waiting') continue;
        if (!['text-delta', 'completed'].includes(event?.type)) throw new ProtocolError('protocol', 'invalid model event');
        if (event.type === 'completed') completed = true;
        yield event;
        if (completed) return;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      // A pending start still needs eventual cleanup, including after abort.
      if (!completed) {
        if (started) await stop().catch(() => {});
        else void stop().catch(() => {});
      }
      active.delete(stop);
    }
  }
  async function generate(request, options) {
    const parts = [];
    let bytes = 0;
    for await (const event of stream(request, options)) {
      if (event.type === 'text-delta') {
        bytes += new TextEncoder().encode(event.text).length;
        if (bytes > 4 * 1024 * 1024) throw new ProtocolError('bad_params', 'complete result exceeds 4 MiB; use llm.stream');
        parts.push(event.text);
      } else {
        return { output: [{ type: 'text', text: parts.join('') }], finishReason: event.finishReason, usage: event.usage };
      }
    }
    throw new ProtocolError('transport', 'generation ended without completion');
  }
  return Object.freeze({ profiles: () => call('profiles', {}), stream, generate });
}
