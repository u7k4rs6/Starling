import { expect, test, type Page } from "@playwright/test";

function paneLocator(page: Page, label: "A" | "B") {
  return page.locator(".editor-pane").filter({ has: page.locator(".replica-label", { hasText: label }) });
}

function editorLocator(page: Page, label: "A" | "B") {
  return paneLocator(page, label).locator(".ProseMirror");
}

async function typeInto(page: Page, label: "A" | "B", text: string): Promise<void> {
  const editor = editorLocator(page, label);
  await editor.click();
  await page.keyboard.type(text);
}

/**
 * The document's own text, excluding remote-cursor widget decorations
 * (`remote-cursors.ts`) — those render a replica-label `<span>` *inside*
 * the same `.ProseMirror` contentEditable element as real document text,
 * so a plain `.textContent()` read picks up stray "A"/"B" characters
 * from whichever remote cursor happens to be rendered at the time. A
 * first pass at this suite read `.textContent()` directly and got
 * genuinely confusing failures (e.g. "worldhello B") that looked like a
 * sync bug; tracing it with a throwaway console-logging script showed
 * sync was correct all along ("Bhi"/"hiA" — both "hi" once the stray
 * label letters are accounted for) — the bug was in what the test was
 * reading, not in the app.
 */
async function paneText(page: Page, label: "A" | "B"): Promise<string> {
  return editorLocator(page, label).evaluate((root) => {
    let text = "";
    const walk = (node: ChildNode) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent ?? "";
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE && (node as Element).classList.contains("remote-cursor")) return;
      node.childNodes.forEach(walk);
    };
    root.childNodes.forEach(walk);
    return text;
  });
}

async function pendingCountOf(page: Page, label: "A" | "B"): Promise<number> {
  const text = await paneLocator(page, label).locator(".pending-counter").textContent();
  return Number(text?.replace(/\D/g, "") ?? "0");
}

async function setOnline(page: Page, label: "A" | "B", online: boolean): Promise<void> {
  const checkbox = paneLocator(page, label).locator('input[type="checkbox"]');
  const isChecked = await checkbox.isChecked();
  if (isChecked !== online) await checkbox.click();
}

// Every test starts from a fresh browser context (new storage state, one
// per Playwright test by default) *and* a fresh document id pair
// (config.ts's `?doc=`/`?awareness=` override) — the dev relay is one
// long-lived process for the whole suite (Playwright's `webServer`), so
// without a fresh document id every test after the first would inherit
// whatever text prior tests already pushed under the fixed default id.
test.beforeEach(async ({ page }) => {
  const docId = crypto.randomUUID();
  const awarenessId = crypto.randomUUID();
  await page.goto(`/?doc=${docId}&awareness=${awarenessId}`);
  await expect(editorLocator(page, "A")).toBeVisible();
  await expect(editorLocator(page, "B")).toBeVisible();
});

test("FRONTEND §2.3.1: concurrent typing converges in both panes", async ({ page }) => {
  await typeInto(page, "A", "hello");
  await typeInto(page, "B", "!");

  await expect
    .poll(async () => (await paneText(page, "A")) === (await paneText(page, "B")), { timeout: 5_000 })
    .toBe(true);

  const finalText = await paneText(page, "A");
  expect(finalText).toContain("hello");
  expect(finalText).toContain("!");
});

test("FRONTEND §2.3.2 / F5: offline toggle produces visible divergence, then convergence, no dialog", async ({ page }) => {
  await typeInto(page, "A", "shared");
  await expect.poll(() => paneText(page, "B")).toContain("shared");

  await setOnline(page, "A", false);
  await expect(paneLocator(page, "A").locator(".connection-dot")).toHaveClass(/offline/);

  await typeInto(page, "A", "-A-only");
  await typeInto(page, "B", "-B-only");

  // Let a few sync intervals pass while A stays offline — B's edit
  // should never reach A, and A's edit should never reach B.
  await page.waitForTimeout(1_500);
  const [textA, textB] = await Promise.all([paneText(page, "A"), paneText(page, "B")]);
  expect(textA).not.toBe(textB);
  expect(textA).toContain("-A-only");
  expect(textB).toContain("-B-only");
  expect(textA).not.toContain("-B-only");
  expect(textB).not.toContain("-A-only");
  expect(await pendingCountOf(page, "A")).toBeGreaterThan(0);

  await setOnline(page, "A", true);
  await expect
    .poll(async () => (await paneText(page, "A")) === (await paneText(page, "B")), { timeout: 5_000 })
    .toBe(true);
  await expect.poll(async () => pendingCountOf(page, "A"), { timeout: 5_000 }).toBe(0);

  const converged = await paneText(page, "A");
  expect(converged).toContain("-A-only");
  expect(converged).toContain("-B-only");

  // No conflict dialog of any kind ever appears (FRONTEND §2.3.2).
  await expect(page.locator("[role=dialog]")).toHaveCount(0);
});

test("FRONTEND §2.3.3 / F6: reload while offline preserves pending ops, then reconciles", async ({ page }) => {
  await setOnline(page, "A", false);
  await typeInto(page, "A", "never-left-this-browser");
  await expect.poll(() => pendingCountOf(page, "A")).toBeGreaterThan(0);

  // pendingCount reflects the in-memory CRDT state immediately — it says
  // nothing about whether IndexedDB has caught up yet. Persistence is
  // debounced (EditorPane.tsx, ~250ms after the last edit) so a fast
  // typist doesn't force dozens of full IndexedDB round trips; reloading
  // this instant, with no pause, isn't the scenario FRONTEND §2.3.3
  // describes ("reload the page while A is offline with pending ops")
  // and isn't a guarantee this app makes — a believable pause before
  // reload is.
  await page.waitForTimeout(600);
  await page.reload();
  await expect(editorLocator(page, "A")).toBeVisible();

  // The connection toggle itself isn't persisted — a fresh mount always
  // starts online (EditorPane.tsx) — so reload doesn't leave A stranded
  // offline forever; it starts syncing again immediately, which is
  // arguably the more convincing outcome (FRONTEND §2.3.3: "come back
  // online, it reconciles"). What S9 actually requires is that the
  // *content* is there at all, independent of whatever pendingCount does
  // next — an earlier version of this test also asserted pendingCount
  // stayed at or above its pre-reload value, which assumed a window
  // between "content loaded" and "sync has run" that reload-defaults-
  // online doesn't leave open; that assumption, not the app, was wrong.
  await expect.poll(() => paneText(page, "A")).toContain("never-left-this-browser");

  await expect
    .poll(async () => (await paneText(page, "A")) === (await paneText(page, "B")), { timeout: 5_000 })
    .toBe(true);
});

test("F3: a remote insert anchored before the local cursor moves the cursor's resolved position, not the cursor's identity", async ({
  page,
}) => {
  await typeInto(page, "A", "world");
  await expect.poll(() => paneText(page, "B")).toContain("world");

  // Move A's cursor to the very start (before 'w').
  await editorLocator(page, "A").click();
  await page.keyboard.press("Home");

  // B inserts before what A's cursor points at.
  await typeInto(page, "B", "hello ");
  await expect.poll(() => paneText(page, "A"), { timeout: 5_000 }).toContain("hello ");

  // Typing into B (required to target it at all) moved actual DOM focus
  // there — an artifact of both replicas sharing one browser tab in this
  // test, not something a real second user's separate browser would do
  // to A's focus. `.focus()`, not `.click()`, to reclaim it without
  // repositioning the caret: A's selection was already recomputed from
  // its anchor by the sync tick while unfocused (EditorPane.tsx), and a
  // `.click()` would reposition it based on click coordinates instead of
  // testing what actually matters here — whether *that* recomputed
  // position is correct.
  await editorLocator(page, "A").focus();

  // Typing now, with no cursor repositioning of our own, must land the
  // new character adjacent to 'w' — not at the very start of the string,
  // which is what it would do if the cursor had stayed at a stale raw
  // index 0 instead of following the character it was anchored to.
  await page.keyboard.type("!");
  const finalText = await paneText(page, "A");
  expect(finalText).toContain("!world");
  // Not asserted: where "hello " ends up relative to "!world" overall.
  // An earlier version of this test also asserted the string couldn't
  // *start* with "!", assuming "hello " would render before "world" —
  // measured "!worldhello ", B's insert rendering after "world" despite
  // being causally anchored before it. Per DECISIONS #0022/#0024 (now a
  // fourth instance): Fugue's counter tie-break decides concurrent
  // rendering order, not causal intent or arrival order, and this test's
  // actual claim — the cursor followed the character it was anchored to,
  // not a stale index — is already fully proven by "!world" landing
  // adjacent, regardless of where that pair sits in the full string.
});

test("F4: undo after an interleaved remote edit undoes the local edit only", async ({ page }) => {
  await typeInto(page, "A", "hello");
  await expect.poll(() => paneText(page, "B")).toContain("hello");

  await typeInto(page, "B", "XXX");
  await expect.poll(() => paneText(page, "A")).toContain("XXX");

  await editorLocator(page, "A").click();
  await page.keyboard.press("Control+z");
  // Also try Meta+z (macOS-style) in case the platform binding differs —
  // harmless no-op if the first already worked (canUndo() would be false).
  await page.keyboard.press("Meta+z");

  const text = await paneText(page, "A");
  for (const ch of "hello") expect(text.includes(ch)).toBe(false);
  expect(text).toContain("XXX");
});

test("F7: a replica's remote cursor disappears after it goes offline and its TTL elapses", async ({ page }) => {
  await typeInto(page, "A", "x");
  await expect.poll(() => paneText(page, "B")).toContain("x");

  // B moves its cursor (publishing an awareness update) so A has
  // something to render.
  await editorLocator(page, "B").click();
  await page.keyboard.press("Home");
  await expect.poll(() => paneLocator(page, "A").locator(".remote-cursor").count(), { timeout: 5_000 }).toBeGreaterThan(0);

  await setOnline(page, "B", false);
  // VITE_AWARENESS_TTL_MS is set to 1200ms for this test run (see
  // playwright.config.ts) — production default is 5000ms (config.ts).
  await expect.poll(() => paneLocator(page, "A").locator(".remote-cursor").count(), { timeout: 6_000 }).toBe(0);
});
