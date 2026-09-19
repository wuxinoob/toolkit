/**
 * The component vocabulary, as Vite sees it.
 *
 * This file exists ONLY to hold an `import.meta.glob` call, and it is the reason
 * `ui.js` loads its components through a dynamic import.
 *
 * Why the separation: `import.meta.glob` is a Vite macro. At build time Vite
 * REPLACES the call with a plain object literal, so a defensive guard like
 *
 *     const mods = typeof import.meta.glob === 'function' ? import.meta.glob('…') : {};
 *
 * does not do what it looks like — after the rewrite the left side is
 * `typeof {…}`, which is `'object'`, so the ternary always takes the `{}` branch
 * and the kit silently loads zero components. (That is a real bug this file was
 * created to fix; the symptom was an empty vocabulary and no error.)
 *
 * Node has no `import.meta.glob` at all, so this module must never be reachable
 * from the test process. `ui.js` therefore reaches it with a dynamic import
 * inside `loadUiKit()`, which only ever runs in the app.
 */
export const componentModules = import.meta.glob('../components/ui/*/index.ts');
