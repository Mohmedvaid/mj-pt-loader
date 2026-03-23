// ---- Constants ----
const PROMPT_REGEX = /^IMG\d{2,3}\s+/;

// ---- DOM refs ----
const promptArea = document.getElementById("promptArea");
const totalLines = document.getElementById("totalLines");
const validCount = document.getElementById("validCount");
const invalidCount = document.getElementById("invalidCount");
const minDelayInput = document.getElementById("minDelay");
const maxDelayInput = document.getElementById("maxDelay");
const relaxedMode = document.getElementById("relaxedMode");
const relaxedFields = document.getElementById("relaxedFields");
const queueLimitInput = document.getElementById("queueLimit");
const queueStatus = document.getElementById("queueStatus");
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
    chrome.scripting
      .executeScript({
        target: { tabId: tabId },
        files: ["content.js"],
      })
      .catch(() => {})
      .finally(() => {
        // Give content script a moment to initialize, then check state
        setTimeout(recoverState, 200);
      });
  } else {
    mainUI.style.display = "none";
    notMJ.style.display = "block";
  }
});

// ---- Recover state from content script ----
function recoverState() {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { action: "getState" }, (state) => {
    if (chrome.runtime.lastError || !state) return;

    running = state.running;
    paused = state.paused;

    if (running || state.currentIndex > 0) {
      progressText.textContent = `${state.currentIndex} / ${state.totalPrompts}`;
      promptArea.disabled = running;

      if (state.relaxedMode) {
        relaxedMode.checked = true;
        relaxedFields.classList.add("show");
        queueLimitInput.value = state.queueLimit;
        if (state.queueCount > 0) {
          queueStatus.textContent = `Queue: ${state.queueCount}`;
          queueStatus.style.color =
            state.queueCount >= state.queueLimit ? "#f44336" : "#4caf50";
        }
      }

      if (running) {
        log("📡 Reconnected — job still running", "info");
      } else if (state.currentIndex >= state.totalPrompts && state.totalPrompts > 0) {
        log("✅ Job already finished", "success");
      } else if (state.currentIndex > 0) {
        log(`⏹ Stopped at ${state.currentIndex}/${state.totalPrompts}`, "warn");
      }
    }

    updateUI();
  });
}

// ---- Relaxed mode toggle ----
relaxedMode.addEventListener("change", () => {
  relaxedFields.classList.toggle("show", relaxedMode.checked);
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
  relaxedMode.disabled = running;
  queueLimitInput.disabled = running;

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
  } else if (msg.type === "queue_update") {
    queueStatus.textContent = `Queue: ${msg.count}`;
    if (msg.waiting) {
      queueStatus.style.color = "#f44336";
    } else {
      queueStatus.style.color = "#4caf50";
    }
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

  const isRelaxed = relaxedMode.checked;
  const queueLimit = parseInt(queueLimitInput.value) || 12;

  running = true;
  paused = false;
  log(
    `🚀 Starting — ${prompts.length} prompts queued${isRelaxed ? ` (relaxed mode, queue limit: ${queueLimit})` : ""}`,
    "info"
  );
  progressText.textContent = `0 / ${prompts.length}`;
  updateUI();

  try {
    await sendToContent("start", {
      prompts,
      minDelay,
      maxDelay,
      relaxedMode: isRelaxed,
      queueLimit,
    });
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
  queueStatus.textContent = "";
  logArea.innerHTML = "";
  log("↺ Reset", "info");
  updateUI();
  try {
    await sendToContent("stop");
  } catch (err) {}
});

// ---- Persist prompts in local storage ----
const STORAGE_KEY = "mj_auto_prompts";
const SETTINGS_KEY = "mj_auto_settings";

chrome.storage.local.get([STORAGE_KEY, SETTINGS_KEY], (result) => {
  if (result[STORAGE_KEY]) {
    promptArea.value = result[STORAGE_KEY];
    updateStats();
  }
  if (result[SETTINGS_KEY]) {
    const s = result[SETTINGS_KEY];
    if (s.minDelay) minDelayInput.value = s.minDelay;
    if (s.maxDelay) maxDelayInput.value = s.maxDelay;
    if (s.relaxedMode) {
      relaxedMode.checked = true;
      relaxedFields.classList.add("show");
    }
    if (s.queueLimit) queueLimitInput.value = s.queueLimit;
  }
});

let saveTimer;
promptArea.addEventListener("input", () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [STORAGE_KEY]: promptArea.value });
  }, 500);
});

function saveSettings() {
  chrome.storage.local.set({
    [SETTINGS_KEY]: {
      minDelay: minDelayInput.value,
      maxDelay: maxDelayInput.value,
      relaxedMode: relaxedMode.checked,
      queueLimit: queueLimitInput.value,
    },
  });
}
minDelayInput.addEventListener("change", saveSettings);
maxDelayInput.addEventListener("change", saveSettings);
relaxedMode.addEventListener("change", saveSettings);
queueLimitInput.addEventListener("change", saveSettings);