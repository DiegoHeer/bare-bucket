import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  // The wasm pkg is a local file: dependency; keep it out of prebundling so
  // Vite serves its .wasm asset via import.meta.url resolution.
  optimizeDeps: { exclude: ["bare-bucket-core"] },
  build: { target: "esnext" },
});
