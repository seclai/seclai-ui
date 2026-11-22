import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  // ES modules only: Node 22.12+ can `require` them from CommonJS too.
  format: ["esm"],
  dts: true,
  clean: true,
  target: "es2022",
});
