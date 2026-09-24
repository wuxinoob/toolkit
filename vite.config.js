import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [vue(), tailwindcss()],

  // shadcn-vue's copy-in components import each other and the `cn()` helper
  // through `@/…`. The alias has to exist in Vite (for the bundle) AND in
  // jsconfig.json (for the CLI, which resolves paths before writing files).
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Two pages, not one. `index.html` is the shell; `pluginwin.html` is a
  // plugin's own window. They link DIFFERENT stylesheets, and a page's
  // stylesheet is applied before any module runs — so keeping 122 KB of Tailwind
  // utilities out of a plugin window has to happen here, at the page level. No
  // branch in `main.js` could do it. See src/pluginwin.js.
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        pluginwin: fileURLToPath(new URL('./pluginwin.html', import.meta.url)),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
