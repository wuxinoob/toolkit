/** Cleanup scope shared by plugin views and plugin windows. */
export class Disposer {
  constructor() {
    this.fns = [];
    this.closed = false;
    this.running = null;
  }

  track(fn) {
    if (this.closed) void this.call(fn);
    else this.fns.push(fn);
    return fn;
  }

  async call(fn) {
    try {
      await fn();
    } catch (error) {
      console.error('[lifecycle] dispose error', error);
    }
  }

  run({ parallel = false } = {}) {
    if (this.running) return this.running;
    this.closed = true;
    const fns = this.fns.splice(0).reverse();
    // Window unload must issue every cleanup immediately; plugin deactivation
    // keeps its ordered, awaited teardown. Both paths are idempotent.
    this.running = (async () => {
      if (parallel) await Promise.all(fns.map((fn) => this.call(fn)));
      else for (const fn of fns) await this.call(fn);
    })();
    return this.running;
  }
}
