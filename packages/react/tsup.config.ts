import { copyFile } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "es2022",
  // esbuild strips directives from source files when bundling, so Next.js only
  // sees "use client" if it's added back to the output.
  banner: { js: '"use client";' },
  async onSuccess() {
    await copyFile("src/styles.css", "dist/styles.css");
  },
});
