/** Shared constants for the FloatWin plugin (main-window side) and its widget page. */

/** Plugin id — also the plugin_rpc storage namespace and the bus publisher id. */
export const PLUGIN_ID = 'builtin.floatwin';

/** Tauri WebviewWindow label (must match capabilities/floatwin.json "windows"). */
export const FLOATWIN_LABEL = 'floatwin';

/**
 * Broadcast topic for config changes.
 *
 * The widget used to poll storage every 250 ms because the event bus was
 * per-window. Now the panel publishes an `evt` envelope and the host fans it
 * out to every window, so the widget reacts immediately and idles at zero cost.
 */
export const CONFIG_TOPIC = 'floatwin.config';

/** Persisted under storage key "config"; both sides merge over these defaults. */
export const DEFAULT_CONFIG = {
  width: 260,
  height: 160,
  opacity: 0.85,
  clickThrough: false,
  alwaysOnTop: true,
  autoRestore: false,
};
