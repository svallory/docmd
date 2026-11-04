/**
 * Snapshots the playground state the specs mutate (index.md and whether `.threads/` exists),
 * so cleanThreads can restore the page and global-teardown can leave no untracked state behind.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../_playground/docs");

/** The playground pages the specs write to. */
const PAGES = ["index.md", "mermaid-preview.md"];

export default function globalSetup(): void {
  for (const page of PAGES) {
    if (!fs.existsSync(path.join(docsDir, page))) {
      throw new Error(`e2e: ${path.join(docsDir, page)} not found (the site lives in the repo-root _playground/)`);
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threads-e2e-"));
  for (const page of PAGES) fs.copyFileSync(path.join(docsDir, page), path.join(dir, page));
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({ threadsDirExisted: fs.existsSync(path.join(docsDir, ".threads")) }),
  );
  process.env["THREADS_E2E_SNAPSHOT"] = dir;
}
