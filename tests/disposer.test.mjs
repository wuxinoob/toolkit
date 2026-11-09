import test from 'node:test';
import assert from 'node:assert/strict';
import { Disposer } from '../src/host/disposer.js';

test('cleanup registered after teardown is released instead of retained forever', async () => {
  const scope = new Disposer();
  await scope.run();
  let released = false;
  scope.track(() => { released = true; });
  assert.equal(released, true);
  assert.equal(scope.fns.length, 0);
});

test('window teardown issues all cleanups before waiting on a slow one', async () => {
  const scope = new Disposer();
  const seen = [];
  let release;
  scope.track(() => seen.push('stream close'));
  scope.track(() => new Promise((resolve) => { release = resolve; seen.push('slow cleanup'); }));
  const closing = scope.run({ parallel: true });
  assert.deepEqual(seen, ['slow cleanup', 'stream close']);
  assert.equal(scope.run(), closing);
  release();
  await closing;
});
