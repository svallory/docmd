/**
 * Starts the repo-root `_playground` site on the workspace build of docmd (not
 * the `local-tars` install) with the threads plugin enabled with its sidebar (the reviews specs open it). The port is the required first CLI argument.
 *
 * docmd resolves the config's `src`/`out`, and the plugin its `.threads/` store, against the config's
 * directory, and the playground's own config does not enable threads. So the server runs from a temp
 * directory holding the config and a `docs` symlink to the playground docs: pages and `.threads/` land
 * in the real playground, nothing else is written there. The threads plugin is symlinked in from this workspace.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const playgroundDocs = path.join(repoRoot, "_playground/docs");
const docmd = path.join(repoRoot, "packages/core/dist/bin/docmd.js");
const port = process.argv[2];
if (!port) {
  console.error("e2e: usage: serve-playground.mjs <port>");
  process.exit(1);
}

for (const [file, hint] of [
  [path.join(playgroundDocs, "index.md"), "the _playground site is missing"],
  [docmd, "run `pnpm -r run build` first"],
]) {
  if (!fs.existsSync(file)) {
    console.error(`e2e: ${file} not found: ${hint}`);
    process.exit(1);
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "threads-e2e-site-"));
fs.symlinkSync(playgroundDocs, path.join(work, "docs"), "dir");
// Outside the monorepo docmd resolves plugins from the project's node_modules (and would install a published one).
fs.mkdirSync(path.join(work, "node_modules/@docmd"), { recursive: true });
fs.symlinkSync(path.resolve(here, ".."), path.join(work, "node_modules/@docmd/plugin-threads"), "dir");
fs.writeFileSync(
  path.join(work, "docmd.config.json"),
  JSON.stringify({ title: "threads e2e", src: "docs", out: "site", plugins: { threads: { sidebar: true } } }),
);

const child = spawn(process.execPath, [docmd, "dev", "--cwd", work, "--port", port], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => {
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(code ?? (signal ? 1 : 0));
});
