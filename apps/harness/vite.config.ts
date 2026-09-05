import { resolve } from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: true,
  },
  // P6a W5: Playwright's webServer builds then serves this app with `vite preview` rather than
  // `vite dev` — reusing 5173 rather than a second port, since dev and preview are never both
  // wanted at once (playwright.config.ts's own comment says which one the suite uses and why).
  //
  // `build.outDir` is pointed at the repo-root `dist/harness`, mirroring `packages/ui/vite.config.
  // ts`'s own `dist/ui` — deliberately **not** the default `apps/harness/dist`, which is already
  // `apps/harness/tsconfig.json`'s `outDir` for this project's `emitDeclarationOnly` composite
  // build (`tests/tsconfig.json` references `../apps/harness` and depends on those `.d.ts` files
  // existing). Vite's default `emptyOutDir: true` would silently wipe them on every `vite build` —
  // exactly the collision `tests/perf/graphUi.ts`'s own doc comment already calls out for the
  // same reason.
  build: {
    outDir: resolve(import.meta.dirname, "..", "..", "dist", "harness"),
    emptyOutDir: true,
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
});
