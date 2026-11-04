/**
 * Helpers for seeding and cleaning threads in E2E tests.
 *
 * Unlike the old HTTP API-based approach, we use docmd.call() via
 * page.evaluate() to interact with the WebSocket action dispatcher.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect, type Page } from "@playwright/test";
import { DOCS_DIR, PAGES } from "./playground.ts";

/**
 * Restore the playground markdown to the pages global-setup snapshotted, removing any
 * dynamically-added threads/highlights from test runs, and wait until the dev server serves them clean.
 *
 * Workaround for a core dev-server bug: its watcher drops genuine file edits made within 1 s of a rebuild
 * finishing (CONTENT_QUIET_MS in the dev command), so a restore can be missed and is rewritten until served.
 * Remove the retry loop when core stops dropping edits (docmd-53b).
 * At most 3 attempts x 4 s per page keeps the worst case (24 s) under the 30 s hook timeout.
 */
export async function cleanThreads(page: Page): Promise<void> {
  const snapshot = process.env["THREADS_E2E_SNAPSHOT"];
  if (!snapshot) throw new Error("e2e: THREADS_E2E_SNAPSHOT is unset (global-setup did not run)");
  // Drafts live in the journal, not the markdown: an unpublished op would ride into the next test's publish.
  fs.rmSync(path.join(DOCS_DIR, ".threads", "drafts", "TestUser.json"), { force: true });
  for (const { file, route } of PAGES) {
    const served = async () => (await (await page.request.get(route)).text()).includes('<mark class="threads-highlight"');
    for (let attempt = 1; ; attempt++) {
      fs.copyFileSync(path.join(snapshot, file), path.join(DOCS_DIR, file));
      try {
        await expect.poll(served, { message: `dev server rebuild of ${route} after restoring it`, timeout: 4_000 }).toBe(false);
        break;
      } catch (e) {
        if (attempt === 3) throw e;
      }
    }
  }
}

/** Snapshot the published-review manifests; the returned function deletes those created since. */
export function snapshotReviews(): () => void {
  const dir = path.join(DOCS_DIR, ".threads", "reviews");
  const list = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  const before = new Set(list());
  return () => {
    for (const f of list()) if (!before.has(f)) fs.rmSync(path.join(dir, f), { force: true });
  };
}

/** The served HTML of the current page (the dev server re-renders it after each rebuild). */
const servedHtml = (page: Page): Promise<string> =>
  page.evaluate(async () => (await fetch(location.pathname + location.search, { cache: "no-store" })).text());

/**
 * Publish the open review of `author` (comments are drafts until published); an empty review rejects.
 * Publishing writes the markdown and the dev server rebuilds asynchronously, so this resolves once the
 * served page differs from before the publish: a reload right after would otherwise race the rebuild.
 * Workaround for the same core dev-server bug as cleanThreads (it drops edits within 1 s of a rebuild): if the
 * publish landed in that window the page is rebuilt by appending a newline to its source (the next cleanThreads
 * restores it). Remove the fallback with the core fix (docmd-53b).
 */
export async function publishReview(page: Page, author = "TestUser"): Promise<{ reviewId: string }> {
  const before = await servedHtml(page);
  const sourceFile = await page.evaluate(() => document.body.dataset["sourceFile"]);
  const result = await page.evaluate((a) => docmd.call("threads:publish-review", { author: a }), author);
  const rebuilt = () => expect.poll(() => servedHtml(page), { message: "dev server rebuild after publish", timeout: 4_000 }).not.toBe(before);
  try {
    await rebuilt();
  } catch {
    if (sourceFile) fs.appendFileSync(path.resolve(DOCS_DIR, "..", sourceFile), "\n");
    await expect.poll(() => servedHtml(page), { message: "dev server rebuild after publish", timeout: 15_000 }).not.toBe(before);
  }
  return result;
}

/**
 * Seed a thread via the WebSocket action dispatcher.
 * Must be called after the page is loaded and docmd global is available.
 *
 * Each WebSocket call writes to the markdown file, which may trigger the
 * dev server's file watcher to hot-reload the page. To avoid execution
 * context destruction, we split multi-step operations (add-thread +
 * add-comment replies) across separate page.evaluate() calls with page
 * reloads in between.
 */
export async function seedThread(
  page: Page,
  options: {
    author?: string;
    body?: string;
    anchor?: { quote: string } | null;
    replies?: Array<{ author?: string; body: string }>;
    resolved?: boolean;
  } = {},
): Promise<{ id: string; comments: Array<{ id: string }> }> {
  const {
    author = "TestUser",
    body = "Seeded comment",
    anchor = null,
    replies = [],
    resolved = false,
  } = options;

  // Step 1: Create the thread with its first comment
  const thread = await page.evaluate(
    async ({ author, body, anchor }) => {
      const file = document.body.dataset["sourceFile"];
      if (!file) throw new Error("data-source-file not found on body");

      return docmd.call("threads:add-thread", {
        file,
        author,
        body,
        anchor: anchor
          ? {
              quote: anchor.quote,
              prefix: null,
              suffix: null,
              selector: null,
              offset: null,
              blockText: null,
            }
          : null,
      });
    },
    { author, body, anchor },
  );

  // Comments are drafts until published; replies need the thread to be in the file.
  await publishReview(page, author);

  const commentIds = [thread.comments[0].id];

  // Step 2: Add replies one at a time, reloading the page between each
  // to avoid execution context destruction from hot-reload
  for (const reply of replies) {
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("threads-app", { state: "attached", timeout: 10_000 });

    const comment = await page.evaluate(
      async ({ file, threadId, replyAuthor, replyBody }) => {
        const f = file || document.body.dataset["sourceFile"];
        return docmd.call("threads:add-comment", {
          file: f,
          threadId,
          author: replyAuthor,
          body: replyBody,
        });
      },
      {
        file: null as string | null,
        threadId: thread.id,
        replyAuthor: reply.author ?? "TestUser",
        replyBody: reply.body,
      },
    );
    commentIds.push(comment.id);
    await publishReview(page, reply.author ?? "TestUser");
  }

  // Step 3: Resolve if requested
  if (resolved) {
    // Always reload before resolving to ensure the DOM is fresh after the last write
    // and avoid execution context destruction during the resolve-thread call.
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("threads-app", { state: "attached", timeout: 10_000 });

    await page.evaluate(
      async ({ threadId, resolvedBy }) => {
        const file = document.body.dataset["sourceFile"];
        return docmd.call("threads:resolve-thread", {
          file,
          threadId,
          author: resolvedBy,
          resolved_by: resolvedBy,
        });
      },
      { threadId: thread.id, resolvedBy: author },
    );
  }

  // Resolving is a draft op too: publish it.
  if (resolved) await publishReview(page, author);

  return {
    id: thread.id,
    comments: commentIds.map((id) => ({ id })),
  };
}

/**
 * Reload the page and wait for the threads-app element to re-attach.
 * After seeding/cleaning threads via WebSocket actions, the markdown file
 * on disk has changed. Give the dev server a moment to detect the change,
 * then reload.
 */
export async function waitForReload(page: Page): Promise<void> {
  await page.waitForTimeout(2000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("threads-app", { state: "attached", timeout: 10_000 });
}

/**
 * Seed a thread, reload the page, and wait until the thread element appears
 * in the server-rendered HTML.
 */
export async function seedAndReload(
  page: Page,
  options: Parameters<typeof seedThread>[1] = {},
): Promise<{ id: string; comments: Array<{ id: string }> }> {
  const result = await seedThread(page, options);

  // The seed action writes to the markdown file. The dev server needs time
  // to detect the change and re-render. Retry the reload until the thread
  // appears in the server-rendered HTML (up to 3 attempts).
  const selector = `.threads-thread[data-thread-id="${result.id}"]`;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForTimeout(attempt === 0 ? 500 : 1500);
    await page.goto(page.url(), { waitUntil: "domcontentloaded" });
    await page.waitForSelector("threads-app", { state: "attached", timeout: 10_000 });

    const found = await page.locator(selector).count();
    if (found > 0) return result;
  }

  // Final attempt - let Playwright's own timeout handle it
  await page.waitForSelector(selector, { state: "attached", timeout: 5_000 });

  return result;
}

/**
 * Set the author identity in localStorage.
 */
export async function setAuthor(page: Page, name: string): Promise<void> {
  await page.evaluate(
    (authorName) => localStorage.setItem("threads_author", authorName),
    name,
  );
}

/**
 * Wait for the client-side threads-app to finish processing:
 * scanRenderedHighlights assigns color classes, moves thread cards inline, etc.
 * We detect completion by waiting for the first highlight to receive a color class.
 */
export async function waitForClientProcessing(page: Page): Promise<void> {
  const hasHighlights = await page.locator("mark.threads-highlight[data-thread-id]").count();
  if (hasHighlights > 0) {
    // Wait for the first highlight to get a color class (assigned by scanRenderedHighlights)
    await page.waitForFunction(
      () => {
        const mark = document.querySelector("mark.threads-highlight[data-thread-id]");
        if (!mark) return true; // No highlights, nothing to wait for
        return Array.from(mark.classList).some((c) => c.startsWith("threads-hl-"));
      },
      { timeout: 5_000 },
    );
  } else {
    // No highlights on page, just wait a moment for client JS to initialize
    await page.waitForTimeout(500);
  }
}