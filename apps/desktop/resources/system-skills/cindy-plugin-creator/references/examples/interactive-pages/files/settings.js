document.querySelector('#save').onclick = async () => {
  const button = document.querySelector('#save'); button.disabled = true;
  try {
    const previous = await (await fetch('/kv')).json();
    const response = await fetch('/kv', { method: 'PUT', body: JSON.stringify({ ...previous, displayName: document.querySelector('#label').value.slice(0, 100) }) });
    document.querySelector('#status').textContent = response.ok ? '设置已保存' : '保存失败：' + response.status;
  } catch { document.querySelector('#status').textContent = '保存失败，请稍后重试'; }
  finally { button.disabled = false; }
};
