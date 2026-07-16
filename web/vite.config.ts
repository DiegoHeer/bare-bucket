import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  // The wasm pkg is a local file: dependency; keep it out of prebundling so
  // Vite serves its .wasm asset via import.meta.url resolution.
  optimizeDeps: { exclude: ["bare-bucket-core"] },
  build: { target: "esnext" },
  server: {
    fs: {
      // Polish item 16: `bare-bucket-core` is a `file:../core/pkg` dependency
      // symlinked into node_modules; Vite resolves symlinks to their real
      // path (`../core/pkg/...`) and serves module/asset requests from
      // there. Vite's default `server.fs.allow` is normally the auto-
      // detected monorepo workspace root, but that auto-detection stops as
      // soon as it finds A lockfile — and `web/package-lock.json` lives
      // right here, so it never climbs to the repo root that also contains
      // `core/`. Without this, `bare_bucket_core.js` itself loads fine
      // (Vite's module-graph transform path isn't gated the same way), but
      // its `new URL('bare_bucket_core_bg.wasm', import.meta.url)` resolves
      // to a path outside the allow-list, and the plain static-file
      // middleware refuses it (a 403, though it manifests to the app as the
      // wasm fetch/instantiation failing) — a dev-server-only check that
      // `vite build`/`preview` never route through, which is why only
      // `npm run dev` was affected.
      allow: [".."],
    },
  },
});
