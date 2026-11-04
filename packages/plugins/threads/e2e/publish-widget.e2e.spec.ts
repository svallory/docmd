/**
 * Publish widget journey: comment → count 1 → Publish → count 0.
 */

import { test, expect } from "@playwright/test";
import { cleanThreads, setAuthor } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("threads-app", { state: "attached", timeout: 10_000 });
  await setAuthor(page, "TestUser");
  await cleanThreads(page);
  await page.reload();
  await page.waitForSelector("threads-publish-widget", { timeout: 10_000 });
});

test.afterEach(async ({ page }) => {
  await cleanThreads(page);
});

test("a comment counts as unpublished until Publish, and the widget sits bottom-right", async ({ page }) => {
  const widget = page.locator("threads-publish-widget");
  await expect(widget).toBeVisible();
  const box = (await widget.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x + box.width).toBeGreaterThan(vp.width - 40);
  expect(box.y + box.height).toBeGreaterThan(vp.height - 40);

  // Collect mode so the countdown cannot publish under the test.
  const pp = page.getByTestId("tpw-playpause");
  if ((await pp.getAttribute("data-mode")) === "auto") await pp.click();
  await expect(pp).toHaveAttribute("data-mode", "collect");

  await page.evaluate(() =>
    docmd.call("threads:add-thread", {
      file: document.body.dataset["sourceFile"],
      anchor: null,
      author: "TestUser",
      authorKey: "TestUser",
      body: "widget journey",
    }),
  );
  await page.reload();
  await expect(page.getByTestId("tpw-count")).toHaveText("1 unpublished comment");

  await page.getByTestId("tpw-publish").click();
  await expect(page.getByTestId("tpw-count")).toHaveText("0 unpublished comments");
});
