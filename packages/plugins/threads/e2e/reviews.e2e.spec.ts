/**
 * Reviews tab journey: publish → Reviews tab lists it → quote link scrolls to the thread →
 * Discard cancel (no change) → Discard confirm (entry greyed, no Discard button).
 */

import { test, expect } from "@playwright/test";
import { cleanThreads, publishReview, setAuthor } from "./helpers.ts";

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

test("a published review is listed, its quote links to the thread, and Discard asks first", async ({ page }) => {
  const quote = await page.evaluate(() => (document.querySelector("main p, .content p, article p") as HTMLElement).textContent!.trim().split(" ").slice(0, 3).join(" "));
  await page.evaluate(
    ({ quote }) =>
      docmd.call("threads:add-thread", {
        file: document.body.dataset["sourceFile"],
        anchor: { quote, prefix: null, suffix: null, selector: null, offset: null, blockText: null },
        author: "TestUser",
        authorKey: "TestUser",
        body: "reviews journey",
      }),
    { quote },
  );
  const { reviewId } = await publishReview(page);
  await page.reload();
  await page.waitForSelector("threads-app", { state: "attached", timeout: 10_000 });

  await page.locator(".tc-sidebar-toggle").click();
  await page.getByTestId("tab-reviews").click();
  const entry = page.locator(`[data-testid="review"][data-review-id="${reviewId}"]`);
  await expect(entry).toBeVisible();
  await expect(entry).toContainText("TestUser");
  await expect(entry.getByTestId("review-state")).toHaveText("Published");
  const link = entry.getByTestId("review-op");
  await expect(link).toHaveText(quote);
  await expect(link).toHaveAttribute("href", /#thread-/);

  // The link opens the page and scrolls to the thread.
  await link.click();
  await page.waitForSelector("threads-app", { state: "attached", timeout: 10_000 });
  await expect(page.locator("mark.threads-highlight")).toBeInViewport();
  await page.locator(".tc-sidebar-toggle").click();
  await page.getByTestId("tab-reviews").click();

  // Cancel closes the dialog and leaves the review published.
  await entry.getByTestId("review-discard").click();
  await expect(page.getByTestId("discard-dialog")).toBeVisible();
  await page.getByTestId("discard-cancel").click();
  await expect(page.getByTestId("discard-dialog")).toBeHidden();
  await expect(entry).toHaveAttribute("data-state", "published");

  // Confirm discards: greyed, labelled, no Discard button.
  await entry.getByTestId("review-discard").click();
  await page.getByTestId("discard-confirm").click();
  await expect(entry).toHaveAttribute("data-state", "discarded");
  await expect(entry.getByTestId("review-state")).toHaveText("Discarded");
  await expect(entry.getByTestId("review-discard")).toHaveCount(0);
});

test("the open review's title form saves, and a deep link to an unknown thread does nothing", async ({ page }) => {
  await page.goto("/#thread-nope");
  await page.waitForSelector("threads-app", { state: "attached", timeout: 10_000 });
  await expect(page.locator(".threads-thread--flash")).toHaveCount(0);

  await page.locator(".tc-sidebar-toggle").click();
  await page.getByTestId("tab-reviews").click();
  await page.getByTestId("review-title").fill("My review");
  await page.getByTestId("review-save").click();
  const title = await page.evaluate(async () => (await docmd.call("threads:whoami", { author: "TestUser", authorKey: "TestUser" })).journal.review.title);
  expect(title).toBe("My review");
});
