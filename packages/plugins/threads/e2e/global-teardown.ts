/** Restores what global-setup snapshotted: the playground index and, if it was absent, no `.threads/`. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../_playground/docs");

export default function globalTeardown(): void {
  const dir = process.env["THREADS_E2E_SNAPSHOT"];
  if (!dir) return;
  for (const page of ["index.md", "mermaid-preview.md"]) fs.copyFileSync(path.join(dir, page), path.join(docsDir, page));
  const { threadsDirExisted } = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf-8"));
  if (!threadsDirExisted) fs.rmSync(path.join(docsDir, ".threads"), { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}
