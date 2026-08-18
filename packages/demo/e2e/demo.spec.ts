import { expect, test, type Page } from "@playwright/test";

// The Starling v8 UI: two textarea panes bound to real Docs, a hex CORE cut
// control, and the real relay handoff. Selectors are the data-* hooks the
// components expose. The cut hexes jitter by design when severed, so their
// clicks use { force: true } to skip Playwright's element-stable wait.

function ta(page: Page, site: "A" | "B") {
  return page.locator(`[data-pane="${site}"] textarea`);
}

async function typeInto(page: Page, site: "A" | "B", text: string): Promise<void> {
  await ta(page, site).click();
  await page.keyboard.type(text);
}

async function paneText(page: Page, site: "A" | "B"): Promise<string> {
  return ta(page, site).inputValue();
}

async function toggleLink(page: Page, site: "A" | "B"): Promise<void> {
  await page.locator(`[data-hex="${site}"]`).click({ force: true });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(ta(page, "A")).toBeVisible();
  await expect(ta(page, "B")).toBeVisible();
});

test("concurrent typing converges in both panes", async ({ page }) => {
  await typeInto(page, "A", "hello");
  await typeInto(page, "B", "!");

  await expect.poll(async () => (await paneText(page, "A")) === (await paneText(page, "B")), { timeout: 6_000 }).toBe(true);
  const finalText = await paneText(page, "A");
  expect(finalText).toContain("hello");
  expect(finalText).toContain("!");
  await expect(page.locator("[data-verdict]")).toHaveText("FULLY CONVERGED", { timeout: 6_000 });
});

test("cutting a replica's link diverges the document, restoring it reconverges, with no dialog", async ({ page }) => {
  await typeInto(page, "A", "shared");
  await expect.poll(() => paneText(page, "B")).toContain("shared");

  await toggleLink(page, "A");
  await typeInto(page, "A", " -A");
  await typeInto(page, "B", " -B");

  await page.waitForTimeout(1_500);
  const [textA, textB] = await Promise.all([paneText(page, "A"), paneText(page, "B")]);
  expect(textA).not.toBe(textB);
  expect(textA).toContain("-A");
  expect(textB).toContain("-B");
  expect(textA).not.toContain("-B");
  await expect(page.locator("[data-verdict]")).toHaveText("DIVERGED", { timeout: 6_000 });

  await toggleLink(page, "A");
  await expect.poll(async () => (await paneText(page, "A")) === (await paneText(page, "B")), { timeout: 6_000 }).toBe(true);
  await expect(page.locator("[data-verdict]")).toHaveText("FULLY CONVERGED", { timeout: 6_000 });

  // No conflict dialog of any kind ever appears.
  await expect(page.locator("[role=dialog]")).toHaveCount(0);
});

test("sharing hands both replicas to the relay and they still converge", async ({ page }) => {
  await typeInto(page, "A", "local");
  await expect.poll(() => paneText(page, "B")).toContain("local");

  await page.locator("[data-share]").click();
  await expect(page.locator("[data-room-link]")).toBeVisible({ timeout: 12_000 });

  await typeInto(page, "B", " -relayed");
  await expect.poll(async () => (await paneText(page, "A")) === (await paneText(page, "B")), { timeout: 10_000 }).toBe(true);
  const text = await paneText(page, "A");
  expect(text).toContain("local");
  expect(text).toContain("-relayed");
});

test("polling resumes after the tab is backgrounded past the hidden-stop, then foregrounded", async ({ page }) => {
  // Regression for the live cold-start stall: the e2e vite server runs with a
  // shrunk hidden grace so the stop is reachable in seconds.
  await page.locator("[data-share]").click();
  await expect(page.locator("[data-room-link]")).toBeVisible({ timeout: 12_000 });

  await page.evaluate(() => {
    let vis = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => vis });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => vis === "hidden" });
    (window as unknown as { __setVis: (v: string) => void }).__setVis = (v: string) => {
      vis = v;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
  await typeInto(page, "A", "before-hide");
  await expect.poll(() => paneText(page, "B"), { timeout: 8_000 }).toContain("before-hide");

  await page.evaluate(() => (window as unknown as { __setVis: (v: string) => void }).__setVis("hidden"));
  await page.waitForTimeout(2_500);

  await page.evaluate(() => (window as unknown as { __setVis: (v: string) => void }).__setVis("visible"));
  await typeInto(page, "A", " after-return");
  await expect.poll(() => paneText(page, "B"), { timeout: 8_000 }).toContain("after-return");
  await expect.poll(async () => (await paneText(page, "A")) === (await paneText(page, "B")), { timeout: 8_000 }).toBe(true);
});

test("a room that fills up surfaces a terminal frozen state and offers a fresh room", async ({ page }) => {
  // The e2e relay runs with a tiny per-doc freeze cap (playwright.config.ts).
  await page.locator("[data-share]").click();
  await expect(page.locator("[data-room-link]")).toBeVisible({ timeout: 12_000 });

  await ta(page, "A").click();
  await page.keyboard.type("x".repeat(220));

  await expect(page.locator("[data-frozen]")).toBeVisible({ timeout: 12_000 });
  await expect(page.locator("[data-fresh-room]")).toBeVisible();

  await page.locator("[data-fresh-room]").click();
  await expect(page.locator("[data-share]")).toBeVisible();
  await expect(page.locator("[data-frozen]")).toHaveCount(0);
});

test("the break-it controls still work after sharing over the relay", async ({ page }) => {
  await typeInto(page, "A", "base");
  await expect.poll(() => paneText(page, "B")).toContain("base");

  await page.locator("[data-share]").click();
  await expect(page.locator("[data-room-link]")).toBeVisible({ timeout: 12_000 });

  await toggleLink(page, "B");
  await typeInto(page, "A", " -A");
  await typeInto(page, "B", " -B");
  await page.waitForTimeout(1_500);
  const [textA, textB] = await Promise.all([paneText(page, "A"), paneText(page, "B")]);
  expect(textA).not.toBe(textB);
  expect(textA).not.toContain("-B");

  await toggleLink(page, "B");
  await expect.poll(async () => (await paneText(page, "A")) === (await paneText(page, "B")), { timeout: 10_000 }).toBe(true);
});

test("the theme toggle switches palettes", async ({ page }) => {
  await page.locator('[data-theme-btn="light"]').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  await page.locator('[data-theme-btn="dark"]').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
});
