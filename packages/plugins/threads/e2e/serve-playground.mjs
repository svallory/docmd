/**
 * Starts the repo-root `_playground` site on the workspace build of docmd (not
 * the `local-tars` install) with the threads plugin enabled by `playground.config.mjs`.
 * Run by playwright.config.ts as its webServer; port is the first CLI argument.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const playground = path.join(repoRoot, "_playground");
const docmd = path.join(repoRoot, "packages/core/dist/bin/docmd.js");
const port = process.argv[2] ?? "4175";

for (const [file, hint] of [
  [path.join(playground, "docs/index.md"), "the _playground site is missing"],
  [docmd, "run `pnpm -r run build` first"],
]) {
  if (!fs.existsSync(file)) {
    console.error(`e2e: ${file} not found: ${hint}`);
    process.exit(1);
  }
}

const child = spawn(
  process.execPath,
  [docmd, "dev", "--cwd", playground, "--config", path.join(here, "playground.config.mjs"), "--port", port],
  { stdio: "inherit" },
);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
