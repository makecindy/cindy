let selected;
const buttons = [...document.querySelectorAll('button')];
const status = document.getElementById('status');

async function pick(button, dialog = false) {
  buttons.forEach(item => { item.disabled = true; });
  status.textContent = '正在选择…';
  try {
    let result;
    if (dialog) {
      const response = await fetch('/model-picker', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowRemote: true, ...(selected ? { initial: selected } : {}) }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      result = await response.json();
    } else {
      if (typeof window.cindyUI?.pickModel !== 'function') {
        status.textContent = '当前宿主尚未加载新的面板选模入口，请在包含本次修改的开发版重启后再试。';
        return;
      }
      const { x, y, width, height } = button.getBoundingClientRect();
      result = await window.cindyUI.pickModel({
        anchor: { x, y, width, height }, allowRemote: true,
        ...(selected ? { initial: selected } : {}),
      });
    }
    document.getElementById('result').textContent = JSON.stringify(result, null, 2);
    if (!result.ok) {
      status.textContent = result.errorCode === 'CANCELLED' ? '已取消，原选择保留。' : `选择未完成（${result.errorCode}），请重新选择。`;
      return;
    }
    selected = result.route;
    status.textContent = '已收到完整选择结果。';
    document.getElementById('pick').textContent = selected.model;
    const summary = document.getElementById('summary');
    summary.replaceChildren();
    for (const [label, value] of [
      ['模型', selected.model], ['供应商', selected.providerId], ['引擎', selected.agentKind],
      ['推理强度', selected.effort || '默认'], ['Fast', selected.fastMode ? String(selected.fastMode) : '关闭'],
      ['运行位置', selected.agentDeviceId || '本机'],
    ]) {
      const key = document.createElement('dt'), item = document.createElement('dd');
      key.textContent = label; item.textContent = value;
      summary.append(key, item);
    }
    summary.hidden = false;
  } catch (error) {
    status.textContent = `打开失败，请重试。${error instanceof Error ? error.message : ''}`;
  } finally { buttons.forEach(item => { item.disabled = false; }); }
}
document.getElementById('pick').addEventListener('click', event => { void pick(event.currentTarget); });
document.getElementById('bottom-pick').addEventListener('click', event => { void pick(event.currentTarget); });
document.getElementById('dialog').addEventListener('click', event => { void pick(event.currentTarget, true); });
