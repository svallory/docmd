/**
 * Snapshots the playground state the specs mutate (the pages and whether `.threads/` exists),
 * so cleanThreads can restore the pages and global-teardown can leave no untracked state behind.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DOCS_DIR, PAGES, REPO_ROOT } from "./playground.ts";

export default function globalSetup(): void {
  for (const { file } of PAGES) {
    if (!fs.existsSync(path.join(DOCS_DIR, file))) {
      throw new Error(`e2e: ${path.join(DOCS_DIR, file)} not found (the site lives in the repo-root _playground/)`);
    }
  }
  // The snapshot is the baseline every run restores to: it must be the tracked content, not a killed run's leftovers.
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "_playground/docs"], { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
  if (dirty) {
    throw new Error(`e2e: _playground/docs has uncommitted changes (a killed earlier run?); restore it first:\n${dirty}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threads-e2e-"));
  for (const { file } of PAGES) fs.copyFileSync(path.join(DOCS_DIR, file), path.join(dir, file));
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({ threadsDirExisted: fs.existsSync(path.join(DOCS_DIR, ".threads")) }),
  );
  process.env["THREADS_E2E_SNAPSHOT"] = dir;
}
