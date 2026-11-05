/**
 * SPA navigation tests - adapted from old headings-navigation.e2e.spec.ts
 * "SPA navigation" block.
 *
 * Runs against the inline site (threads plugin without its sidebar), see playwright.config.ts.
 *
 * Changes from old plugin:
 * - The playground index has no threads of its own: the test that reads threads seeds a published one
 * - No sidebar panel
 * - No heading discuss buttons
 * - Threads are inline, not in a sidebar
 * - Navigation restores threads by triggering loadThreads + scanRenderedHighlights
 */

import { test, expect } from "@playwright/test";
import { Actor, NavigateTo } from "./screenplay.ts";
import { cleanThreads, setAuthor, seedAndReload } from "./helpers.ts";



let user: Actor;

test.beforeEach(async ({ page }) => {
  user = new Actor("TestUser", page);
  await page.goto("/");
  await page.waitForSelector("threads-app", { state: "attached", timeout: 10_000 });
  await setAuthor(page, "TestUser");
});

test.afterEach(async ({ page }) => {
  await cleanThreads(page);
});

test.describe("SPA navigation", () => {
  test("threads-app is present after page load", async () => {
    await user.perform(NavigateTo.path("/"));
    const app = user.page.locator("threads-app");
    await expect(app).toBeAttached();
  });

  test("New Thread button is reinjected after SPA navigation", async () => {
    await user.perform(NavigateTo.path("/"));

    const btn = user.page.locator(".threads-new-thread-btn").first();
    await expect(btn).toBeVisible({ timeout: 5_000 });
  });

  test("threads are page-scoped (published threads render on their page)", async () => {
    // v2: a thread renders server-side once published; seed one anchored thread on the index
    await cleanThreads(user.page);
    await user.page.reload();
    const { id } = await seedAndReload(user.page, { body: "Navigation thread", anchor: { quote: "manual integration playground" } });
    await user.perform(NavigateTo.path("/"));

    await expect(user.page.locator(`.threads-thread[data-thread-id="${id}"]`)).toHaveCount(1);
  });
});
