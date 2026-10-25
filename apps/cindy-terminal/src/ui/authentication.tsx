import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { AccountMembership, AuthFlowState, ProviderConfig, TerminalAuthSnapshot, TerminalCaptchaChallenge, VerificationKind } from '@cindy/auth-client';
import type { TerminalClient } from '../contracts.js';
import type { Locale } from './i18n.js';
import { Input, terminalText } from './input.js';
import { useInputState } from './state.js';
import { authenticationError, authenticationText } from './authenticationText.js';

type Row = { id: string; title: string; detail?: string; run: () => void | Promise<void> };
type Form = { id: string; label: string; secret?: boolean; limit?: number; submit: (value: string) => Promise<void> };
type Authorization = { url: string; expiresAt: number };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
class AuthUiError extends Error {
  constructor(readonly code: string, readonly retryAt?: number) { super(code); }
}
function failure(error: unknown): AuthUiError {
  const value = record(error);
  const code = typeof value.code === 'string' ? value.code : error instanceof Error ? error.message : '';
  return new AuthUiError(/^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'OPERATION_FAILED', typeof value.retryAt === 'number' ? value.retryAt : undefined);
}
function authorization(value: unknown): Authorization | null {
  const item = record(value);
  if (typeof item.url !== 'string' || typeof item.expiresAt !== 'number') return null;
  try {
    const url = new URL(item.url);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return null;
  } catch { return null; }
  return { url: item.url, expiresAt: item.expiresAt };
}

/** Owns its input and subscriptions. All channels are explicitly local: login
 * values never use a selected remote device or an agent/tool invocation.
 */
export function Authentication({ client, locale, onDone, onNeedsVault = onDone, sso = false }: {
  client: TerminalClient; locale: Locale; onDone: () => void; onNeedsVault?: () => void; sso?: boolean;
}) {
  const t = authenticationText(locale);
  const { rows: terminalRows } = useWindowSize();
  const [auth, setAuth] = useState<TerminalAuthSnapshot | null>(null);
  const [providers, setProviders] = useState<ProviderConfig | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<AuthUiError | null>(null);
  const [selected, setSelected, selectedNow] = useInputState(0);
  const [locked, setLocked] = useState(false);
  const [link, setLink] = useState<Authorization | null>(null);
  const [captcha, setCaptcha] = useState<TerminalCaptchaChallenge | null>(null);
  const [memberships, setMemberships] = useState<AccountMembership[] | null>(null);
  const [now, setNow] = useState(Date.now);
  const alive = useRef(true);
  const generation = useRef(0);
  const eventRevision = useRef(0);
  const seenFlow = useRef<AuthFlowState | null>(null);

  async function call<T = unknown>(channel: string, args: unknown[] = []): Promise<T> {
    try {
      const result = await client.invoke(channel, args);
      const envelope = record(result);
      if (envelope.ok === false) throw failure(envelope.error);
      return (envelope.ok === true && 'data' in envelope ? envelope.data : result) as T;
    } catch (reason) { throw failure(reason); }
  }
  function apply(next: TerminalAuthSnapshot) {
    if (!alive.current) return;
    setAuth(next);
    if (next.flow?.step === 'identifier' || next.flow?.step === 'realm-confirmation') setProviders(next.flow.providers);
    if (next.flow?.step !== seenFlow.current?.step) {
      setSelected(0); setValue(''); setForm(null); setCaptcha(null);
    }
    seenFlow.current = next.flow;
    if (next.error) setError(new AuthUiError(next.error.code, next.error.retryAt));
    if (next.flow?.step !== 'browser-redirect') setLink(null);
  }
  async function action(work: () => Promise<void>) {
    const current = ++generation.current;
    setError(null); setBusy(true);
    try { await work(); }
    catch (reason) {
      if (alive.current && generation.current === current) {
        const error = failure(reason);
        setError(error);
        if (['VAULT_LOCKED', 'VAULT_NOT_INITIALIZED'].includes(error.code)) setLocked(true);
      }
    } finally { if (alive.current && generation.current === current) setBusy(false); }
  }
  function edit(next: Form) { setValue(''); setError(null); setSelected(0); setForm(next); }
  async function restart() {
    setValue(''); setForm(null); setCaptcha(null); setLink(null); setMemberships(null);
    apply(await call<TerminalAuthSnapshot>('terminal:auth:begin'));
  }
  async function leave() {
    generation.current++;
    setValue(''); setForm(null); setCaptcha(null); setLink(null);
    try { await call('terminal:auth:cancel'); } catch { /* leaving never displays remote errors */ }
    if (alive.current) onDone();
  }
  function identity(kind: 'email' | 'phone' | 'sso') {
    edit({ id: kind, label: kind === 'email' ? t.email : kind === 'phone' ? t.phone : t.organization, limit: 254, submit: async identifier => {
      if (kind === 'phone') await requestCode(kind, identifier);
      else { apply(await call<TerminalAuthSnapshot>(kind === 'sso' ? 'terminal:auth:organization' : 'terminal:auth:email', [identifier])); setForm(null); }
    } });
  }
  async function requestCode(kind: VerificationKind, identifier: string) {
    try {
      apply(await call<TerminalAuthSnapshot>('terminal:auth:request-code', [kind, identifier]));
      setForm(null); setCaptcha(null);
    } catch (reason) {
      if (failure(reason).code !== 'CAPTCHA_REQUIRED') throw reason;
      const challenge = await call<TerminalCaptchaChallenge>('terminal:auth:captcha-start', [kind, identifier, { lang: locale }]);
      setError(null); setCaptcha(challenge);
      edit({ id: 'captcha', label: t.captchaPaste, secret: true, limit: 8192, submit: async returnedUrl => {
        try {
          apply(await call<TerminalAuthSnapshot>('terminal:auth:captcha-complete', [challenge.id, returnedUrl]));
          setForm(null); setCaptcha(null);
        } catch (reason) {
          // Invalid pasted text can be corrected; every other result consumes
          // or invalidates this challenge and requires a newly issued one.
          if (failure(reason).code !== 'CAPTCHA_RETURN_INVALID') { setForm(null); setCaptcha(null); }
          throw reason;
        }
      } });
    }
  }
  function code(channel: string) {
    edit({ id: 'code', label: t.code, secret: true, limit: 256, submit: async input => {
      apply(await call<TerminalAuthSnapshot>(channel, [input])); setForm(null);
    } });
  }
  async function cancelStep() {
    generation.current++;
    setValue(''); setForm(null); setCaptcha(null); setLink(null); setMemberships(null);
    setBusy(true); setError(null);
    try { await call('terminal:auth:cancel'); await restart(); }
    catch (reason) { if (alive.current) setError(failure(reason)); }
    finally { if (alive.current) setBusy(false); }
  }

  useEffect(() => {
    alive.current = true;
    const unsubscribe = client.subscribe((channel, args) => {
      if (!alive.current) return;
      if (channel === 'terminal:auth:changed') {
        eventRevision.current++;
        apply(args[0] as TerminalAuthSnapshot);
      } else if (channel === 'terminal:auth:url') setLink(authorization(args[0]));
      else if (channel === 'terminal:connection-lost') { generation.current++; setValue(''); setForm(null); setCaptcha(null); setBusy(false); setError(new AuthUiError('CONNECTION_CLOSED')); }
    });
    void action(async () => {
      const revision = eventRevision.current;
      const status = record(await call('terminal:status'));
      if (!alive.current) return;
      const vault = record(status.vault);
      if (vault.locked === true || vault.initialized === false) { setLocked(true); return; }
      const next = status.auth as TerminalAuthSnapshot | undefined;
      if (next && eventRevision.current === revision) apply(next);
      if (sso && (!next?.flow || next.flow.step === 'completed')) { await restart(); identity('sso'); }
      else if (!next?.flow && !next?.session) await restart();
      else if (next?.flow?.step === 'browser-redirect') setLink(authorization(await call('terminal:auth:authorization')));
    });
    return () => { alive.current = false; generation.current++; unsubscribe(); };
  }, [client]);

  useEffect(() => {
    if (!link && !captcha && !error?.retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [link, captcha, error?.retryAt]);

  const flow = auth?.flow;
  const rows: Row[] = [];
  const add = (id: string, title: string, run: Row['run'], detail?: string) => rows.push({ id, title, run, detail });
  if (locked) {
    add('unlock', t.goUnlock, onNeedsVault); add('back', t.back, onDone);
  } else if (memberships) {
    for (const member of memberships) add(member.id, member.displayName || member.email || t.personal, async () => {
      apply(await call<TerminalAuthSnapshot>('terminal:auth:membership', [member.id])); setMemberships(null);
    }, member.orgName ?? undefined);
    add('back', t.back, () => setMemberships(null));
  } else if (flow?.step === 'realm-confirmation') {
    add('continue', t.yes, async () => apply(await call<TerminalAuthSnapshot>('terminal:auth:realm', [true])), flow.targetRegion === 'cn' ? t.mainlandChina : 'Cindy');
    add('decline', flow.personalLoginAvailable ? t.personal : t.back, async () => apply(await call<TerminalAuthSnapshot>('terminal:auth:realm', [false])));
  } else if (flow?.step === 'method-choice') {
    for (const [index, method] of flow.methods.entries()) {
      if (method.type === 'sso') add(`sso-${index}`, method.connectionName || method.orgName || t.sso, async () => { await call('terminal:auth:authorize', ['sso', method.connectionId]); }, method.orgName);
      else if (!flow.methods.some(item => item.type === 'sso' && item.ssoRequired)) add('email', t.email, () => requestCode('email', flow.email));
    }
    add('other', t.otherMethods, restart);
  } else if (flow?.step === 'verification-code') {
    add('code', t.code, () => code('terminal:auth:verify'));
    add('resend', t.resend, () => requestCode(flow.kind, flow.identifier));
    add('other', t.otherMethods, restart);
  } else if (flow?.step === 'sso-verification') {
    add('code', t.code, () => code('terminal:auth:sso-verify'));
    add('resend', flow.codeRequested ? t.resend : t.sendCode, async () => apply(await call<TerminalAuthSnapshot>('terminal:auth:sso-code')));
  } else if (flow?.step === 'binding') {
    if (flow.codeRequested) {
      add('code', t.code, () => code('terminal:auth:binding-verify'));
      add('resend', t.resend, async () => { apply(await call<TerminalAuthSnapshot>('terminal:auth:binding-code', [flow.contact])); });
    }
    add('contact', flow.bindType === 'email' ? t.bindEmail : t.bindPhone, () => edit({ id: 'binding', label: flow.bindType === 'email' ? t.email : t.phone, limit: 254,
      submit: async contact => { apply(await call<TerminalAuthSnapshot>('terminal:auth:binding-code', [contact])); setForm(null); } }));
  } else if (flow?.step === 'account-selection') {
    for (const account of flow.accounts) add(account.id, account.displayName || account.email || t.personal,
      async () => apply(await call<TerminalAuthSnapshot>('terminal:auth:select', [account.id])), account.orgName ?? undefined);
  } else if (flow?.step === 'browser-redirect') {
    if (error || (link && now >= link.expiresAt)) add('retry', t.refreshLogin, restart);
    add('cancel', t.cancel, cancelStep);
  } else if (auth?.session && (!flow || flow.step === 'completed')) {
    add('done', t.done, leave);
    if (auth.session.status !== 'authenticated') add('refresh', t.refreshSession, async () => apply(await call<TerminalAuthSnapshot>('terminal:auth:refresh')));
    for (const account of auth.accounts.filter(item => item.key !== auth.session?.key)) add(account.key, account.membership.displayName || account.membership.email || t.personal,
      async () => apply(await call<TerminalAuthSnapshot>('terminal:auth:switch', [account.key])), account.membership.orgName ?? undefined);
    add('memberships', t.organizationAccounts, async () => { setMemberships(await call<AccountMembership[]>('terminal:auth:memberships')); setSelected(0); });
    add('add', t.addAccount, restart);
    add('logout', t.signOut, async () => { apply(await call<TerminalAuthSnapshot>('terminal:auth:logout')); await restart(); });
  } else {
    const methods = flow?.step === 'identifier' ? flow.providers : providers;
    if (methods?.email) add('email', t.email, () => identity('email'));
    if (methods?.phone) add('phone', t.phone, () => identity('phone'));
    for (const provider of methods?.social ?? []) add(provider, provider === 'wechat' ? t.wechat : provider === 'apple' ? 'Apple' : 'Google', async () => { await call('terminal:auth:authorize', ['social', provider]); });
    add('sso', t.sso, () => identity('sso'));
    if (error && !methods) add('retry', t.refresh, restart);
    add('back', t.back, leave);
  }

  useInput((_input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape && (busy || !form)) { if (locked) onDone(); else if (busy || (flow && !['identifier', 'completed'].includes(flow.step))) void cancelStep(); else void leave(); return; }
    if (form || busy) return;
    if (key.upArrow) setSelected(index => Math.max(0, index - 1));
    if (key.downArrow) setSelected(index => Math.min(rows.length - 1, index + 1));
    if (key.return && rows[selectedNow.current]) { const row = rows[selectedNow.current]; void action(async () => { await row.run(); }); }
  });

  const pageSize = Math.max(3, terminalRows - 14);
  const start = Math.max(0, selected - pageSize + 1);
  const wait = error?.retryAt ? Math.max(0, Math.ceil((error.retryAt - now) / 1000)) : 0;
  return <Box flexDirection="column" flexGrow={1} gap={1}>
    <Box><Text bold>{locked ? t.locked : form?.id === 'captcha' ? t.captcha : auth?.session && (!flow || flow.step === 'completed') ? t.accounts : t.login}</Text>{busy && <Text dimColor>  {t.loading}</Text>}</Box>
    {locked && <Text>{t.unlockFirst}</Text>}
    {auth?.session && (!flow || flow.step === 'completed') && <Box flexDirection="column"><Text>{terminalText(auth.session.membership.displayName || auth.session.membership.email || t.personal)}</Text>
      {auth.session.membership.orgName && <Text dimColor>{terminalText(auth.session.membership.orgName)}</Text>}
      {auth.session.status !== 'authenticated' && <Text>{auth.session.status === 'temporarily-unavailable' ? t.connection : t.expired}</Text>}
    </Box>}
    {flow?.step === 'realm-confirmation' && <Text>{t.confirmRegion}</Text>}
    {flow?.step === 'verification-code' && <Text dimColor>{terminalText(flow.identifier)}</Text>}
    {flow?.step === 'sso-verification' && <Text dimColor>{terminalText(flow.targetMasked)}</Text>}
    {flow?.step === 'browser-redirect' && <Box flexDirection="column" gap={1}>
      <Text>{link && now >= link.expiresAt ? t.browserExpired : t.openBrowser}</Text>
      {link && now < link.expiresAt && <Text wrap="wrap">{terminalText(link.url)}</Text>}
      {!error && (!link || now < link.expiresAt) && <Text dimColor>{t.waitBrowser}</Text>}
    </Box>}
    {captcha && <Box flexDirection="column" gap={1}><Text>{t.captchaHelp}</Text><Text wrap="wrap">{terminalText(captcha.url)}</Text>
      {now >= captcha.expiresAt && <Text color="red">{t.expired}</Text>}
    </Box>}
    {form ? <Box flexDirection="column" gap={1}>
      <Text>{form.label}</Text>
      <Input key={form.id} value={value} secret={form.secret} active={!busy} onChange={input => setValue(input.slice(0, form.limit ?? 254))}
        onCancel={() => void cancelStep()} onSubmit={input => {
          if (!input.trim()) { setError(new AuthUiError('INVALID_PARAMS')); return; }
          setValue(''); void action(() => form.submit(input.trim()));
        }} />
      {form.secret && <Text dimColor>{t.protectedInput}</Text>}
    </Box> : <Box flexDirection="column">
      {memberships?.length === 0 && <Text>{t.noAccounts}</Text>}
      {rows.slice(start, start + pageSize).map((row, index) => <Box key={row.id} flexDirection="column" marginBottom={row.detail ? 1 : 0}>
        <Text bold={selected === start + index}>{selected === start + index ? '› ' : '  '}{terminalText(row.title)}</Text>
        {row.detail && <Text dimColor>  {terminalText(row.detail)}</Text>}
      </Box>)}
    </Box>}
    {error && <Box flexDirection="column"><Text color="red">{authenticationError(error.code, locale)}</Text>{wait > 0 && <Text>{t.retryIn} {wait}{t.seconds}</Text>}</Box>}
    <Box flexGrow={1} />
    <Text dimColor>{t.keyboard}</Text>
  </Box>;
}
