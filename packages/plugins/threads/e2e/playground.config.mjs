import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// The repo-root _playground docs, with the threads plugin enabled (its own docmd.config.json does not).
export default {
  title: "threads e2e",
  src: path.resolve(here, "../../../../_playground/docs"),
  out: path.resolve(here, "../../../../_playground/site"),
  plugins: { threads: {} },
};
