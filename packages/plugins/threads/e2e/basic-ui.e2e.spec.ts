/**
 * Basic UI tests - adapted from old devtalk.e2e.spec.ts "basic UI" describe block.
 *
 * Runs against the inline site (threads plugin without its sidebar), see playwright.config.ts.
 *
 * Changes from old plugin:
 * - No sidebar panel/toggle button (inline-only architecture)
 * - threads-app replaces devtalk-app as root element
 * - "New Thread" button replaces sidebar toggle
 * - Threads rendered server-side with .threads-* classes
 * - The playground index has no threads of its own: the file seeds two published, anchored threads once
 *   (the tests only read them), and restores the page afterwards
 */

import { test, expect } from "@playwright/test";
import { Actor, NavigateTo } from "./screenplay.ts";
import { cleanThreads, seedAndReload, setAuthor, waitForClientProcessing } from "./helpers.ts";



let user: Actor;

test.beforeAll(async ({ browser }, testInfo) => {
  // cleanThreads plus two publishes (each polls up to 5 s per page) can outlast the default hook timeout.
  testInfo.setTimeout(90_000);
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  try {
    await page.goto("/");
    await page.waitForSelector("threads-app", { state: "attached", timeout: 10_000 });
    await setAuthor(page, "TestUser");
    await cleanThreads(page);
    await page.reload();
    // v2: threads render server-side only once published; seed two published, anchored threads.
    await seedAndReload(page, { body: "First seeded comment", anchor: { quote: "manual integration playground" } });
    await seedAndReload(page, { body: "Second seeded comment", anchor: { quote: "latest release features" } });
  } finally {
    await page.close();
  }
});

test.beforeEach(async ({ page }) => {
  user = new Actor("TestUser", page);
  await page.goto("/");
  await page.waitForSelector("threads-app", { state: "attached", timeout: 10_000 });
  await setAuthor(page, "TestUser");
  // Wait for client-side JS to finish processing highlights
  await waitForClientProcessing(page);
});

test.afterAll(async ({ browser }, testInfo) => {
  testInfo.setTimeout(60_000);
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  try {
    await page.goto("/");
    await page.waitForSelector("threads-app", { state: "attached", timeout: 10_000 });
    await cleanThreads(page);
  } finally {
    await page.close();
  }
});

test.describe("threads plugin - basic UI", () => {
  test("loads on the page with threads-app element", async () => {
    await user.perform(NavigateTo.path("/"));
    const app = user.page.locator("threads-app");
    await expect(app).toBeAttached();
  });

  test("New Thread button is injected into the content area", async () => {
    await user.perform(NavigateTo.path("/"));
    const btn = user.page.locator(".threads-new-thread-btn").first();
    await expect(btn).toBeVisible({ timeout: 5_000 });
    await expect(btn).toContainText("New Thread");
  });

  test("server-rendered threads appear with correct class structure", async () => {
    // The seeded threads are published, so the server renders them
    await user.perform(NavigateTo.path("/"));

    // There should be thread cards rendered from the markdown
    const threads = user.page.locator(".threads-thread[data-thread-id]:visible");
    await expect(threads).toHaveCount(2);

    // Each thread should have at least one comment
    const firstThread = threads.first();
    const comments = firstThread.locator(".threads-comment");
    await expect(comments.first()).toBeAttached();
  });

  test("highlights appear on marked text", async () => {
    await user.perform(NavigateTo.path("/"));

    // The playground has ==highlighted text=={thread-id} in the markdown
    const highlights = user.page.locator("mark.threads-highlight[data-thread-id]");
    await expect(highlights).toHaveCount(2);
  });

  test("highlights have cycling colors (not all the same)", async () => {
    await user.perform(NavigateTo.path("/"));
    await waitForClientProcessing(user.page);

    const highlights = user.page.locator("mark.threads-highlight[data-thread-id]");
    const count = await highlights.count();

    // The two seeded threads are anchored in the page: both must be highlighted
    expect(count).toBe(2);

    // Collect all highlight color classes
    const colorClasses: string[] = [];
    for (let i = 0; i < count; i++) {
      const classList = await highlights.nth(i).evaluate((el) =>
        Array.from(el.classList).filter((c) => c.startsWith("threads-hl-")),
      );
      colorClasses.push(...classList);
    }

    // With 2+ highlights, we should see at least 2 different colors
    const uniqueColors = new Set(colorClasses);
    expect(uniqueColors.size).toBeGreaterThanOrEqual(2);
  });

  test("thread cards are placed inline after their highlighted block", async () => {
    await user.perform(NavigateTo.path("/"));
    await waitForClientProcessing(user.page);

    // Both seeded quotes sit in the page's intro paragraph: each card must stack right after it
    const highlights = user.page.locator("mark.threads-highlight[data-thread-id]");
    await expect(highlights).toHaveCount(2);
    const intro = user.page.locator("p", { hasText: "Welcome to the manual integration playground" }).first();

    for (let i = 0; i < 2; i++) {
      const threadId = await highlights.nth(i).getAttribute("data-thread-id");
      expect(threadId).toBeTruthy();
      await expect(
        intro.locator(`xpath=following-sibling::*[position()<=2][@data-thread-id="${threadId}"]`),
      ).toHaveCount(1);
    }
  });

  test("thread cards have matching border colors to their highlights", async () => {
    await user.perform(NavigateTo.path("/"));
    await waitForClientProcessing(user.page);

    const highlights = user.page.locator("mark.threads-highlight[data-thread-id]");
    const firstHighlight = highlights.first();

    await expect(highlights).toHaveCount(2);

    const threadId = await firstHighlight.getAttribute("data-thread-id");
    expect(threadId).toBeTruthy();

    // Get the highlight's color class
    const hlColorClass = await firstHighlight.evaluate((el) =>
      Array.from(el.classList).find((c) => c.startsWith("threads-hl-")),
    );

    expect(hlColorClass).toBeTruthy();

    // The thread card should have the matching border class
    const expectedBorderClass = hlColorClass!.replace("threads-hl-", "threads-border-");
    const threadCard = user.page.locator(`.threads-thread[data-thread-id="${threadId}"]:visible`);
    const hasBorderClass = await threadCard.evaluate(
      (el, cls) => el.classList.contains(cls),
      expectedBorderClass,
    );
    expect(hasBorderClass).toBe(true);
  });

  test("clicking a highlight scrolls to and flashes its thread", async () => {
    await user.perform(NavigateTo.path("/"));
    await waitForClientProcessing(user.page);

    const highlights = user.page.locator("mark.threads-highlight[data-thread-id]");
    const firstHighlight = highlights.first();

    await expect(highlights).toHaveCount(2);

    await firstHighlight.click();

    // The click opens the side panel and flashes the thread's copy in it
    const threadId = await firstHighlight.getAttribute("data-thread-id");
    const threadCard = user.page.locator(`.tc-panel__body .threads-thread[data-thread-id="${threadId}"]`);
    await expect(threadCard).toHaveClass(/threads-thread--flash/, { timeout: 2_000 });
  });

  test("popover hidden initially without text selection", async () => {
    await user.perform(NavigateTo.path("/"));

    // Without any text selection, the popover should not show
    await expect(
      user.page.locator("threads-popover").getByText("Add comment"),
    ).not.toBeVisible();
  });

  test("reply buttons present on thread cards", async () => {
    await user.perform(NavigateTo.path("/"));

    const threads = user.page.locator(".threads-thread[data-thread-id]:visible");
    const count = await threads.count();

    expect(count).toBe(2);

    // Each thread should have a Reply button
    for (let i = 0; i < count; i++) {
      const thread = threads.nth(i);
      const replyBtn = thread.locator(".threads-comment-reply-btn").first();
      await expect(replyBtn).toBeAttached();
      await expect(replyBtn).toContainText("Reply");
    }
  });

  test("threads-sidebar container is hidden", async () => {
    await user.perform(NavigateTo.path("/"));

    // The raw sidebar wrapper the markdown renders is there (threads are seeded) and must be hidden (display: none)
    const sidebar = user.page.locator(".threads-sidebar");
    await expect(sidebar).toHaveCount(1);
    await expect(sidebar).toBeHidden();
  });
});
