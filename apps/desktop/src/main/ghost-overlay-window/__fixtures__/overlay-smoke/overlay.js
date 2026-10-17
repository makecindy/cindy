// 零桥页面：严禁引用 window.cindy 或任何 preload 能力。
// 与电子脑同源，命中判定结果只经 BroadcastChannel 交给电子脑转发。
(function () {
  'use strict';

  const CHANNEL = 'overlay-smoke';
  const channel = new BroadcastChannel(CHANNEL);

  const CX = 80; // 圆心 x
  const CY = 80; // 圆心 y
  const R = 48;  // 半径（96 / 2）

  let clickCount = 0;
  let lastX = 0;
  let lastY = 0;
  const status = document.getElementById('status');

  function isInsideCircle(x, y) {
    const dx = x - CX;
    const dy = y - CY;
    return dx * dx + dy * dy <= R * R;
  }

  function postInteractive(interactive) {
    channel.postMessage({ type: 'overlay-interactive', interactive: interactive });
  }

  function renderStatus(hit) {
    status.textContent =
      'hit: ' + (hit ? 'yes' : 'no') +
      ' · click: ' + clickCount +
      ' · (' + lastX + ', ' + lastY + ')';
  }

  document.addEventListener('mousemove', (event) => {
    lastX = event.clientX;
    lastY = event.clientY;
    const hit = isInsideCircle(lastX, lastY);
    postInteractive(hit);
    renderStatus(hit);
  });

  document.addEventListener('click', () => {
    // 穿透态（圆外）点击不会到达本页；能到这里说明命中圆且已 set-interactive(true)。
    clickCount += 1;
    renderStatus(true);
  });
})();
