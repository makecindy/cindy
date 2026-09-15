// Tauri 2 globals exposed via `withGlobalTauri: true` in tauri.conf.json.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const PHASE_LABEL = {
  waiting: "等待",
  requesting_elevation: "请求授权",
  backing_up: "备份",
  extracting: "解压中",
  replacing: "替换文件",
  launching: "启动新版",
  rolling_back: "回滚",
  done: "完成",
  failed: "失败",
};

const INDETERMINATE_PHASES = new Set(["waiting", "launching", "requesting_elevation"]);
const retryCopy = window.retryCopy(navigator.language);

const els = {
  chip: document.getElementById("phase-chip"),
  message: document.getElementById("message"),
  fill: document.getElementById("progress-fill"),
  track: document.getElementById("progress-track"),
  errorBar: document.getElementById("error-bar"),
  errorText: document.getElementById("error-text"),
  btnRetry: document.getElementById("btn-retry"),
  btnLog: document.getElementById("btn-log"),
  btnQuit: document.getElementById("btn-quit"),
};

els.btnRetry.textContent = retryCopy.retry;

let retrying = false;
let canRetry = false;

function applyStatus(payload) {
  const phase = payload.phase || "waiting";
  els.chip.textContent = PHASE_LABEL[phase] || phase;
  els.chip.className = `chip phase-${phase}`;
  els.message.textContent = payload.message || "";

  if (phase === "failed") {
    els.track.hidden = true;
    els.errorBar.hidden = !payload.error;
    els.errorText.textContent = retryCopy[payload.error] || payload.error || "";
  } else {
    els.track.hidden = false;
    els.errorBar.hidden = true;
    if (INDETERMINATE_PHASES.has(phase)) {
      els.fill.dataset.state = "indeterminate";
      els.fill.style.width = "";
    } else {
      els.fill.dataset.state = "determinate";
      const raw = typeof payload.progress === "number" && payload.progress >= 0 ? payload.progress : 0;
      const pct = Math.min(100, Math.max(0, raw));
      // Skip the 200ms transition when the bar is moving BACKWARDS
      // (cross-phase reset 100→0 read as a glitch otherwise). Forward
      // motion keeps the smooth fill animation.
      const current = parseFloat(els.fill.style.width) || 0;
      if (pct < current) {
        els.fill.classList.add("no-transition");
        els.fill.style.width = `${pct}%`;
        // Flush the no-transition write before re-enabling animation,
        // otherwise the next forward step would also snap.
        void els.fill.offsetWidth;
        els.fill.classList.remove("no-transition");
      } else {
        els.fill.style.width = `${pct}%`;
      }
    }
  }

  // Close button only appears in terminal states — there's nothing to abort
  // mid-update without leaving the install dir half-rewritten.
  els.btnQuit.hidden = phase !== "done" && phase !== "failed";
  canRetry = phase === "failed" && payload.can_retry === true;
  els.btnRetry.hidden = !canRetry || retrying;
  els.btnRetry.disabled = retrying;
}

els.btnRetry.addEventListener("click", async () => {
  if (retrying || !canRetry) return;

  retrying = true;
  els.btnRetry.hidden = true;
  els.btnRetry.disabled = true;

  try {
    await invoke("retry_update");
  } catch (err) {
    retrying = false;
    els.btnRetry.hidden = !canRetry;
    els.btnRetry.disabled = false;
    els.errorBar.hidden = false;
    els.errorText.textContent = retryCopy[String(err?.message || err)] || retryCopy.spawn_failed;
  }
});

els.btnLog.addEventListener("click", () => {
  invoke("open_log_dir").catch((err) => {
    els.errorBar.hidden = false;
    els.errorText.textContent = String(err?.message || err);
  });
});

els.btnQuit.addEventListener("click", () => {
  invoke("quit_now");
});

(async () => {
  try {
    const initial = await invoke("get_status");
    applyStatus(initial);
  } catch (err) {
    console.error("get_status failed:", err);
  }
  await listen("update-status", (event) => applyStatus(event.payload));
})();
