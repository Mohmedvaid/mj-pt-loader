// ---- Constants ----
const PROMPT_REGEX = /^IMG\d{2,3}\s+/;

// ---- DOM refs ----
const promptArea = document.getElementById("promptArea");
const totalLines = document.getElementById("totalLines");
const validCount = document.getElementById("validCount");
const invalidCount = document.getElementById("invalidCount");
const minDelayInput = document.getElementById("minDelay");
const maxDelayInput = document.getElementById("maxDelay");
const btnStart = document.getElementById("btnStart");
const btnPause = document.getElementById("btnPause");
const btnStop = document.getElementById("btnStop");
const btnReset = document.getElementById("btnReset");
const statusText = document.getElementById("statusText");
const progressText = document.getElementById("progressText");
const logArea = document.getElementById("logArea");
const mainUI = document.getElementById("main-ui");
const notMJ = document.getElementById("not-mj");

// ---- State ----
let tabId = null;
let running = false;
let paused = false;

// ---- Init: check if on Midjourney ----
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (tab && tab.url && tab.url.includes("midjourney.com")) {
    tabId = tab.id;
    mainUI.style.display = "block";
    notMJ.style.display = "none";
    // Ensure content script is injected
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["content.js"],
    }).catch(() => {
      // Already injected, that's fine
    });
  } else {
    mainUI.style.display = "none";
    notMJ.style.display = "block";
  }
});

// ---- Prompt validation on input ----
promptArea.addEventListener("input", updateStats);

function updateStats() {
  const lines = promptArea.value.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const valid = nonEmpty.filter((l) => PROMPT_REGEX.test(l.trim()));
  const invalid = nonEmpty.length - valid.length;

  totalLines.textContent = nonEmpty.length;
  validCount.textContent = valid.length;
  invalidCount.textContent = invalid;
}

// ---- Logging ----
function log(msg, type = "info") {
  const line = document.createElement("div");
  line.className = `log-${type}`;
  line.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
  logArea.appendChild(line);
  logArea.scrollTop = logArea.scrollHeight;
}

// ---- Parse prompts ----
function getValidPrompts() {
  return promptArea.value
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => {
      const valid = PROMPT_REGEX.test(l);
      if (!valid) log(`⚠️ Skipped: "${l.substring(0, 40)}..."`, "warn");
      return valid;
    });
}

// ---- Send message to content script ----
function sendToContent(action, data = {}) {
  return new Promise((resolve, reject) => {
    if (!tabId) return reject(new Error("No Midjourney tab"));
    chrome.tabs.sendMessage(tabId, { action, ...data }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ---- UI State Management ----
function updateUI() {
  btnStart.disabled = running;
  btnPause.disabled = !running;
  btnStop.disabled = !running;
  btnPause.textContent = paused ? "▶ Resume" : "⏸ Pause";
  promptArea.disabled = running;

  if (running && paused) statusText.textContent = "⏸ Paused";
  else if (running) statusText.textContent = "🟢 Running";
  else statusText.textContent = "⏹ Ready";
}

// ---- Listen for messages from content script ----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "log") {
    log(msg.text, msg.level || "info");
  } else if (msg.type === "progress") {
    progressText.textContent = `${msg.current} / ${msg.total}`;
  } else if (msg.type === "done") {
    running = false;
    paused = false;
    log(`🎉 Complete! All ${msg.total} prompts sent.`, "success");
    updateUI();
  } else if (msg.type === "stopped") {
    running = false;
    paused = false;
    updateUI();
  } else if (msg.type === "error") {
    log(`❌ ${msg.text}`, "error");
    running = false;
    paused = false;
    updateUI();
  }
});

// ---- Controls ----
btnStart.addEventListener("click", async () => {
  const prompts = getValidPrompts();
  if (prompts.length === 0) {
    log("⚠️ No valid prompts to send.", "warn");
    return;
  }

  const minDelay = parseFloat(minDelayInput.value) * 1000;
  const maxDelay = parseFloat(maxDelayInput.value) * 1000;

  if (maxDelay < minDelay) {
    log("⚠️ Max delay must be ≥ min delay.", "warn");
    return;
  }

  running = true;
  paused = false;
  log(`🚀 Starting — ${prompts.length} prompts queued`, "info");
  progressText.textContent = `0 / ${prompts.length}`;
  updateUI();

  try {
    await sendToContent("start", { prompts, minDelay, maxDelay });
  } catch (err) {
    log(`❌ Failed to connect: ${err.message}. Try refreshing the page.`, "error");
    running = false;
    updateUI();
  }
});

btnPause.addEventListener("click", async () => {
  paused = !paused;
  log(paused ? "⏸️ Paused" : "▶️ Resumed", "info");
  updateUI();
  try {
    await sendToContent(paused ? "pause" : "resume");
  } catch (err) {
    log(`❌ ${err.message}`, "error");
  }
});

btnStop.addEventListener("click", async () => {
  log("⏹️ Stopping...", "warn");
  running = false;
  paused = false;
  updateUI();
  try {
    await sendToContent("stop");
  } catch (err) {
    log(`❌ ${err.message}`, "error");
  }
});

btnReset.addEventListener("click", async () => {
  running = false;
  paused = false;
  progressText.textContent = "0 / 0";
  logArea.innerHTML = "";
  log("↺ Reset", "info");
  updateUI();
  try {
    await sendToContent("stop");
  } catch (err) {
    // Ignore if not running
  }
});

// ---- Persist prompts in local storage ----
const STORAGE_KEY = "mj_auto_prompts";

// Load saved prompts on open
chrome.storage.local.get([STORAGE_KEY], (result) => {
  if (result[STORAGE_KEY]) {
    promptArea.value = result[STORAGE_KEY];
    updateStats();
  }
});

// Auto-save on input (debounced)
let saveTimer;
promptArea.addEventListener("input", () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [STORAGE_KEY]: promptArea.value });
  }, 500);
});
