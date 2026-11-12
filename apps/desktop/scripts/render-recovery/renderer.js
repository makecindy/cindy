// Synthetic content only. No continuous animation/DOM updates: those would prevent
// the delayed frame eviction that electron/electron#42378 describes.
let clicks = 0;
let timerTicks = 0;
const visibilityEvents = [];
setInterval(() => {
  timerTicks += 1;
}, 1000);
document.addEventListener('visibilitychange', () => {
  visibilityEvents.push({ at: Date.now(), state: document.visibilityState });
});
document.getElementById('input').addEventListener('click', (event) => {
  if (!event.isTrusted) return;
  clicks += 1;
  event.currentTarget.textContent = `Input probe: ${clicks}`;
});
window.readProbe = () => ({
  clicks,
  timerTicks,
  visibility: document.visibilityState,
  visibilityEvents,
});
window.probeFrame = () =>
  new Promise((resolve) => {
    const startedAt = performance.now();
    const raf = requestAnimationFrame(() => {
      clearTimeout(timeout);
      resolve({ arrived: true, elapsedMs: performance.now() - startedAt });
    });
    const timeout = setTimeout(() => {
      cancelAnimationFrame(raf);
      resolve({ arrived: false, elapsedMs: performance.now() - startedAt });
    }, 2500);
  });
