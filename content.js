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
  let MAX_DELAY = 2000;
  const TYPING_CHUNK_SIZE = 10;
  const TYPING_CHUNK_DELAY = 12;
  const SUBMIT_PAUSE = 350;
  const POST_SUBMIT_SETTLE = 600; // wait for MJ to process before next

  // ---- State ----
  let prompts = [];
  let currentIndex = 0;
  let running = false;
  let paused = false;
  let abortController = null;

  // ---- Messaging to popup ----
  function notify(type, data = {}) {
    try {
      chrome.runtime.sendMessage({ type, ...data });
    } catch (e) {
      // Popup may be closed, that's fine
    }
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
    // Primary: find button with PaperAirplane SVG
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      if (btn.querySelector("svg g#PaperAirplane")) return btn;
    }
    // Fallback: look near textarea for any submit-like button
    const ta = getTextarea();
    if (!ta) return null;
    const parent = ta.closest("form") || ta.parentElement?.parentElement?.parentElement;
    if (parent) {
      const btns = parent.querySelectorAll("button");
      for (const btn of btns) {
        if (btn.querySelector("svg")) return btn;
      }
    }
    return null;
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

    // Set full text at once
    setNativeValue(textarea, text);

    // Fire events so React picks it up
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));

    await sleep(100, signal);
  }

  // ---- Submit ----
  async function submitPrompt(signal) {
    await sleep(SUBMIT_PAUSE, signal);

    const btn = getSubmitButton();
    if (!btn) {
      throw new Error("Submit button not found — is text in the input?");
    }

    // Check button isn't disabled
    if (btn.disabled) {
      logToPopup("Submit button is disabled — waiting...", "warn");
      // Wait and retry up to 3 times
      for (let i = 0; i < 3; i++) {
        await sleep(500, signal);
        if (!btn.disabled) break;
      }
      if (btn.disabled) throw new Error("Submit button stayed disabled");
    }

    btn.click();
    logToPopup("✅ Submitted");

    // Wait for MJ to process the submit
    await sleep(POST_SUBMIT_SETTLE, signal);
  }

  // ---- Main Loop ----
  async function runLoop() {
    running = true;
    abortController = new AbortController();
    const signal = abortController.signal;

    while (currentIndex < prompts.length) {
      if (signal.aborted) break;

      // Handle pause
      while (paused && !signal.aborted) {
        await sleep(250, signal).catch(() => {});
      }
      if (signal.aborted) break;

      const prompt = prompts[currentIndex];
      const label = prompt.match(/^(IMG\d{2,3})/)?.[1] || `#${currentIndex + 1}`;
      logToPopup(`🎨 [${currentIndex + 1}/${prompts.length}] Sending ${label}...`);

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
        notify("progress", { current: currentIndex, total: prompts.length });

        // Random delay before next
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
      notify("done", { total: prompts.length });
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
      case "start":
        if (running) {
          sendResponse({ ok: false, error: "Already running" });
          return;
        }
        prompts = msg.prompts || [];
        currentIndex = 0;
        MIN_DELAY = msg.minDelay || 1000;
        MAX_DELAY = msg.maxDelay || 2000;
        paused = false;
        logToPopup(`📋 Received ${prompts.length} prompts`);
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
    // Return true for async response handling
    return true;
  });

  console.log("[MJ-Auto] Content script loaded on Midjourney ✅");
})();
