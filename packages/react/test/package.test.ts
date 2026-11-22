// The published package: ES modules only, loadable from CommonJS with
// `require` on Node 22.12+, as in server rendering. Checks the built `dist`,
// which CI builds before testing. Locally they're skipped until `pnpm build` has
// run; in CI a missing build fails them instead.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");

/** Runs `code` in a fresh Node from the package's folder, so its own name resolves through `exports`. */
function node(inputType: "commonjs" | "module", code: string): string {
  return execFileSync(process.execPath, [`--input-type=${inputType}`, "-e", code], { cwd: root, encoding: "utf8" });
}

describe.skipIf(!existsSync(join(dist, "index.js")) && !process.env.CI)("the published package", () => {
  it("loads with require from CommonJS", () => {
    expect(node("commonjs", 'process.stdout.write(typeof require("@seclai/react").useAgentRun)')).toBe("function");
  });

  it("loads with import", () => {
    expect(
      node("module", 'const m = await import("@seclai/react"); process.stdout.write(typeof m.useAgentRun)'),
    ).toBe("function");
  });

  it("points main, types and every export at a built file", () => {
    const pkg: { main: string; types: string; exports: Record<string, string | Record<string, string>> } = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    const exported = Object.values(pkg.exports).flatMap((entry) => (typeof entry === "string" ? [entry] : Object.values(entry)));
    const targets = [pkg.main, pkg.types, ...exported];
    expect(targets.filter((target) => !existsSync(join(root, target)))).toEqual([]);
  });

  it("ships no CommonJS build", () => {
    expect(readdirSync(dist).filter((file) => /\.(cjs|d\.cts)$/.test(file))).toEqual([]);
  });
});
