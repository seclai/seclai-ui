// @vitest-environment node
// The published package: ES modules only, loadable from CommonJS with
// `require` on Node 22.12+, as in server rendering. Checks the built `dist`,
// which CI builds before testing. Locally they're skipped until `pnpm build` has
// run; in CI a missing build fails them instead.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
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

  it("marks every module as a client module, for Next.js", () => {
    for (const file of readdirSync(dist).filter((file) => file.endsWith(".js"))) {
      expect({ file, banner: readFileSync(join(dist, file), "utf8").startsWith('"use client";') }).toEqual({
        file,
        banner: true,
      });
    }
  });

  it("loads the html, math and mermaid entries", () => {
    expect(
      node(
        "module",
        'const m = await Promise.all(["html", "math", "mermaid"].map((name) => import(`@seclai/react/${name}`))); process.stdout.write(m.map((e, i) => typeof e[["html", "math", "mermaid"][i]]).join())',
      ),
    ).toBe("function,function,function");
  });

  // Apps that don't use maths or diagrams don't need katex, remark-math or
  // mermaid installed, so the main entry must not import them. Nor does it
  // bundle the HTML parser unless the app uses html().
  it("keeps katex, remark-math, mermaid and the HTML parser out of the main entry", async () => {
    const result = await build({
      entryPoints: [join(dist, "index.js")],
      bundle: true,
      write: false,
      format: "esm",
      metafile: true,
      external: ["react", "react-dom", "react/jsx-runtime"],
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs);
    const packages = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(katex|remark-math|mermaid|rehype-raw|parse5)\//;
    expect(inputs.filter((input) => packages.test(input))).toEqual([]);
  });

  // Safari before 16.4 can't parse a regex lookbehind, and one anywhere in an
  // app's bundle stops the whole bundle from loading there. This checks each
  // entry with every dependency it pulls in. Mermaid's own code, loaded on
  // demand, only has lookbehind in strings, behind a feature check.
  it.each(["index", "html", "math", "mermaid"])(
    "has no regex lookbehind in the %s entry's bundle, dependencies included",
    async (entry) => {
      const result = await build({
        entryPoints: [join(dist, `${entry}.js`)],
        bundle: true,
        write: false,
        format: "esm",
        external: ["react", "react-dom", "react/jsx-runtime", "mermaid"],
        logLevel: "silent",
      });
      const code = result.outputFiles[0]!.text;
      expect(code.length).toBeGreaterThan(entry === "mermaid" ? 1_000 : 100_000);
      expect(code.match(/.{0,60}\(\?<[=!].{0,20}/g)).toBeNull();
    },
  );
});
