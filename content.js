// ============================================================
// MJ Auto-Prompter — Content Script (injected into Midjourney)
// ============================================================

(function () {
  "use strict";

  // Prevent double-injection
  if (window.__mjAutoLoaded) return;
  window.__mjAutoLoaded = true;

  // ---- Config (set per-run from popup) ----
  let MIN_DELAY = 1000;
  let MAX_DELAY = 3000;
  let RELAXED_MODE = false;
  let QUEUE_LIMIT = 12;

  const SUBMIT_PAUSE = 350;
  const POST_SUBMIT_SETTLE = 600;
  const QUEUE_POLL_INTERVAL = 2000;

  // ---- State ----
  let prompts = [];
  let currentIndex = 0;
  let running = false;
  let paused = false;
  let abortController = null;
  let totalPrompts = 0;

  // ---- Messaging to popup ----
  function notify(type, data = {}) {
    try {
      chrome.runtime.sendMessage({ type, ...data });
    } catch (e) {}
  }

  function logToPopup(text, level = "info") {
    console.log(`[MJ-Auto] ${text}`);
    notify("log", { text, level });
  }

  // ---- DOM Helpers ----
  function getTextarea() {
    return document.querySelector("textarea#desktop_input_bar");
  }

  function getSubmitButton() {
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      if (btn.querySelector("svg g#PaperAirplane")) return btn;
    }
    const ta = getTextarea();
    if (!ta) return null;
    const parent =
      ta.closest("form") || ta.parentElement?.parentElement?.parentElement;
    if (parent) {
      const btns = parent.querySelectorAll("button");
      for (const btn of btns) {
        if (btn.querySelector("svg")) return btn;
      }
    }
    return null;
  }

  // ---- Queue Detection ----
  function getQueueCount() {
    const allDivs = document.querySelectorAll("div");
    for (const div of allDivs) {
      const text = div.textContent?.trim() || "";
      const match = text.match(/^(\d+)\s+queued\s+jobs?$/i);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
    return 0;
  }

  async function waitForQueueSlot(signal) {
    if (!RELAXED_MODE) return;

    let count = getQueueCount();
    if (count < QUEUE_LIMIT) {
      notify("queue_update", { count, waiting: false });
      return;
    }

    logToPopup(
      `⏳ Queue at ${count}/${QUEUE_LIMIT} — waiting for slot...`,
      "warn"
    );
    notify("queue_update", { count, waiting: true });

    while (count >= QUEUE_LIMIT) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      await sleep(QUEUE_POLL_INTERVAL, signal);
      count = getQueueCount();
      notify("queue_update", { count, waiting: count >= QUEUE_LIMIT });
    }

    logToPopup(`✅ Queue dropped to ${count} — resuming`, "success");
    notify("queue_update", { count, waiting: false });
  }

  // React-compatible value setter
  function setNativeValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    ).set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---- Sleep with abort support ----
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true }
        );
      }
    });
  }

  function randomDelay() {
    return MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY);
  }

  // ---- Instant Paste ----
  async function simulateTyping(textarea, text, signal) {
    textarea.focus();
    textarea.click();
    await sleep(50, signal);

    setNativeValue(textarea, text);

    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "a" })
    );
    textarea.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, key: "a" })
    );

    await sleep(100, signal);
  }

  // ---- Submit ----
  async function submitPrompt(signal) {
    await sleep(SUBMIT_PAUSE, signal);

    const btn = getSubmitButton();
    if (!btn) {
      throw new Error("Submit button not found — is text in the input?");
    }

    if (btn.disabled) {
      logToPopup("Submit button disabled — waiting...", "warn");
      for (let i = 0; i < 3; i++) {
        await sleep(500, signal);
        if (!btn.disabled) break;
      }
      if (btn.disabled) throw new Error("Submit button stayed disabled");
    }

    btn.click();
    logToPopup("✅ Submitted");

    await sleep(POST_SUBMIT_SETTLE, signal);
  }

  // ---- Main Loop ----
  async function runLoop() {
    running = true;
    abortController = new AbortController();
    const signal = abortController.signal;

    while (currentIndex < prompts.length) {
      if (signal.aborted) break;

      while (paused && !signal.aborted) {
        await sleep(250, signal).catch(() => {});
      }
      if (signal.aborted) break;

      try {
        await waitForQueueSlot(signal);
      } catch (err) {
        if (err.name === "AbortError") break;
        throw err;
      }

      const prompt = prompts[currentIndex];
      const label =
        prompt.match(/^(IMG\d{2,3})/)?.[1] || `#${currentIndex + 1}`;
      logToPopup(`🎨 [${currentIndex + 1}/${totalPrompts}] Sending ${label}...`);

      try {
        const textarea = getTextarea();
        if (!textarea) {
          logToPopup("Textarea not found — is the Midjourney page loaded?", "error");
          notify("error", { text: "Textarea not found" });
          break;
        }

        await simulateTyping(textarea, prompt, signal);
        await submitPrompt(signal);

        currentIndex++;
        notify("progress", { current: currentIndex, total: totalPrompts });

        if (currentIndex < prompts.length) {
          const delay = randomDelay();
          logToPopup(`⏳ Waiting ${(delay / 1000).toFixed(1)}s...`);
          await sleep(delay, signal);
        }
      } catch (err) {
        if (err.name === "AbortError") {
          logToPopup("⏹️ Stopped", "warn");
          break;
        }
        logToPopup(`Error: ${err.message}`, "error");
        notify("error", { text: err.message });
        break;
      }
    }

    if (currentIndex >= prompts.length && prompts.length > 0) {
      notify("done", { total: totalPrompts });
    }

    running = false;
  }

  function stop() {
    if (abortController) abortController.abort();
    running = false;
    paused = false;
    notify("stopped");
  }

  // ---- Listen for messages from popup ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.action) {
      case "getState":
        sendResponse({
          running,
          paused,
          currentIndex,
          totalPrompts,
          relaxedMode: RELAXED_MODE,
          queueLimit: QUEUE_LIMIT,
          queueCount: RELAXED_MODE ? getQueueCount() : 0,
        });
        break;

      case "start":
        if (running) {
          sendResponse({ ok: false, error: "Already running" });
          return;
        }
        prompts = msg.prompts || [];
        currentIndex = 0;
        totalPrompts = prompts.length;
        MIN_DELAY = msg.minDelay || 1000;
        MAX_DELAY = msg.maxDelay || 3000;
        RELAXED_MODE = msg.relaxedMode || false;
        QUEUE_LIMIT = msg.queueLimit || 12;
        paused = false;
        logToPopup(
          `📋 Received ${prompts.length} prompts${RELAXED_MODE ? ` | Relaxed mode ON (limit: ${QUEUE_LIMIT})` : ""}`
        );
        runLoop();
        sendResponse({ ok: true });
        break;

      case "pause":
        paused = true;
        sendResponse({ ok: true });
        break;

      case "resume":
        paused = false;
        sendResponse({ ok: true });
        break;

      case "stop":
        stop();
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: "Unknown action" });
    }
    return true;
  });

  console.log("[MJ-Auto] Content script loaded on Midjourney ✅");
})();