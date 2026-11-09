// Inspect constructed SDK objects, so spreading a shared implementation does
// not require a second source-code parser or a manually duplicated key list.
import { register } from 'node:module';
register('../browser-stubs-loader.mjs', import.meta.url);
globalThis.localStorage ??= { getItem: () => null };
const { buildCtx } = await import('../../src/host/ctx.js');
const { makeBridge } = await import('../../src/host/pluginwin-host.js');
const { Disposer } = await import('../../src/host/disposer.js');
const manifest = { id: 'sdk.surface', name: 'SDK surface', permissions: [] };
export const ctxSurface = buildCtx({ manifest }, new Disposer());
export const bridgeSurface = makeBridge(manifest.id, 'plugin-surface', manifest);
