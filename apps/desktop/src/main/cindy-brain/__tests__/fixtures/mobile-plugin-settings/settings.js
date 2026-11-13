// Test-only original plugin code: no local persistence, production ID branching, or external fetch.
(() => {
  const element = (id) => document.getElementById(id);
  const status = (text) => { element('status').textContent = text; };
  const channel = new BroadcastChannel('qa-settings');
  let sequence = 0;
  let pendingDirectory;
  let pendingProbe;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(path, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
    if (!response.ok) throw new Error('Target request failed: ' + response.status);
    return response.status === 204 ? undefined : response.json();
  };
  const action = (id, run) => {
    element(id).addEventListener('click', async () => {
      element(id).disabled = true;
      try { await run(); } catch { status('Target request failed; read target again before retrying a write.'); }
      finally { element(id).disabled = false; }
    });
  };
  const refreshAccounts = async () => {
    const declarations = await request('/oauth');
    const accounts = declarations.find((entry) => entry.key === 'login')?.accounts ?? [];
    element('accounts').replaceChildren();
    for (const account of accounts) {
      const row = document.createElement('li');
      row.textContent = account.label + (account.isDefault ? ' (default)' : '');
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.textContent = 'Use ' + account.label;
      choose.addEventListener('click', async () => {
        choose.disabled = true;
        try {
          await request('/oauth/login/default', 'POST', { accountId: account.id });
          await refreshAccounts();
          status('Default test account read back from target.');
        } catch { status('Account change not confirmed; read target again.'); }
        finally { choose.disabled = false; }
      });
      row.append(document.createTextNode(' '), choose);
      element('accounts').append(row);
    }
  };
  const readTarget = async () => {
    const preferences = await request('/kv');
    element('displayLabel').value = preferences.displayLabel ?? '';
    element('notifications').checked = preferences.notifications === true;
    element('language').value = preferences.language ?? 'en';
    element('lastField').value = preferences.lastField ?? '';
    const secrets = await request('/secrets');
    element('secretState').textContent = secrets.find((entry) => entry.key === 'key')?.saved
      ? 'Test key saved on target (value is not returned)' : 'No test key saved';
    await refreshAccounts();
    status('Target Host state read.');
  };
  const savePreferences = async (patch) => {
    // /kv replaces an object. Preserve unrelated keys; concurrent-edit semantics remain the plugin's.
    const preferences = { ...await request('/kv'), ...patch };
    await request('/kv', 'PUT', preferences);
    const confirmed = await request('/kv');
    status('Ordinary settings read back: ' + confirmed.displayLabel);
  };
  element('preferences').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = element('preferences').querySelector('[type="submit"]');
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      await savePreferences({
        displayLabel: element('displayLabel').value,
        notifications: element('notifications').checked,
        language: element('language').value,
      });
    } catch { status('Save not confirmed; read target again.'); }
    finally { submit.disabled = false; }
  });
  action('reload', readTarget);
  action('saveSecret', async () => {
    try {
      await request('/secrets/key', 'PUT', { value: element('secret').value });
      const secrets = await request('/secrets');
      element('secretState').textContent = secrets.find((entry) => entry.key === 'key')?.saved
        ? 'Test key saved on target (value is not returned)' : 'No test key saved';
      status('Secret status read back from target.');
    } finally { element('secret').value = ''; }
  });
  action('connect', async () => {
    const result = await request('/oauth/login/connect', 'POST', {});
    await refreshAccounts();
    status(result?.ok ? 'Authorization completed on target.' : 'Authorization did not complete.');
  });
  action('pickDirectory', () => {
    pendingDirectory = 'directory-' + ++sequence;
    channel.postMessage({ kind: 'choose-directory', requestId: pendingDirectory });
    element('directory').textContent = 'Waiting for target directory selection…';
  });
  action('echo', () => {
    pendingProbe = 'probe-' + ++sequence;
    channel.postMessage({ kind: 'probe', requestId: pendingProbe });
    element('channelState').textContent = 'Waiting for channel reply…';
  });
  channel.onmessage = ({ data }) => {
    if (data?.kind === 'directory-result' && data.requestId === pendingDirectory) {
      pendingDirectory = undefined;
      element('directory').textContent = data.cancelled ? 'Directory selection cancelled' : data.name;
    }
    if (data?.kind === 'probe-result' && data.requestId === pendingProbe) {
      pendingProbe = undefined;
      element('channelState').textContent = data.targetLabel;
    }
  };
  for (let index = 1; index <= 16; index++) {
    const label = document.createElement('label');
    label.textContent = 'Unsaved scroll probe ' + index;
    const input = document.createElement('input');
    input.id = 'scrollProbe' + index;
    input.placeholder = 'Local page draft only';
    label.append(input);
    element('longFields').append(label);
  }
  element('longForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = element('longForm').querySelector('[type="submit"]');
    if (submit.disabled) return;
    submit.disabled = true;
    try { await savePreferences({ lastField: element('lastField').value }); }
    catch { status('Bottom field save not confirmed; read target again.'); }
    finally { submit.disabled = false; }
  });
  window.addEventListener('pagehide', () => {
    pendingDirectory = undefined;
    pendingProbe = undefined;
    element('secret').value = '';
    channel.close();
  }, { once: true });
  readTarget().catch(() => status('Cannot read target Host. No fallback data was substituted.'));
})();
