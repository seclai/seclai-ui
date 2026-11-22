import { copyFile } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  // `html`, `math` and `mermaid` are entries of their own, so what they need is
  // only bundled by apps that import them.
  entry: { index: "src/index.ts", html: "src/html.ts", math: "src/math.tsx", mermaid: "src/mermaid.tsx" },
  // ES modules only: Node 22.12+ can `require` them from CommonJS too.
  format: ["esm"],
  dts: true,
  clean: true,
  target: "es2022",
  // esbuild strips directives from source files when bundling, so Next.js only
  // sees "use client" if it's added back to the output. Shared chunks get it too.
  banner: { js: '"use client";' },
  async onSuccess() {
    await copyFile("src/styles.css", "dist/styles.css");
  },
});
