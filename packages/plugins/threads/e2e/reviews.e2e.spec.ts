/**
 * Reviews tab journey: publish → Reviews tab lists it → quote link scrolls to the thread →
 * Discard cancel (no change) → Discard confirm (entry greyed, no Discard button).
 */

import { test, expect } from "@playwright/test";
import { cleanThreads, publishReview, setAuthor, snapshotPlaygroundPage } from "./helpers.ts";

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

const firstWords = () =>
  (document.querySelector("main p, .content p, article p") as HTMLElement).textContent!.trim().split(" ").slice(0, 3).join(" ");

async function seedAndPublish(page: import("@playwright/test").Page, quote: string, body: string): Promise<string> {
  await page.evaluate(
    ({ quote, body }) =>
      docmd.call("threads:add-thread", {
        file: document.body.dataset["sourceFile"],
        anchor: { quote, prefix: null, suffix: null, selector: null, offset: null, blockText: null },
        author: "TestUser",
        authorKey: "TestUser",
        body,
      }),
    { quote, body },
  );
  return (await publishReview(page)).reviewId;
}

async function openReviews(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForSelector("threads-app", { state: "attached", timeout: 10_000 });
  await page.locator(".tc-sidebar-toggle").click();
  await page.getByTestId("tab-reviews").click();
}

test("a published review is listed, its quote links to the thread (same page and across pages), and Discard asks first", async ({ page }) => {
  const quote = await page.evaluate(firstWords);
  const reviewId = await seedAndPublish(page, quote, "reviews journey");
  await page.reload();
  await openReviews(page);

  const entry = page.locator(`[data-testid="review"][data-review-id="${reviewId}"]`);
  await expect(entry).toBeVisible();
  await expect(entry).toContainText("TestUser");
  await expect(entry.getByTestId("review-state")).toHaveText("Published");
  const link = entry.getByTestId("review-op");
  await expect(link).toHaveText(quote);
  await expect(link).toHaveAttribute("href", /#thread-/);

  // Same page: only the fragment changes. Scroll away first so the assertion can fail.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator("mark.threads-highlight").first()).not.toBeInViewport();
  await link.click();
  await expect(page.locator("mark.threads-highlight").first()).toBeInViewport();
  await expect(page.locator("mark.threads-highlight").first()).toHaveClass(/threads-thread--flash/);

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

test("a quote link from another page loads the page, scrolls to the thread and flashes it", async ({ page }) => {
  const restore = snapshotPlaygroundPage("mermaid-preview.md");
  try {
    await page.goto("/mermaid-preview/");
    await page.waitForSelector("threads-app", { state: "attached", timeout: 10_000 });
    const quote = await page.evaluate(firstWords);
    const reviewId = await seedAndPublish(page, quote, "cross-page");

    await page.goto("/");
    await openReviews(page);
    await page.locator(`[data-review-id="${reviewId}"]`).getByTestId("review-op").click();
    await expect(page).toHaveURL(/mermaid-preview\/#thread-/);
    await page.waitForSelector("mark.threads-highlight", { timeout: 10_000 });
    await expect(page.locator("mark.threads-highlight").first()).toBeInViewport();
    await expect(page.locator("mark.threads-highlight").first()).toHaveClass(/threads-thread--flash/);
  } finally {
    restore();
  }
});

test("a deep link to an unknown thread neither scrolls nor flashes, after a full load with a real highlight on the page", async ({ page }) => {
  const quote = await page.evaluate(firstWords);
  await seedAndPublish(page, quote, "unknown id");
  await page.goto("/mermaid-preview/");
  await page.goto("/#thread-nope");
  await page.waitForSelector("mark.threads-highlight", { timeout: 10_000 });
  // Threads are loaded once the highlight exists; give the deep-link handler its turn on the same tick.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  await expect(page.locator(".threads-thread--flash")).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("the open review's title form saves", async ({ page }) => {
  // whoami has a journal only once a draft exists.
  await page.evaluate(() =>
    docmd.call("threads:add-thread", {
      file: document.body.dataset["sourceFile"],
      anchor: null,
      author: "TestUser",
      authorKey: "TestUser",
      body: "title form",
    }),
  );
  await page.reload();
  await openReviews(page);
  await page.getByTestId("review-title").fill("My review");
  await page.getByTestId("review-save").click();
  await expect
    .poll(() => page.evaluate(async () => (await docmd.call("threads:whoami", { author: "TestUser", authorKey: "TestUser" })).journal.review.title))
    .toBe("My review");
});
