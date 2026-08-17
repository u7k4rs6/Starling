import { expect, test, type Page } from "@playwright/test";

/**
 * Drives the deployed demo's actual UI (App.tsx): two replicas of one document
 * on a shared in-browser log, a break-it control panel, and a convergence strip
 * that compares the two documents. The default page needs no relay, so these run
 * against the local-first path; the last test exercises the share handoff over
 * the dev relay. Awareness, remote cursors, and reload-persistence are no longer
 * part of the demo (App uses in-memory persistence and no cursor channel), so
 * the old F6/F7 cases are gone rather than ported.
 */

function pane(page: Page, label: "A" | "B") {
  return page.locator(".pane").filter({ has: page.locator(".pane-label", { hasText: `replica ${label}` }) });
}

function editor(page: Page, label: "A" | "B") {
  return pane(page, label).locator(".ProseMirror");
}

function linkToggle(page: Page, label: "A" | "B") {
  return page.locator(".link-toggle", { hasText: `${label}'s link` });
}

async function typeInto(page: Page, label: "A" | "B", text: string): Promise<void> {
  await editor(page, label).click();
  await page.keyboard.type(text);
}

async function paneText(page: Page, label: "A" | "B"): Promise<string> {
  return (await editor(page, label).textContent()) ?? "";
}

// Each test gets a fresh browser context (fresh localStorage, so fresh replica
// ids) and the local log lives only in the page, so no test inherits another's
// text and no per-test document id override is needed.
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(editor(page, "A")).toBeVisible();
  await expect(editor(page, "B")).toBeVisible();
});

test("concurrent typing converges in both panes", async ({ page }) => {
  await typeInto(page, "A", "hello");
  await typeInto(page, "B", "!");

  await expect
    .poll(async () => (await paneText(page, "A")) === (await paneText(page, "B")), { timeout: 5_000 })
    .toBe(true);

  const finalText = await paneText(page, "A");
  expect(finalText).toContain("hello");
  expect(finalText).toContain("!");
  await expect(page.locator(".status")).toHaveClass(/status-converged/);
});

test("cutting a replica's link diverges the document, restoring it reconverges, with no dialog", async ({ page }) => {
  await typeInto(page, "A", "shared");
  await expect.poll(() => paneText(page, "B")).toContain("shared");

  await linkToggle(page, "A").click();
  await expect(linkToggle(page, "A")).toHaveText(/restore/);

  await typeInto(page, "A", "-A");
  await typeInto(page, "B", "-B");

  // Give several sync intervals a chance to run: neither edit should cross the
  // cut link.
  await page.waitForTimeout(1_500);
  const [textA, textB] = await Promise.all([paneText(page, "A"), paneText(page, "B")]);
  expect(textA).not.toBe(textB);
  expect(textA).toContain("-A");
  expect(textB).toContain("-B");
  expect(textA).not.toContain("-B");
  expect(textB).not.toContain("-A");
  await expect(page.locator(".status")).toHaveClass(/status-diverged/);

  await linkToggle(page, "A").click();
  await expect
    .poll(async () => (await paneText(page, "A")) === (await paneText(page, "B")), { timeout: 5_000 })
    .toBe(true);
  await expect(page.locator(".status")).toHaveClass(/status-converged/);

  const converged = await paneText(page, "A");
  expect(converged).toContain("-A");
  expect(converged).toContain("-B");

  // No conflict dialog of any kind ever appears.
  await expect(page.locator("[role=dialog]")).toHaveCount(0);
});

test("undo removes only the local edit, not an interleaved remote one", async ({ page }) => {
  await typeInto(page, "A", "hello");
  await expect.poll(() => paneText(page, "B")).toContain("hello");

  await typeInto(page, "B", "XXX");
  await expect.poll(() => paneText(page, "A")).toContain("XXX");

  await editor(page, "A").click();
  await page.keyboard.press("Control+z");
  // Meta+z too, in case the platform binding differs; a harmless no-op if the
  // first already emptied the undo stack.
  await page.keyboard.press("Meta+z");

  const text = await paneText(page, "A");
  for (const ch of "hello") expect(text.includes(ch)).toBe(false);
  expect(text).toContain("XXX");
});

test("sharing hands both replicas to the relay and they still converge", async ({ page }) => {
  await typeInto(page, "A", "local");
  await expect.poll(() => paneText(page, "B")).toContain("local");

  await page.locator(".share-button").click();
  await expect(page.locator(".share-url")).toBeVisible();

  await typeInto(page, "B", "-relayed");
  await expect
    .poll(async () => (await paneText(page, "A")) === (await paneText(page, "B")), { timeout: 8_000 })
    .toBe(true);

  const text = await paneText(page, "A");
  expect(text).toContain("local");
  expect(text).toContain("-relayed");
});

test("a room that fills up surfaces a terminal frozen state and offers a fresh room", async ({ page }) => {
  // The e2e relay runs with a tiny per-doc freeze cap (playwright.config.ts), so
  // a paragraph of text is enough to fill a shared room.
  await page.locator(".share-button").click();
  await expect(page.locator(".share-url")).toBeVisible();

  await editor(page, "A").click();
  await page.keyboard.type("x".repeat(220));

  // The frozen banner appears: the edits stopped propagating and the visitor is
  // told, rather than diverging silently.
  await expect(page.locator(".frozen")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".frozen-button")).toBeVisible();

  // Recovery: start a fresh room drops back to a clean local session.
  await page.locator(".frozen-button").click();
  await expect(page.locator(".share-button")).toBeVisible();
  await expect(page.locator(".frozen")).toHaveCount(0);
});

test("the break-it controls still work after sharing over the relay", async ({ page }) => {
  // Item 3: the controls wrap the active transport, including the relay one, so
  // partitioning must still diverge and heal after the handoff.
  await typeInto(page, "A", "base");
  await expect.poll(() => paneText(page, "B")).toContain("base");

  await page.locator(".share-button").click();
  await expect(page.locator(".share-url")).toBeVisible();

  await linkToggle(page, "B").click(); // cut B, now over the relay
  await expect(linkToggle(page, "B")).toHaveText(/restore/);

  await typeInto(page, "A", "-A");
  await typeInto(page, "B", "-B");
  await page.waitForTimeout(1_500);
  const [textA, textB] = await Promise.all([paneText(page, "A"), paneText(page, "B")]);
  expect(textA).not.toBe(textB); // partition still bites after the handoff
  expect(textA).not.toContain("-B");

  await linkToggle(page, "B").click(); // restore
  await expect
    .poll(async () => (await paneText(page, "A")) === (await paneText(page, "B")), { timeout: 8_000 })
    .toBe(true);
});
