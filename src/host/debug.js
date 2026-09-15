/**
 * Debug console namespace: window.__toolbox
 * Lets a developer (or an agent reading logs) probe the running app:
 *   __toolbox.store / events / logger / logs({level,category})
 *   __toolbox.schemes()          -> the message-plane table
 *   __toolbox.transports()       -> registered scheme ids
 *   __toolbox.sessions()         -> the host's unified session registry
 *   __toolbox.selftest()         -> full in-app conformance report
 * Plugins may attach their own handles (e.g. __toolbox.procman).
 */

import { store } from './store.js';
import { events } from './events.js';
import { logger } from '../core/logger.js';
import { runSelftest } from '../core/selftest.js';
import { hub } from '../protocol/hub.js';

export function installDebug() {
  const api = {
    version: '0.2.0',
    store,
    events,
    logger,
    logs: (filter) => logger.dump(filter),
    hub,
    schemes: () => hub.schemes(),
    transports: () => hub.transports(),
    sessions: () => hub.sessions('__host__'),
    openStreams: () => hub.openStreamKeys(),
    selftest: runSelftest,
  };
  // Object.assign, never replace: plugins attach their own handles to the
  // same namespace and may have activated before/after this call.
  globalThis.window ||= {};
  Object.assign(globalThis.window, {
    __toolbox: Object.assign(globalThis.window.__toolbox || {}, api),
  });
  logger.info('debug', `__toolbox installed (${hub.transports().length} transports registered)`);
  return api;
}
