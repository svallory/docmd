/** Where the specs' site lives and which of its pages they write to; shared by the setup, teardown and helpers. */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const DOCS_DIR = path.join(REPO_ROOT, "_playground/docs");

/** The pages the specs write to, with the route each is served on. Add a page here and it is snapshotted and restored. */
export const PAGES: ReadonlyArray<{ file: string; route: string }> = [
  { file: "index.md", route: "/" },
  { file: "mermaid-preview.md", route: "/mermaid-preview/" },
];
