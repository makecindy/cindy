import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { TerminalClient } from '../contracts.js';
import type { ChannelRegistrationState } from '../im/registration.js';
import type { Locale } from './i18n.js';
import { authenticationText } from './authenticationText.js';
import { Input, terminalText } from './input.js';
import type { ProviderLoginState } from '../models/login.js';
import { readModelConfiguration } from '../models/client.js';

const labels = {
  en: ['Create and connect', 'Connected', 'Created · connecting', 'Connected on another device', 'Enter to return'],
  'zh-CN': ['创建并连接', '已连接', '已创建 · 连接中', '已在另一台设备连接', 'Enter 返回'],
  'zh-TW': ['建立並連線', '已連線', '已建立 · 連線中', '已在另一台裝置連線', 'Enter 返回'],
  ja: ['作成して接続', '接続済み', '作成済み · 接続中', '別のデバイスで接続中', 'Enter で戻る'],
  ko: ['만들고 연결', '연결됨', '생성됨 · 연결 중', '다른 기기에서 연결됨', 'Enter로 돌아가기'],
} satisfies Record<Locale, string[]>;

/** The local controller owns the encrypted remote exchange. Neither the
 * resource invocation nor a broadcast event carries an authorization code. */
export function ChannelRegistration({ client, device, service, providerId, locale, onDone, onTerminal }: {
  client: TerminalClient; device?: string; service?: string; providerId?: string; locale: Locale; onDone(): void; onTerminal?(id: string): void;
}) {
  const t = authenticationText(locale), l = labels[locale];
  const { rows } = useWindowSize();
  const [state, setState] = useState<ChannelRegistrationState & ProviderLoginState>();
  const [callback, setCallback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [callbackError, setCallbackError] = useState(false);
  const [providerName, setProviderName] = useState('');
  useEffect(() => {
    let current = true;
    setProviderName(providerId ? ({ openai: 'ChatGPT', xai: 'SuperGrok', anthropic: 'Claude' } as Record<string, string>)[providerId] ?? '' : '');
    if (providerId) void readModelConfiguration(client, device).then(configuration => {
      const provider = configuration.providers.find(p => p.id === providerId);
      if (current && provider) setProviderName(provider.name);
    }).catch(() => {});
    return () => { current = false; };
  }, [client, device, providerId]);
  const channel = providerId ? 'terminal:provider-login' : 'terminal:channel-registration';
  const id = useRef<string | undefined>(undefined);
  const terminal = useRef(onTerminal); terminal.current = onTerminal;
  const transferred = useRef(false);
  const done = useRef(onDone); done.current = onDone;
  const cancel = async (requestId: string) => { await client.invoke(channel, [{ command: 'cancel', id: requestId }]).catch(() => {}); };
  useEffect(() => {
    let disposed = false, timer: NodeJS.Timeout | undefined, expiresAt: number | undefined;
    const apply = (next: ChannelRegistrationState & ProviderLoginState) => {
      if (disposed) return;
      setState(next);
      if (next.terminal && id.current && terminal.current) { transferred.current = true; terminal.current(id.current); return; }
      expiresAt = next.expiresAt;
      if (next.status === 'pending') timer = setTimeout(() => { void read(); }, 1500);
    };
    const read = async () => {
      if (expiresAt !== undefined && Date.now() >= expiresAt) { apply({ status: 'expired' }); if (id.current) void cancel(id.current); return; }
      try {
        const result = await client.invoke<{ state: ChannelRegistrationState }>(channel, [{ command: 'read', id: id.current }]);
        apply(result.state);
      } catch { if (!disposed) setState({ status: 'error' }); }
    };
    void client.invoke<{ id: string; state: ChannelRegistrationState }>(channel, [{ command: 'begin', ...(providerId ? { providerId } : { service }), ...(device ? { deviceId: device } : {}) }]).then(result => {
      if (disposed) { void cancel(result.id); return; }
      id.current = result.id; apply(result.state);
    }).catch(() => { if (!disposed) setState({ status: 'error' }); });
    return () => { disposed = true; clearTimeout(timer); if (id.current && !transferred.current) void cancel(id.current); id.current = undefined; };
  }, [client, device, service, providerId]);
  useInput((_input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape || key.return && state && state.status !== 'pending') done.current();
  });
  async function submitCallback(value: string) {
    if (!value || value.length > 32768 || submitting) return;
    setCallback(''); setSubmitting(true); setCallbackError(false);
    const payload: Record<string, unknown> = { command: 'submit', id: id.current, callback: value };
    try { const result = await client.invoke<{ state: ProviderLoginState }>(channel, [payload]); setState(result.state); }
    catch { setCallbackError(true); }
    finally { delete payload.callback; setSubmitting(false); }
  }
  const status = state?.status;
  const failed = status === 'error' || state?.verdict === 'error';
  return <Box flexDirection="column" gap={rows < 28 ? 0 : 1}>
    <Text bold>{providerId ? ({en:'Connect provider','zh-CN':'连接供应商','zh-TW':'連接供應商',ja:'プロバイダーに接続',ko:'공급자 연결'})[locale] : l[0]}</Text>
    {providerName && <Text wrap="truncate-end">{terminalText(providerName)}</Text>}
    {(!state || status === 'pending' && !state.verificationUrl) && <Text>{t.loading}</Text>}
    {status === 'pending' && state?.verificationUrl && <>
      <Text>{t.openBrowser}</Text>
      <Text wrap="wrap">{terminalText(state?.verificationUrl ?? '')}</Text>
      <Text bold>{terminalText(state?.userCode ?? '')}</Text>
      <Text dimColor>{t.waitBrowser}</Text>
      {state?.callbackRequired && <>
        <Text>{({en:'Paste callback URL', 'zh-CN':'粘贴回调网址', 'zh-TW':'貼上回呼網址', ja:'コールバック URL を貼り付け', ko:'콜백 URL 붙여넣기'})[locale]}</Text>
        <Input value={callback} onChange={setCallback} onSubmit={value => { void submitCallback(value); }} secret active={!submitting} />
        {callbackError && <Text color="red">{t.failed}</Text>}
      </>}
    </>}
    {status === 'success' && !failed && <Text>{providerId ? l[1] : state?.verdict === 'conflict' ? l[3] : state?.verdict === 'connected' ? l[1] : l[2]}</Text>}
    {status === 'expired' && <Text>{t.browserExpired}</Text>}
    {status === 'cancelled' && <Text>{t.cancelled}</Text>}
    {failed && <Text color="red">{t.failed}</Text>}
    <Text dimColor>{state && status !== 'pending' ? l[4] : `Esc · ${t.cancel}`}</Text>
  </Box>;
}
