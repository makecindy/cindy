  let count = 0;
  document.getElementById('click').addEventListener('click', () => {
    document.getElementById('status').textContent = `此视图已点击 ${++count} 次`;
  });
  const view = window.cindy?.ui?.view;
  const render = snapshot => {
    document.getElementById('position').textContent = `构建：${snapshot.params.buildId ?? '未指定'}\n归属：${snapshot.scope.kind === 'session' ? snapshot.scope.sessionId : '全局'}`;
  };
  if (view) {
    const off = view.onChanged(render);
    view.read().then(render).catch(() => { document.getElementById('position').textContent = '视图已关闭或当前不可用'; });
    window.addEventListener('pagehide', off, { once: true });
  }
