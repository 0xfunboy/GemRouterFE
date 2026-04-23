import type { Locator, Page } from "playwright";

import { GeminiNotReadyError, GeminiQuotaError, GeminiTimeoutError } from "./errors.js";
import type {
  ConversationSnapshot,
  GeminiConfig,
  GeminiProviderConfig,
  GeminiResponse,
  GeneratedImage,
  GeneratedMedia,
  GeneratedMusicDownloads,
} from "./types.js";

const QUOTA_PATTERNS = [
  /you('ve| have) (reached|exceeded|hit) (your |the )?(daily |usage |message |free )?limit/i,
  /quota (exceeded|limit|reached)/i,
  /rate limit/i,
  /try again (in|after) \d/i,
  /daily usage limit/i,
];

const SIGNED_OUT_PATTERNS = [
  /you('ve| have) been signed out/i,
  /sign in to continue/i,
  /session expired/i,
  /log in to continue/i,
];

const RECOVERABLE_PROMPT_PATTERNS = [
  /input gemini non trovato/i,
  /prompt gemini non inviato/i,
  /element was detached/i,
  /element is not stable/i,
  /locator\.click/i,
  /element is not visible/i,
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GeminiProvider {
  constructor(
    public readonly config: GeminiProviderConfig,
    private readonly geminiConfig: GeminiConfig,
  ) {}

  isQuotaExhausted(text: string): boolean {
    return QUOTA_PATTERNS.some((re) => re.test(text));
  }

  async goto(page: Page): Promise<void> {
    const baseOrigin = new URL(this.config.baseUrl).origin;
    if (!page.url().startsWith(baseOrigin)) {
      await page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded" });
    }
  }

  async ensureReady(page: Page): Promise<void> {
    await this.goto(page);
    await this.assertInteractive(page);
    const selector = await this.findFirstVisible(page, this.config.readySelectors, 30_000);
    if (!selector) {
      throw new GeminiNotReadyError(await this.describeNotReady(page));
    }
    await this.assertInteractive(page);
  }

  async isReady(page: Page): Promise<boolean> {
    if (await this.hasBlockingOverlay(page)) return false;
    const selector = await this.findFirstVisible(page, this.config.readySelectors, 1_500);
    return Boolean(selector);
  }

  async ensureConversationNotFull(page: Page, maxMessages = 40): Promise<void> {
    const count = await this.countMessages(page);
    if (count >= maxMessages) {
      await page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded" });
      await this.findFirstVisible(page, this.config.readySelectors, 15_000);
    }
  }

  async snapshotConversation(page: Page): Promise<ConversationSnapshot> {
    const mainText = await this.readMainText(page);
    const imageKeys = await this.listVisibleImageKeys(page);
    const imageNodeCount = await this.countImageNodes(page);

    // Count assistant nodes — this is the PRIMARY baseline signal.
    // readLastMessage will only return content when this count has grown.
    const assistantCount = await this.countAssistantNodes(page);

    if (assistantCount > 0) {
      const providerText = await this.readAssistantText(page);
      return {
        count: assistantCount,
        lastText: this.sanitize(providerText),
        mainText,
        imageKeys,
        imageNodeCount,
      };
    }

    for (const selector of this.config.messageSelectors) {
      const locator = page.locator(selector);
      const count = await locator.count();
      if (count === 0) continue;

      const lastText = this.sanitize(((await locator.last().innerText().catch(() => "")) || "").trim());
      return { count, lastText, mainText, imageKeys, imageNodeCount };
    }

    return { count: 0, lastText: "", mainText, imageKeys, imageNodeCount };
  }

  async sendPrompt(page: Page, prompt: string): Promise<void> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.sendPromptOnce(page, prompt);
        return;
      } catch (error) {
        lastError = error;
        await this.assertInteractive(page);
        if (!this.isRecoverablePromptError(error) || attempt === 2) {
          throw error;
        }
        await this.recoverPromptSurface(page, attempt);
      }
    }

    throw (lastError instanceof Error ? lastError : new Error(String(lastError ?? "Prompt Gemini non inviato.")));
  }

  /**
   * Submits the currently typed prompt using multiple strategies in order:
   * 1. Click the send button (re-resolved fresh — never use a potentially stale locator)
   * 2. Press Enter on the contenteditable rich-textarea (element-scoped, safe in parallel)
   * 3. Dispatch a real keyboard Enter event via JS on the focused element (last resort)
   */
  private async submitPrompt(page: Page): Promise<void> {
    // Strategy 1: click the send button (fresh locator, not the input that may be stale)
    if (this.config.submitSelector) {
      const submit = page.locator(this.config.submitSelector).first();
      if (await submit.isVisible({ timeout: 2_000 }).catch(() => false)) {
        try {
          await submit.click({ force: true, timeout: 5_000 });
          return;
        } catch {
          // fall through
        }
      }
    }

    // Strategy 2: Enter on the rich-textarea contenteditable (always fresh locator)
    const contentEditable = page.locator("rich-textarea div[contenteditable='true']").first();
    if (await contentEditable.isVisible({ timeout: 2_000 }).catch(() => false)) {
      try {
        await contentEditable.press("Enter", { timeout: 5_000 });
        return;
      } catch {
        // fall through
      }
    }

    // Strategy 3: dispatch Enter via JS on the contenteditable element (scoped, not relying on focus)
    await page.evaluate(() => {
      // Target the specific input element, not document.activeElement which could be wrong
      const el = document.querySelector("rich-textarea div[contenteditable='true']")
        ?? document.querySelector("[contenteditable='true']");
      if (!el) return;
      for (const type of ["keydown", "keypress", "keyup"] as const) {
        el.dispatchEvent(new KeyboardEvent(type, {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        }));
      }
    }).catch(() => undefined);
  }

  async *streamResponse(
    page: Page,
    baseline: ConversationSnapshot,
    overrides: { maxDurationMs?: number; firstChunkTimeoutMs?: number } = {},
  ): AsyncGenerator<string, GeminiResponse> {
    const maxDurationMs = overrides.maxDurationMs ?? this.geminiConfig.streamMaxDurationMs;
    const firstChunkTimeoutMs = overrides.firstChunkTimeoutMs ?? this.geminiConfig.streamFirstChunkTimeoutMs;
    const startedAt = Date.now();
    let previous = "";
    let stableTicks = 0;
    let firstUsefulSignalSeen = false;

    while (stableTicks < this.geminiConfig.streamStableTicks) {
      if (Date.now() - startedAt > maxDurationMs) {
        throw new GeminiTimeoutError("timeout massimo di risposta superato");
      }

      const current = this.extractNewText(
        baseline,
        await this.readLastMessage(page, baseline),
      );
      const hasImageSignal = await this.hasNewImages(page, baseline);

      if (current && current !== previous) {
        const delta = current.startsWith(previous) ? current.slice(previous.length) : "";
        previous = current;
        stableTicks = 0;
        if (delta) {
          firstUsefulSignalSeen = true;
          yield delta;
        }
      }

      if (hasImageSignal) firstUsefulSignalSeen = true;

      const busy = await this.isBusy(page);
      const imageStillLoading = hasImageSignal && !(await this.isImageLoaded(page));
      // Only count stable ticks once we have seen useful content.
      // Before that, only the first-chunk timeout (gated on !busy) applies.
      const canSettle = firstUsefulSignalSeen && !imageStillLoading;
      if (!current || current === previous) {
        if (!canSettle) {
          stableTicks = 0; // haven't started yet — never settle prematurely
        } else {
          stableTicks = busy || imageStillLoading ? 0 : stableTicks + 1;
        }
      }

      // Only fire the first-chunk timeout when Gemini is completely idle —
      // if it's still busy (generating image or text), keep waiting up to maxDurationMs.
      if (!firstUsefulSignalSeen && !busy && Date.now() - startedAt > firstChunkTimeoutMs) {
        throw new GeminiTimeoutError("nessuna risposta entro il timeout iniziale");
      }

      await sleep(this.geminiConfig.streamPollIntervalMs);
    }

    previous = this.extractNewText(
      baseline,
      await this.finalizeMessage(page, baseline, previous, startedAt),
    );
    const images = await this.captureImages(page, baseline);

    if (!previous.trim() && images.length === 0) {
      throw new Error("Gemini non ha prodotto testo utile.");
    }

    return { text: previous, images };
  }

  // ── Private helpers ───────────────────────────────────────

  private async readLastMessage(page: Page, baseline: ConversationSnapshot): Promise<string> {
    // ── Count-based guard: only return content when a NEW assistant node exists ──
    const currentCount = await this.countAssistantNodes(page);
    const providerText = this.sanitize(await this.readAssistantText(page), baseline.prompt);
    if (providerText && providerText !== baseline.lastText) {
      return providerText;
    }
    if (currentCount <= baseline.count) {
      return "";
    }

    if (providerText) return providerText;

    // Fallback: try messageSelectors (generic container approach)
    for (const selector of this.config.messageSelectors) {
      const locator = page.locator(selector);
      const count = await locator.count();
      if (count === 0 || count <= baseline.count) continue;

      // Read the last node (the new one)
      const node = locator.nth(count - 1);
      const text = this.sanitize((await node.innerText().catch(() => ""))?.trim() ?? "", baseline.prompt);
      if (text) return text;
    }

    return "";
  }

  private async readAssistantText(page: Page): Promise<string> {
    const jsText = await page.evaluate((): string => {
      type DomLike = { querySelectorAll: (s: string) => unknown[] };
      type NodeLike = {
        parentElement?: { closest?: (s: string) => unknown } | null;
        innerText?: string;
      };

      const doc = (globalThis as unknown as { document?: DomLike }).document;
      if (!doc) return "";

      const all = doc.querySelectorAll("message-content") as NodeLike[];
      const topLevel = all.filter((el) => el.parentElement?.closest?.("message-content") === null);
      if (topLevel.length === 0) return "";
      const last = topLevel[topLevel.length - 1];
      return last.innerText?.trim() ?? "";
    }).catch(() => "");

    if (jsText) return jsText;

    return this.readLastVisibleText(page, [
      "response-container message-content",
      ".model-response-text",
      "response-container",
    ]);
  }

  /**
   * Reads the last assistant response and converts its DOM structure to
   * Telegram HTML, preserving bold, italic, code, code blocks, and lists.
   * Falls back to plain innerText if DOM walk fails.
   */
  async readFormattedAssistantText(page: Page): Promise<string> {
    const html = await page.evaluate((): string => {
      type DomLike = { querySelectorAll: (s: string) => unknown[] };

      const doc = (globalThis as unknown as { document?: DomLike }).document;
      if (!doc) return "";

      const all = doc.querySelectorAll("message-content") as HTMLElement[];
      const topLevel = Array.from(all).filter(
        (el) => el.parentElement?.closest?.("message-content") === null,
      );
      if (topLevel.length === 0) return "";
      const root = topLevel[topLevel.length - 1];

      // ── DOM walker: converts Gemini's rendered HTML to Telegram HTML ──
      function walk(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE) {
          return escapeH(node.textContent ?? "");
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return "";
        const el = node as HTMLElement;
        const tag = el.tagName.toLowerCase();

        // Skip hidden elements
        if (el.offsetParent === null && tag !== "body" && tag !== "html" && !["code", "span"].includes(tag)) {
          // Exception: code inside pre is technically hidden but we want it
          if (!(tag === "code" && el.parentElement?.tagName.toLowerCase() === "pre")) {
            return "";
          }
        }

        const children = () => Array.from(el.childNodes).map(walk).join("");

        switch (tag) {
          case "b":
          case "strong":
            return `<b>${children()}</b>`;
          case "i":
          case "em":
            return `<i>${children()}</i>`;
          case "u":
            return `<u>${children()}</u>`;
          case "s":
          case "del":
          case "strike":
            return `<s>${children()}</s>`;
          case "code": {
            // If inside <pre>, preserve as code block
            const parent = el.parentElement;
            if (parent && parent.tagName.toLowerCase() === "pre") {
              // Get language from class if available
              const langClass = el.className.match(/language-(\w+)/);
              const langAttr = langClass ? ` class="language-${escapeH(langClass[1])}"` : "";
              return `<code${langAttr}>${escapeH(el.textContent ?? "")}</code>`;
            }
            return `<code>${escapeH(el.textContent ?? "")}</code>`;
          }
          case "pre":
            return `<pre>${children()}</pre>\n`;
          case "a": {
            const href = el.getAttribute("href");
            if (href) return `<a href="${escapeH(href)}">${children()}</a>`;
            return children();
          }
          case "br":
            return "\n";
          case "p":
            return children() + "\n\n";
          case "div":
            return children() + "\n";
          case "h1":
          case "h2":
          case "h3":
          case "h4":
          case "h5":
          case "h6":
            return `<b>${children()}</b>\n\n`;
          case "li": {
            const parentTag = el.parentElement?.tagName.toLowerCase();
            if (parentTag === "ol") {
              // Numbered list — find index
              const siblings = Array.from(el.parentElement!.children);
              const idx = siblings.indexOf(el) + 1;
              return `${idx}. ${children().trim()}\n`;
            }
            return `▸ ${children().trim()}\n`;
          }
          case "ul":
          case "ol":
            return "\n" + children() + "\n";
          case "blockquote":
            return children().trim().split("\n").map((l: string) => `» ${l}`).join("\n") + "\n\n";
          case "table":
            return formatTable(el) + "\n\n";
          case "img":
            return ""; // skip images (handled separately)
          case "hr":
            return "───────────────\n";
          default:
            return children();
        }
      }

      function escapeH(text: string): string {
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }

      function formatTable(table: HTMLElement): string {
        const rows: string[][] = [];
        table.querySelectorAll("tr").forEach((tr) => {
          const cells: string[] = [];
          tr.querySelectorAll("th, td").forEach((cell) => {
            cells.push((cell.textContent ?? "").trim());
          });
          rows.push(cells);
        });
        if (rows.length === 0) return "";

        // Calculate column widths
        const colWidths = rows[0].map((_, ci) =>
          Math.max(...rows.map((r) => (r[ci] ?? "").length)),
        );

        return `<pre>${rows
          .map((row) =>
            row.map((cell, ci) => cell.padEnd(colWidths[ci] ?? 0)).join(" │ "),
          )
          .join("\n")}</pre>`;
      }

      const result = walk(root);

      // Clean up excessive whitespace
      return result
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }).catch(() => "");

    if (html) return html;

    // Fallback to plain innerText
    return this.readAssistantText(page);
  }

  private async countMessages(page: Page): Promise<number> {
    for (const selector of this.config.messageSelectors) {
      const count = await page.locator(selector).count();
      if (count > 0) return count;
    }
    return 0;
  }

  private async countAssistantNodes(page: Page): Promise<number> {
    const count = await page.evaluate((): number => {
      type DomLike = { querySelectorAll: (s: string) => unknown[] };
      type NodeLike = { parentElement?: { closest?: (s: string) => unknown } | null };

      const doc = (globalThis as unknown as { document?: DomLike }).document;
      if (!doc) return 0;

      const all = doc.querySelectorAll("message-content") as NodeLike[];
      return all.filter((el) => el.parentElement?.closest?.("message-content") === null).length;
    }).catch(() => 0);

    if (count > 0) return count;
    return page.locator("response-container").count().catch(() => 0);
  }

  private async readMainText(page: Page): Promise<string> {
    const main = page.locator("main").first();
    const text = (await main.innerText().catch(async () => page.locator("body").innerText().catch(() => ""))) || "";
    return text.trim();
  }

  private async isBusy(page: Page): Promise<boolean> {
    for (const selector of this.config.busySelectors) {
      if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
    }
    return false;
  }

  private async waitUntilIdle(page: Page, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.isBusy(page))) return;
      await sleep(60);
    }
    throw new Error("Gemini occupato; impossibile inviare il prompt.");
  }

  /**
   * Waits until the input element is present AND stable — i.e. the same DOM
   * element is returned on two consecutive checks ~500ms apart.
   * This protects against Angular's hydration cycle replacing the element
   * mid-operation (which causes "element was detached" errors).
   */
  private async waitForStableInput(page: Page, timeoutMs: number): Promise<import("playwright").Locator | null> {
    const selectors = [this.config.inputSelector, ...this.config.readySelectors];
    const deadline = Date.now() + timeoutMs;
    const stabilityDelayMs = 18;

    let prevHandle: import("playwright").JSHandle | null = null;

    while (Date.now() < deadline) {
      const selector = await this.findFirstVisible(page, selectors, 1_000);
      if (!selector) { await sleep(stabilityDelayMs); continue; }

      const locator = page.locator(selector).first();
      // Get the underlying JS object handle to compare identity
      const handle = await locator.evaluateHandle((el: Element) => el).catch(() => null);
      if (!handle) { await sleep(stabilityDelayMs); continue; }

      if (prevHandle !== null) {
        // Compare DOM node identity: same element = stable
        const isSame = await page.evaluate(
          ([a, b]: [unknown, unknown]) => a === b,
          [prevHandle, handle] as [unknown, unknown],
        ).catch(() => false);

        // Dispose BOTH handles to prevent leaks
        await handle.dispose().catch(() => undefined);
        await prevHandle.dispose().catch(() => undefined);
        prevHandle = null;

        if (isSame) return locator; // stable — same element twice in a row
        // element changed — reset and wait again
        await sleep(stabilityDelayMs);
        continue;
      }

      prevHandle = handle;
      await sleep(stabilityDelayMs);
    }

    // Dispose any remaining handle on timeout
    if (prevHandle) await prevHandle.dispose().catch(() => undefined);

    return null;
  }

  private async findFirstVisible(page: Page, selectors: string[], timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        const visible = await page.locator(selector).first().isVisible().catch(() => false);
        if (visible) return selector;
      }
      await sleep(20);
    }
    return null;
  }

  private async firstVisibleLocator(page: Page, selectors: string[], timeoutMs: number): Promise<Locator | null> {
    const selector = await this.findFirstVisible(page, selectors, timeoutMs);
    return selector ? page.locator(selector).first() : null;
  }

  private async ensurePromptSubmitted(
    page: Page,
    prompt: string,
    baselineAssistantCount: number,
  ): Promise<void> {
    const normalizedPrompt = prompt.trim();

    const looksSubmitted = async (): Promise<boolean> => {
      if (await this.isBusy(page)) return true;
      const assistantCount = await this.countAssistantNodes(page).catch(() => baselineAssistantCount);
      if (assistantCount > baselineAssistantCount) return true;

      const freshInput = await this.firstVisibleLocator(
        page,
        [this.config.inputSelector, "rich-textarea div[contenteditable='true']"],
        400,
      );
      if (!freshInput) {
        return await this.isBusy(page);
      }
      const current = await freshInput
        .evaluate((el: Element) => {
          const f = el as { value?: string; textContent?: string | null; innerText?: string };
          return (f.value || f.innerText || f.textContent || "").trim();
        })
        .catch(() => "");
      return !current || !current.includes(normalizedPrompt);
    };

    for (let attempt = 0; attempt < 4; attempt++) {
      if (await looksSubmitted()) return;
      await sleep(8);
      if (await looksSubmitted()) return;

      const freshInput = await this.firstVisibleLocator(
        page,
        [this.config.inputSelector, "rich-textarea div[contenteditable='true']"],
        500,
      );
      if (!freshInput) return;

      const keys = attempt === 0
        ? ["Enter"]
        : ["Control+Enter", "Meta+Enter", "Enter"];

      for (const key of keys) {
        await freshInput.press(key).catch(() => undefined);
        await sleep(10);
        if (await looksSubmitted()) return;
      }

      await this.submitPrompt(page);
    }

    throw new Error("Prompt Gemini non inviato correttamente.");
  }

  private async sendPromptOnce(page: Page, prompt: string): Promise<void> {
    await this.ensureReady(page);
    if (await this.isBusy(page).catch(() => false)) {
      await this.waitUntilIdle(page, 800);
    }

    const input = await this.waitForStableInput(page, 1_500);
    if (!input) throw new Error("Input Gemini non trovato.");

    await input.scrollIntoViewIfNeeded().catch(() => undefined);
    await input.evaluate((el: Element) => (el as HTMLElement).focus?.()).catch(() => undefined);

    const tagName = await input.evaluate((el: Element) => el.tagName.toLowerCase());
    if (tagName === "textarea" || tagName === "input") {
      await input.fill(prompt);
    } else {
      const insertedDirectly = await input.evaluate((el: Element, value: string) => {
        const target = el as HTMLElement;
        if (!target) return false;
        target.focus();

        const setContent = (): void => {
          target.textContent = "";
          const lines = String(value).split("\n");
          lines.forEach((line, index) => {
            if (index > 0) target.appendChild(document.createElement("br"));
            target.appendChild(document.createTextNode(line));
          });
        };

        try {
          setContent();
          target.dispatchEvent(new InputEvent("beforeinput", {
            inputType: "insertText",
            data: value,
            bubbles: true,
            cancelable: true,
          }));
          target.dispatchEvent(new InputEvent("input", {
            inputType: "insertText",
            data: value,
            bubbles: true,
          }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        } catch {
          return false;
        }
      }, prompt).catch(() => false);

      if (!insertedDirectly) {
        await input.evaluate((el: Element) => {
          (el as { focus?: () => void; textContent: string | null }).focus?.();
          el.textContent = "";
        });
        const lines = prompt.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (i > 0) await input.press("Shift+Enter");
          if (lines[i]) await input.pressSequentially(lines[i], { delay: 0 });
        }
      }
    }

    await input.evaluate((el: Element) => (el as HTMLElement).focus?.()).catch(() => undefined);

    const baselineAssistantCount = await this.countAssistantNodes(page).catch(() => 0);
    await this.submitPrompt(page);
    await this.ensurePromptSubmitted(page, prompt, baselineAssistantCount);
  }

  private isRecoverablePromptError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return RECOVERABLE_PROMPT_PATTERNS.some((pattern) => pattern.test(message));
  }

  private async recoverPromptSurface(page: Page, attempt: number): Promise<void> {
    if (attempt === 0) {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(async () => {
        await page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      });
    } else {
      await page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }
    await sleep(250);
    await this.assertInteractive(page);
  }

  private async describeNotReady(page: Page): Promise<string> {
    const blockingText = await this.readBlockingOverlayText(page);
    if (blockingText) {
      if (SIGNED_OUT_PATTERNS.some((pattern) => pattern.test(blockingText))) {
        return "Sessione Gemini scaduta o login richiesto. Accedi di nuovo da VNC.";
      }
      return `Interfaccia Gemini bloccata: ${blockingText.slice(0, 180)}`;
    }

    const mainText = await this.readMainText(page).catch(() => "");
    if (this.isQuotaExhausted(mainText)) {
      return "Quota o rate limit Gemini rilevati.";
    }
    return "Controlla login, overlay e stato della sessione browser.";
  }

  private async assertInteractive(page: Page): Promise<void> {
    const blockingText = await this.readBlockingOverlayText(page);
    if (blockingText) {
      if (SIGNED_OUT_PATTERNS.some((pattern) => pattern.test(blockingText))) {
        throw new GeminiNotReadyError("Sessione Gemini scaduta o login richiesto. Accedi di nuovo da VNC.");
      }
      if (this.isQuotaExhausted(blockingText)) {
        throw new GeminiQuotaError(blockingText.slice(0, 500));
      }
    }

    const mainText = await this.readMainText(page).catch(() => "");
    if (this.isQuotaExhausted(mainText)) {
      throw new GeminiQuotaError(mainText.slice(0, 500));
    }
  }

  private async hasBlockingOverlay(page: Page): Promise<boolean> {
    return Boolean(await this.readBlockingOverlayText(page));
  }

  private async readBlockingOverlayText(page: Page): Promise<string> {
    const selectors = [
      '[role="dialog"]',
      'mat-dialog-container',
      '.mat-mdc-dialog-container',
      '.cdk-overlay-container [role="dialog"]',
      '.cdk-overlay-container',
    ];

    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index--) {
        const node = locator.nth(index);
        const visible = await node.isVisible().catch(() => false);
        if (!visible) continue;
        const text = ((await node.innerText().catch(() => "")) || "").trim();
        if (!text) continue;
        if (SIGNED_OUT_PATTERNS.some((pattern) => pattern.test(text)) || this.isQuotaExhausted(text)) {
          return text;
        }
      }
    }

    return "";
  }

  private async readLastVisibleText(page: Page, selectors: string[]): Promise<string> {
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;

      for (let i = count - 1; i >= 0; i--) {
        const node = locator.nth(i);
        const visible = await node.isVisible().catch(() => false);
        if (!visible) continue;
        const text = ((await node.innerText().catch(() => "")) || "").trim();
        if (text) return text;
      }
    }
    return "";
  }

  private async countImageNodes(page: Page): Promise<number> {
    let total = 0;
    for (const selector of ["generated-image", "single-image", ".generated-images"]) {
      total += await page.locator(selector).count().catch(() => 0);
    }
    return total;
  }

  private async hasNewImages(page: Page, baseline: ConversationSnapshot): Promise<boolean> {
    // Only signal new images if the count of image elements has grown since baseline
    const current = await this.countImageNodes(page);
    if (current <= baseline.imageNodeCount) return false;

    // Also confirm the new element is actually visible and reasonably sized
    for (const selector of ["generated-image", "single-image", ".generated-images"]) {
      const el = page.locator(selector).last();
      if (await el.isVisible().catch(() => false)) {
        const box = await el.boundingBox().catch(() => null);
        if (box && box.width >= 100 && box.height >= 100) return true;
      }
    }
    return false;
  }

  /** Returns true when at least one generated image is fully decoded in the page. */
  private async isImageLoaded(page: Page): Promise<boolean> {
    return page.evaluate((): boolean => {
      const containers = [
        ...Array.from(document.querySelectorAll("generated-image")),
        ...Array.from(document.querySelectorAll("single-image")),
        ...Array.from(document.querySelectorAll(".generated-images")),
      ];

      for (const container of containers) {
        // Light DOM
        const lightImg = container.querySelector("img") as HTMLImageElement | null;
        if (lightImg && lightImg.complete && lightImg.naturalWidth > 0) return true;

        // Shadow DOM
        const shadow = (container as unknown as { shadowRoot?: ShadowRoot }).shadowRoot;
        if (shadow) {
          const shadowImg = shadow.querySelector("img") as HTMLImageElement | null;
          if (shadowImg && shadowImg.complete && shadowImg.naturalWidth > 0) return true;
        }
      }

      // Broad fallback: any img nested in image custom elements
      const allImgs = Array.from(document.querySelectorAll("generated-image img, single-image img")) as HTMLImageElement[];
      return allImgs.some((img) => img.complete && img.naturalWidth > 0);
    }).catch(() => false);
  }

  /** Polls until at least one generated image is fully loaded or timeout expires. */
  async waitForImageReady(page: Page, timeoutMs = 45_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isImageLoaded(page)) return true;
      await sleep(500);
    }
    return false;
  }

  /**
   * Capture generated images by downloading the actual image file via Gemini's
   * download button. Waits until the image is fully loaded before attempting.
   * Never falls back to screenshotting.
   */
  private async captureImages(page: Page, baseline: ConversationSnapshot): Promise<GeneratedImage[]> {
    const hasImage = await this.hasNewImages(page, baseline);
    if (!hasImage) return [];

    // Wait for image to be fully decoded before clicking download
    await this.waitForImageReady(page, 45_000);

    const buf = await this.downloadLastImage(page);
    if (buf) {
      return [{ src: `data:image/jpeg;base64,${buf.toString("base64")}` }];
    }

    return [];
  }

  private async listVisibleImageKeys(page: Page): Promise<string[]> {
    const keys = new Set<string>();
    for (const selector of ["generated-image img[src]", "single-image img[src]", ".generated-images img[src]", ".attachment-container img[src]"]) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const node = locator.nth(i);
        if (!(await node.isVisible().catch(() => false))) continue;
        const box = await node.boundingBox().catch(() => null);
        if (!box || box.width < 100 || box.height < 100) continue;
        const src = await node.evaluate((el: Element) => (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || "").catch(() => "");
        if (src) keys.add(src);
      }
    }
    return Array.from(keys);
  }

  private async finalizeMessage(
    page: Page,
    baseline: ConversationSnapshot,
    current: string,
    startedAt: number,
  ): Promise<string> {
    let latest = current;
    let stableReads = 0;
    const settleDeadline = Math.min(
      startedAt + this.geminiConfig.streamMaxDurationMs,
      Date.now() + Math.max(this.geminiConfig.streamPollIntervalMs * 4, 2_500),
    );

    while (Date.now() < settleDeadline) {
      const next = await this.readLastMessage(page, baseline);
      if (next && next !== latest) {
        latest = next;
        stableReads = 0;
      } else {
        stableReads += 1;
      }
      const busy = await this.isBusy(page);
      if (!busy && stableReads >= 2) break;
      await sleep(Math.min(this.geminiConfig.streamPollIntervalMs, 700));
    }
    return latest;
  }

  /**
   * Sends the system prompt to Gemini and discards its response.
   * Call this once per fresh conversation to establish the bot's identity.
   */
  async injectSystemPrompt(page: Page, systemPrompt: string): Promise<void> {
    await this.ensureReady(page);
    const baseline = await this.snapshotConversation(page);
    await this.sendPrompt(page, systemPrompt);
    // Drain the generator and discard every chunk
    try {
      const gen = this.streamResponse(page, baseline);
      let n = await gen.next();
      while (!n.done) n = await gen.next();
    } catch {
      // Ignore — we only care that Gemini received the prompt, not what it replied
    }
  }

  /**
   * Hovers over the last generated image, clicks Gemini's download button and
   * intercepts the resulting Playwright download event to obtain the raw bytes.
   * Returns null if no image download can be triggered.
   */
  async downloadLastImage(page: Page): Promise<Buffer | null> {
    // Ensure the image is fully decoded before trying to click the download button
    await this.waitForImageReady(page, 45_000);

    for (const containerSel of ["generated-image", "single-image", ".generated-images"]) {
      const container = page.locator(containerSel).last();
      if (!(await container.isVisible().catch(() => false))) continue;

      // Hover to reveal the action bar buttons
      await container.hover({ force: true }).catch(() => undefined);
      await sleep(700);

      // Strategy 1: direct download icon visible in the action bar
      const directBtn = page
        .locator(".button-icon-wrapper")
        .filter({ has: page.locator('mat-icon[fonticon="download"]') })
        .last();

      if (await directBtn.isVisible().catch(() => false)) {
        const buf = await this.triggerDownload(page, directBtn);
        if (buf) return buf;
      }

      // Strategy 2: open the "⋮" menu → "Download image" menu item
      const moreBtn = page
        .locator('button[aria-label*="More"], button[aria-label*="options"], mat-icon[fonticon="more_vert"]')
        .last();

      if (await moreBtn.isVisible().catch(() => false)) {
        await moreBtn.click({ force: true }).catch(() => undefined);
        await sleep(400);

        const menuItem = page.locator('[data-test-id="image-download-button"]').first();
        if (await menuItem.isVisible().catch(() => false)) {
          const buf = await this.triggerDownload(page, menuItem);
          if (buf) return buf;
        }

        await page.keyboard.press("Escape").catch(() => undefined);
        await sleep(200);
      }
    }

    return null;
  }

  /**
   * Clicks the "⋮" menu on the last response, selects "Listen", and
   * captures the TTS audio using multiple strategies:
   *
   * 1. AudioContext.decodeAudioData hook — Gemini feeds TTS data through
   *    Web Audio API; we intercept the raw ArrayBuffer before decoding.
   * 2. page.on("response") — catches direct audio HTTP responses.
   * 3. DOM <audio> element polling — catches blob: or src-based players.
   */
  async downloadLastResponseAudio(page: Page): Promise<Buffer | null> {
    let audioBuffer: Buffer | null = null;
    let gotAudio = false;

    // ── Strategy 1: Hook AudioContext.decodeAudioData ──
    // Gemini's TTS likely fetches audio bytes via batchexecute RPC, then feeds
    // the ArrayBuffer to AudioContext.decodeAudioData. We monkey-patch it to
    // stash the raw bytes in window.__tegemCapturedAudio.
    await page.evaluate(() => {
      const w = window as unknown as {
        __tegemCapturedAudio?: string;
        AudioContext: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const AC = w.AudioContext || w.webkitAudioContext;
      if (!AC) return;

      const origDecode = AC.prototype.decodeAudioData;
      AC.prototype.decodeAudioData = function (
        this: AudioContext,
        buf: ArrayBuffer,
        ...rest: unknown[]
      ): Promise<AudioBuffer> {
        // Only capture the first call (the TTS audio)
        if (!w.__tegemCapturedAudio && buf.byteLength > 1000) {
          const bytes = new Uint8Array(buf.slice(0)); // clone before decode consumes it
          let binary = "";
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          w.__tegemCapturedAudio = btoa(binary);
        }
        return origDecode.apply(this, [buf, ...rest] as unknown as [ArrayBuffer, DecodeSuccessCallback?, DecodeErrorCallback?]);
      };
    }).catch(() => undefined);

    // ── Strategy 2: Network response listener ──
    const responseHandler = async (response: import("playwright").Response): Promise<void> => {
      if (gotAudio) return;
      try {
        const ct = response.headers()["content-type"] ?? "";
        if (ct.startsWith("audio/") || ct.includes("mpeg") || ct.includes("ogg") || ct.includes("wav")) {
          const body = await response.body();
          if (body.length > 1000) {
            gotAudio = true;
            audioBuffer = Buffer.from(body);
          }
        }
      } catch {
        // Response body may not be available
      }
    };

    page.on("response", responseHandler);

    try {
      // ── Open menu and click Listen ──
      const lastResponse = page.locator("response-container").last();
      await lastResponse.hover({ force: true }).catch(() => undefined);
      await sleep(400);

      // Find ⋮ button: try scoped to response, then page-wide
      let moreBtn = lastResponse
        .locator('button:has(mat-icon[fonticon="more_vert"])')
        .first();
      if (!(await moreBtn.isVisible({ timeout: 2_000 }).catch(() => false))) {
        moreBtn = page.locator('button:has(mat-icon[fonticon="more_vert"])').last();
      }
      if (!(await moreBtn.isVisible({ timeout: 2_000 }).catch(() => false))) {
        return null;
      }

      await moreBtn.click({ force: true });
      await sleep(600);

      // Find Listen button
      const listenBtn =
        (await page.locator('button[aria-labelledby="tts-label"]').first().isVisible({ timeout: 2_000 }).catch(() => false))
          ? page.locator('button[aria-labelledby="tts-label"]').first()
          : (await page.locator('button:has(mat-icon[fonticon="volume_up"])').first().isVisible({ timeout: 2_000 }).catch(() => false))
            ? page.locator('button:has(mat-icon[fonticon="volume_up"])').first()
            : (await page.locator('button.mat-mdc-menu-item').filter({ hasText: /listen/i }).first().isVisible({ timeout: 1_000 }).catch(() => false))
              ? page.locator('button.mat-mdc-menu-item').filter({ hasText: /listen/i }).first()
              : null;

      if (!listenBtn) {
        await page.keyboard.press("Escape").catch(() => undefined);
        return null;
      }

      await listenBtn.click({ force: true });

      // ── Wait for audio from any strategy ──
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !gotAudio) {
        // Check Strategy 1: AudioContext hook
        const captured = await page.evaluate(() => {
          const w = window as unknown as { __tegemCapturedAudio?: string };
          const data = w.__tegemCapturedAudio;
          if (data) {
            delete w.__tegemCapturedAudio; // consume it
            return data;
          }
          return null;
        }).catch(() => null);

        if (captured) {
          gotAudio = true;
          audioBuffer = Buffer.from(captured, "base64");
          break;
        }

        // Check Strategy 3: DOM <audio> elements
        const audioSrc = await page.evaluate(() => {
          const audios = Array.from(document.querySelectorAll("audio"));
          for (const a of audios) {
            if (a.src && !a.paused && a.readyState >= 2) return a.src;
            if (a.currentSrc && !a.paused && a.readyState >= 2) return a.currentSrc;
          }
          return null;
        }).catch(() => null);

        if (audioSrc && !gotAudio) {
          // Try to fetch the audio data from the page context
          const fetched = await page.evaluate(async (src: string) => {
            try {
              const res = await fetch(src);
              const blob = await res.blob();
              const buf = await blob.arrayBuffer();
              const bytes = new Uint8Array(buf);
              let binary = "";
              for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
              return btoa(binary);
            } catch { return null; }
          }, audioSrc).catch(() => null);

          if (fetched) {
            gotAudio = true;
            audioBuffer = Buffer.from(fetched, "base64");
            break;
          }
        }

        await sleep(800);
      }

      // Cleanup: restore original decodeAudioData
      await page.evaluate(() => {
        const w = window as unknown as { __tegemCapturedAudio?: string };
        delete w.__tegemCapturedAudio;
      }).catch(() => undefined);

      return audioBuffer;
    } finally {
      page.off("response", responseHandler);
    }
  }

  /**
   * Uploads a file to Gemini's input area using the "+" attachment button.
   * Gemini accepts images, audio, video, PDFs, etc.
   */
  async uploadFile(page: Page, filePath: string): Promise<void> {
    await this.ensureReady(page);

    const attachedDirectly = await this.trySetInputFiles(page, filePath);
    if (!attachedDirectly) {
      const attachmentButtons = await this.findAttachmentButtons(page);

      let attached = false;

      for (const button of attachmentButtons) {
        await button.click({ force: true }).catch(() => undefined);
        await sleep(500);

        if (await this.trySetInputFiles(page, filePath)) {
          attached = true;
          break;
        }

        const uploadTargets = [
          page.locator('[data-test-id="local-images-files-uploader-button"]').first(),
          page.locator('button[data-test-id="local-images-files-uploader-button"]').first(),
          page.locator('button[aria-label*="Upload files"]').first(),
          page.locator('button[role="menuitem"]').filter({
            has: page.locator('[data-test-id="local-images-files-uploader-icon"]'),
          }).first(),
          page.locator('button.mat-mdc-menu-item, button[mat-menu-item]').filter({
            hasText: /^upload files$/i,
          }).first(),
          page.locator('button.mat-mdc-menu-item, button[mat-menu-item]').filter({
            hasText: /upload files|upload|file|files|computer|device/i,
          }).first(),
          page.locator('div[role="menuitem"], button[role="menuitem"]').filter({
            hasText: /upload files|upload|file|files|computer|device/i,
          }).first(),
        ];

        for (const target of uploadTargets) {
          if (!(await target.isVisible({ timeout: 1_500 }).catch(() => false))) continue;
          if (await this.tryChooseFiles(page, target, filePath)) {
            attached = true;
            break;
          }
          if (await this.trySetInputFiles(page, filePath)) {
            attached = true;
            break;
          }
        }

        if (attached) break;

        await page.keyboard.press("Escape").catch(() => undefined);
        await sleep(200);
      }

      if (!attached) {
        throw new Error("Upload file Gemini non disponibile: input file non trovato.");
      }
    }

    await this.waitForAttachmentPreview(page);
  }

  async downloadGeneratedMusic(page: Page, timeoutMs = 120_000): Promise<GeneratedMusicDownloads> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const video = await this.downloadLastResponseMenuMedia(page, {
        icons: ["movie", "videocam", "play_circle"],
        labels: ["Video", "Download video"],
        filenameFallback: "generated_music_video.mp4",
      });
      const audio = await this.downloadLastResponseMenuMedia(page, {
        icons: ["music_note", "audio_file", "graphic_eq"],
        labels: ["Audio only", "Audio", "Download audio"],
        filenameFallback: "generated_music_audio.mp3",
      });

      if (video || audio) return { video, audio };

      await this.activateLastResponsePlayButton(page);
      const inlineMedia = await this.downloadGeneratedMedia(page, 4_000);
      if (inlineMedia) {
        return {
          video: inlineMedia.mimeType.startsWith("video/") ? inlineMedia : null,
          audio: inlineMedia.mimeType.startsWith("audio/") ? inlineMedia : null,
        };
      }

      await sleep(2_000);
    }

    return { video: null, audio: null };
  }

  /**
   * Waits for a generated media element (audio/video) to appear in the last
   * response, then intercepts the download or extracts the blob URL.
   * Works for Gemini's music and video generation features.
   */
  async downloadGeneratedMedia(page: Page, timeoutMs = 120_000): Promise<GeneratedMedia | null> {
    const deadline = Date.now() + timeoutMs;
    let playActivated = false;

    // Poll for audio/video elements in the last response
    while (Date.now() < deadline) {
      const menuVideo = await this.downloadLastResponseMenuMedia(page, {
        icons: ["movie", "videocam", "play_circle"],
        labels: ["Video", "Download video"],
        filenameFallback: "generated_video.mp4",
      });
      if (menuVideo) return menuVideo;

      // Check for <audio> or <video> elements with a src
      const media = await page.evaluate((): { src: string; type: string } | null => {
        const responses = document.querySelectorAll("response-container, message-content");
        if (responses.length === 0) return null;
        const last = responses[responses.length - 1];

        // Check for <audio> elements
        const audio = last.querySelector("audio") as HTMLAudioElement | null;
        if (audio?.src) return { src: audio.src, type: "audio" };
        const audioSource = last.querySelector("audio source") as HTMLSourceElement | null;
        if (audioSource?.src) return { src: audioSource.src, type: "audio" };

        // Check for <video> elements
        const video = last.querySelector("video") as HTMLVideoElement | null;
        if (video?.src) return { src: video.src, type: "video" };
        const videoSource = last.querySelector("video source") as HTMLSourceElement | null;
        if (videoSource?.src) return { src: videoSource.src, type: "video" };

        return null;
      }).catch(() => null);

      if (media?.src) {
        // Fetch the media blob via page.evaluate to handle blob: URLs
        const result = await page.evaluate(async (src: string): Promise<{ data: string; mime: string } | null> => {
          try {
            const res = await fetch(src);
            const blob = await res.blob();
            const arrayBuf = await blob.arrayBuffer();
            const bytes = new Uint8Array(arrayBuf);
            let binary = "";
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return { data: btoa(binary), mime: blob.type || "application/octet-stream" };
          } catch {
            return null;
          }
        }, media.src).catch(() => null);

        if (result) {
          const ext = media.type === "audio" ? "mp3" : "mp4";
          return {
            buffer: Buffer.from(result.data, "base64"),
            mimeType: result.mime,
            filename: `generated.${ext}`,
          };
        }
      }

      if (!playActivated) {
        playActivated = await this.activateLastResponsePlayButton(page);
        if (playActivated) {
          await sleep(1_000);
          continue;
        }
      }

      // Also try download button approach — some media has a download action
      const dlBtn = page.locator("response-container").last()
        .locator('button:has(mat-icon[fonticon="download"])').first();
      if (await dlBtn.isVisible().catch(() => false)) {
        const buf = await this.triggerDownload(page, dlBtn);
        if (buf) {
          // Infer type from context
          return { buffer: buf, mimeType: "application/octet-stream", filename: "generated_media" };
        }
      }

      await sleep(2_000);
    }

    return null;
  }

  private async downloadLastResponseMenuMedia(
    page: Page,
    option: { icons: string[]; labels: string[]; filenameFallback: string },
  ): Promise<GeneratedMedia | null> {
    const lastResponse = page.locator("response-container").last();
    if (!(await lastResponse.isVisible().catch(() => false))) return null;

    await lastResponse.scrollIntoViewIfNeeded().catch(() => undefined);
    await lastResponse.hover({ force: true }).catch(() => undefined);
    await sleep(250);

    const downloadBtn = await this.findLastResponseDownloadButton(page, lastResponse);
    if (downloadBtn) {
      const directDownload = await this.triggerMenuDownloadFlow(page, downloadBtn, option);
      if (directDownload) return directDownload;
    }

    const moreBtn = await this.findLastResponseOverflowButton(page, lastResponse);
    if (!moreBtn) return null;

    return this.triggerMenuDownloadFlow(page, moreBtn, option, true);
  }

  private async triggerMenuDownloadFlow(
    page: Page,
    opener: Locator,
    option: { icons: string[]; labels: string[]; filenameFallback: string },
    viaOverflowMenu = false,
  ): Promise<GeneratedMedia | null> {
    await opener.click({ force: true }).catch(() => undefined);
    await sleep(350);

    let optionButton = this.findMenuOption(page, option.icons, option.labels);
    if (await optionButton.isVisible({ timeout: 1_500 }).catch(() => false)) {
      const direct = await this.triggerDownloadWithMeta(page, optionButton, option.filenameFallback);
      await this.closeMenus(page);
      return direct;
    }

    if (viaOverflowMenu) {
      const downloadMenuEntry = this.findDownloadMenuOption(page);
      if (await downloadMenuEntry.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await downloadMenuEntry.click({ force: true }).catch(() => undefined);
        await sleep(350);
        optionButton = this.findMenuOption(page, option.icons, option.labels);
        if (await optionButton.isVisible({ timeout: 1_500 }).catch(() => false)) {
          const nested = await this.triggerDownloadWithMeta(page, optionButton, option.filenameFallback);
          await this.closeMenus(page);
          return nested;
        }
      }
    }

    await this.closeMenus(page);
    return null;
  }

  private async findLastResponseDownloadButton(page: Page, lastResponse: Locator): Promise<Locator | null> {
    const candidates = [
      lastResponse.locator('button:has(mat-icon[fonticon="download"])').first(),
      lastResponse.locator('.button-icon-wrapper:has(mat-icon[fonticon="download"])').first(),
      page.locator('button:has(mat-icon[fonticon="download"])').last(),
      page.locator('.button-icon-wrapper:has(mat-icon[fonticon="download"])').last(),
    ];

    for (const candidate of candidates) {
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }

    return null;
  }

  private async findLastResponseOverflowButton(page: Page, lastResponse: Locator): Promise<Locator | null> {
    const candidates = [
      lastResponse.locator('button:has(mat-icon[fonticon="more_vert"])').first(),
      lastResponse.locator('button[aria-label*="More"]').first(),
      lastResponse.locator('button[aria-label*="options"]').first(),
      page.locator('button:has(mat-icon[fonticon="more_vert"])').last(),
      page.locator('button[aria-label*="More"]').last(),
    ];

    for (const candidate of candidates) {
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }

    return null;
  }

  private findMenuOption(page: Page, icons: string[], labels: string[]): Locator {
    const menuItems = page.locator("button.mat-mdc-menu-item, button[mat-menu-item], [role='menuitem']");
    const labelPattern = new RegExp(labels.map((label) => this.escapeRegex(label)).join("|"), "i");

    const textMatch = menuItems.filter({ hasText: labelPattern }).first();
    const iconSelectors = icons.map((icon) => `mat-icon[fonticon="${icon}"]`).join(", ");
    if (iconSelectors) {
      const iconMatch = menuItems.filter({ has: page.locator(iconSelectors) }).filter({ hasText: labelPattern }).first();
      return iconMatch.or(textMatch).first();
    }

    return textMatch;
  }

  private findDownloadMenuOption(page: Page): Locator {
    const menuItems = page.locator("button.mat-mdc-menu-item, button[mat-menu-item], [role='menuitem']");
    const textMatch = menuItems.filter({ hasText: /download/i }).first();
    const iconMatch = menuItems.filter({
      has: page.locator('mat-icon[fonticon="download"], mat-icon[fonticon="file_download"]'),
    }).first();
    return iconMatch.or(textMatch).first();
  }

  private async closeMenus(page: Page): Promise<void> {
    await page.keyboard.press("Escape").catch(() => undefined);
    await sleep(80);
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  async hasGeneratedPlayableMedia(page: Page): Promise<boolean> {
    return page.evaluate((): boolean => {
      const responses = document.querySelectorAll("response-container, message-content");
      if (responses.length === 0) return false;
      const last = responses[responses.length - 1] as HTMLElement;
      if (!last) return false;

      if (last.querySelector("audio, video, audio source, video source")) return true;
      if (last.querySelector('button[aria-label*="Play"], [role="button"][aria-label*="Play"]')) return true;
      if (last.querySelector('mat-icon[fonticon="play_arrow"], mat-icon[fonticon="movie"], mat-icon[fonticon="music_note"]')) return true;

      const text = (last.textContent ?? "").replace(/\s+/g, " ").trim();
      return /\b\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}\b/.test(text);
    }).catch(() => false);
  }

  private async activateLastResponsePlayButton(page: Page): Promise<boolean> {
    const lastResponse = page.locator("response-container").last();
    if (!(await lastResponse.isVisible().catch(() => false))) return false;

    const candidates = [
      lastResponse.locator('button[aria-label*="Play"]').first(),
      lastResponse.locator('[role="button"][aria-label*="Play"]').first(),
      lastResponse.locator('button:has(mat-icon[fonticon="play_arrow"])').first(),
      lastResponse.locator('[role="button"]:has(mat-icon[fonticon="play_arrow"])').first(),
    ];

    for (const candidate of candidates) {
      if (!(await candidate.isVisible({ timeout: 300 }).catch(() => false))) continue;
      try {
        await candidate.click({ force: true });
        return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  private async triggerDownload(page: Page, locator: Locator): Promise<Buffer | null> {
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 20_000 }),
        locator.click({ force: true }),
      ]);
      const filePath = await download.path();
      if (!filePath) return null;
      const { readFile } = await import("node:fs/promises");
      return readFile(filePath);
    } catch {
      return null;
    }
  }

  private async trySetInputFiles(page: Page, filePath: string): Promise<boolean> {
    const candidates = [
      page.locator('input[type="file"]').last(),
      page.locator('input[type="file"][accept]').last(),
      page.locator('input[type="file"][multiple]').last(),
    ];

    for (const input of candidates) {
      if ((await input.count().catch(() => 0)) === 0) continue;
      try {
        await input.setInputFiles(filePath, { timeout: 5_000 });
        return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  private async findAttachmentButtons(page: Page): Promise<Locator[]> {
    const selectors = [
      'button[aria-label*="Add"]',
      'button[aria-label*="Upload"]',
      'button[aria-label*="Attach"]',
      'button[aria-label*="photo" i]',
      'button[aria-label*="file" i]',
      'button[aria-label*="image" i]',
      'button[mattooltip*="Add"]',
      'button[mattooltip*="Upload"]',
      'button[mattooltip*="Attach"]',
      'button:has(mat-icon[fonticon="add"])',
      'button:has(mat-icon[fonticon="attach_file"])',
      'button:has(mat-icon[fonticon="upload_file"])',
      'button:has(mat-icon[fonticon="image"])',
    ];

    const buttons: Locator[] = [];
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const button = locator.nth(i);
        if (await button.isVisible({ timeout: 500 }).catch(() => false)) {
          buttons.push(button);
        }
      }
    }

    const textMatches = page.locator("button").filter({
      hasText: /add files|upload files|photos and files|upload|attach|image|photo/i,
    });
    const extraCount = await textMatches.count().catch(() => 0);
    for (let i = 0; i < extraCount; i++) {
      const button = textMatches.nth(i);
      if (await button.isVisible({ timeout: 500 }).catch(() => false)) {
        buttons.push(button);
      }
    }

    return buttons;
  }

  private async tryChooseFiles(page: Page, target: Locator, filePath: string): Promise<boolean> {
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 5_000 }),
        target.click({ force: true }),
      ]);
      await chooser.setFiles(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async waitForAttachmentPreview(page: Page, timeoutMs = 15_000): Promise<void> {
    const previewSelectors = [
      '.attachment-container',
      '[data-test-id*="attachment"]',
      '[aria-label*="Remove attachment"]',
      'img[src^="blob:"]',
      'video[src^="blob:"]',
      'audio[src^="blob:"]',
      'button[aria-label*="Remove file"]',
    ];

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of previewSelectors) {
        const locator = page.locator(selector).last();
        if (await locator.isVisible().catch(() => false)) return;
      }
      await sleep(300);
    }

    await sleep(1_000);
  }

  private async triggerDownloadWithMeta(
    page: Page,
    locator: Locator,
    filenameFallback: string,
  ): Promise<GeneratedMedia | null> {
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 20_000 }),
        locator.click({ force: true }),
      ]);
      const filePath = await download.path();
      if (!filePath) return null;
      const { readFile } = await import("node:fs/promises");
      const filename = download.suggestedFilename() || filenameFallback;
      return {
        buffer: await readFile(filePath),
        filename,
        mimeType: this.inferMimeType(filename),
      };
    } catch {
      return null;
    }
  }

  private inferMimeType(filename: string): string {
    const normalized = filename.toLowerCase();
    if (normalized.endsWith(".mp3")) return "audio/mpeg";
    if (normalized.endsWith(".wav")) return "audio/wav";
    if (normalized.endsWith(".ogg")) return "audio/ogg";
    if (normalized.endsWith(".m4a")) return "audio/mp4";
    if (normalized.endsWith(".mp4")) return "video/mp4";
    if (normalized.endsWith(".mov")) return "video/quicktime";
    if (normalized.endsWith(".webm")) return "video/webm";
    return "application/octet-stream";
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private extractNewText(baseline: ConversationSnapshot, text: string): string {
    const current = this.sanitize(text, baseline.prompt);
    if (!current) return "";
    if (!baseline.lastText) return current;
    if (current === baseline.lastText) return "";
    if (current.startsWith(baseline.lastText)) {
      const suffix = current.slice(baseline.lastText.length).trim();
      return suffix.length > 0 ? suffix : "";
    }
    return current;
  }

  private sanitize(text: string, prompt?: string): string {
    let cleaned = text.trim();
    if (!cleaned) return "";

    if (prompt) cleaned = cleaned.replaceAll(prompt, " ").trim();

    const noise = [
      "Gemini isn't human. It can make mistakes, including about people, so double-check it.",
      "Your privacy & Gemini Apps",
      "Opens in a new window",
      "Google may display inaccurate info",
    ];
    for (const marker of noise) cleaned = cleaned.replaceAll(marker, " ");

    cleaned = cleaned.replace(/Gemini Apps Activity[\s\S]*$/i, " ");
    cleaned = cleaned.replace(/^Opens in a new window\s*/i, "");
    // Only strip "Gemini" if it's a standalone line (not part of a sentence)
    cleaned = cleaned.replace(/^Gemini said[:：]\s*/i, "");
    cleaned = cleaned.replace(/^You said[:：]\s*/i, "");
    cleaned = cleaned.replace(/^Caricamento di .*$/gim, " ");
    cleaned = cleaned.replace(/Gemini isn['']t human\.[\s\S]*?double-check it\.\s*/i, "");
    cleaned = cleaned.replace(/Your privacy & Gemini Apps[\s\S]*$/i, " ");
    cleaned = cleaned.replace(/^Ask Gemini 3\s*$/im, "");
    cleaned = cleaned.replace(/^\s*Create image\s*$/gim, "");
    cleaned = cleaned.replace(/^\s*Help me learn\s*$/gim, "");
    cleaned = cleaned.replace(/^\s*Boost my day\s*$/gim, "");
    cleaned = cleaned.replace(/^\s*\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}\s*$/gim, "");

    const noiseLines = new Set(["you said", "gemini said", "tools", "fast", "ask gemini 3"]);

    cleaned = cleaned
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !noiseLines.has(l.toLowerCase()))
      .join("\n")
      .trim();

    return cleaned.replace(/\s{3,}/g, "  ").trim();
  }
}
