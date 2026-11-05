import { defineConfig } from "@playwright/test";

const PORT = 4175;
// Far apart: a dev server moves to the next free port when its own is taken, so neighbours could answer for each other.
const INLINE_PORT = 4275;
/** Specs written for inline cards (no sidebar panel); the rest run against the sidebar site the reviews specs need. */
const INLINE_SPECS = /(basic-ui|replies-deletion|navigation|comment-display|reactions|resolve-threads|thread-creation)\.e2e\.spec\.ts$/;

const server = (port: number, mode: string) => ({
  command: `node e2e/serve-playground.mjs ${port} ${mode}`,
  url: `http://localhost:${port}/`,
  reuseExistingServer: false,
  timeout: 60_000,
  cwd: ".", // this package
});

export default defineConfig({
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  testDir: "e2e",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: {
    headless: true,
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: INLINE_SPECS,
      use: { browserName: "chromium", baseURL: `http://localhost:${PORT}` },
    },
    {
      name: "chromium-inline",
      testMatch: INLINE_SPECS,
      use: { browserName: "chromium", baseURL: `http://localhost:${INLINE_PORT}` },
    },
  ],
  // Both sites serve the same playground docs, so each publish or restore rebuilds both; the helpers poll only the
  // site under test. Kept for simplicity over a docs copy per server.
  webServer: [server(PORT, "sidebar"), server(INLINE_PORT, "inline")],
});
