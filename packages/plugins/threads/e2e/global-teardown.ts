/** Restores what global-setup snapshotted: the playground pages and, if it was absent, no `.threads/`. */
import * as fs from "node:fs";
import * as path from "node:path";
import { DOCS_DIR, PAGES } from "./playground.ts";

export default function globalTeardown(): void {
  const dir = process.env["THREADS_E2E_SNAPSHOT"];
  if (!dir) return;
  for (const { file } of PAGES) fs.copyFileSync(path.join(dir, file), path.join(DOCS_DIR, file));
  const { threadsDirExisted } = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf-8"));
  if (!threadsDirExisted) fs.rmSync(path.join(DOCS_DIR, ".threads"), { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}
