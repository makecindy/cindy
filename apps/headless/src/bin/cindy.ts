#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import QRCode from 'qrcode';
import { requestControl } from '../control-socket.js';
import { resolveHeadlessPaths } from '../paths.js';
import { startInteractiveChat } from '../terminal-chat.js';
import { HeadlessConfigStore } from '../config.js';
import { createAuthClient, resolveCindyEndpoints } from '../cindy-account.js';
import { AuthApiError, type CindyAuthClient, type DeviceAuthorizationToken, type LoginOutcome } from '@cindy/auth-client';

const [group, command, ...args] = process.argv.slice(2);
if (group === undefined) {
  await startInteractiveChat();
} else if (group?.startsWith('--') && group !== '--help' && group !== '-h') {
  const params = parseArgs([group, command, ...args].filter((value): value is string => value !== undefined));
  await startInteractiveChat(undefined, false, false, interactiveStartParams(params));
} else if (group === 'login') {
  await loginToCindy(parseArgs([command, ...args].filter((value): value is string => value !== undefined)));
} else if (group === 'logout') {
  await logoutFromCindy();
} else if (group === 'whoami') {
  const response = await requestControl(resolveHeadlessPaths().socketFile, { id: randomUUID(), method: 'account.status' });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'provider' && command === 'list') {
  const params = parseArgs(args);
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(),
    method: 'catalog.providers',
    params: params.agentKind ? { agentKind: params.agentKind } : undefined,
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'schedule' && ['list', 'get', 'create', 'update', 'delete', 'pause', 'resume', 'run-now', 'runs', 'delete-run', 'status'].includes(command ?? '')) {
  const params = parseArgs(args);
  const method = command === 'list' ? 'schedule.list'
    : command === 'get' ? 'schedule.get'
      : command === 'create' ? 'schedule.create'
        : command === 'update' ? 'schedule.update'
          : command === 'delete' ? 'schedule.delete'
            : command === 'pause' ? 'schedule.pause'
              : command === 'resume' ? 'schedule.resume'
                : command === 'run-now' ? 'schedule.run-now'
                  : command === 'runs' ? 'schedule.runs'
                    : command === 'delete-run' ? 'schedule.delete-run'
                      : 'schedule.runtime-state';
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(), method,
    params: command === 'list' || command === 'status' ? undefined : scheduleParams(params),
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'provider' && command === 'import-secret') {
  const params = parseArgs(args);
  const secret = await readSecretFromStdin();
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(),
    method: 'provider.secret.import',
    params: { providerId: requiredArg(params, 'providerId'), secret },
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'provider' && command === 'add') {
  const params = parseArgs(args);
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(), method: 'provider.add', params: {
      id: requiredArg(params, 'id'),
      name: requiredArg(params, 'name'),
      agentKind: requiredArg(params, 'agentKind'),
      baseUrl: requiredArg(params, 'baseUrl'),
      model: requiredArg(params, 'model'),
      ...(typeof params.modelName === 'string' ? { modelName: params.modelName } : {}),
      ...(typeof params.deviceAuthorizationUrl === 'string' ? { deviceAuthorizationUrl: params.deviceAuthorizationUrl } : {}),
      ...(typeof params.tokenUrl === 'string' ? { tokenUrl: params.tokenUrl } : {}),
      ...(typeof params.clientId === 'string' ? { clientId: params.clientId } : {}),
      ...(typeof params.scopes === 'string' ? { scopes: params.scopes } : {}),
    },
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'provider' && (command === 'enable' || command === 'disable')) {
  const params = parseArgs(args);
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(), method: 'provider.set-enabled', params: {
      providerId: requiredArg(params, 'providerId'), enabled: command === 'enable',
    },
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'provider' && command === 'device-code') {
  const params = parseArgs(args);
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(), method: 'provider.device-code.start', params: { providerId: requiredArg(params, 'providerId') },
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'provider' && command === 'device-code-status') {
  const params = parseArgs(args);
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(), method: 'provider.device-code.status', params: { attemptId: requiredArg(params, 'attemptId') },
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'model' && command === 'list') {
  const params = parseArgs(args);
  const agentKind = requiredArg(params, 'agentKind');
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(),
    method: 'catalog.models',
    params: { agentKind, ...(typeof params.providerId === 'string' ? { providerId: params.providerId } : {}) },
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'orca' && ['start', 'get', 'list', 'add-worker', 'send', 'idle', 'archive', 'focus', 'end'].includes(command ?? '')) {
  const params = parseArgs(args);
  const leadSessionId = requiredArg(params, 'leadSessionId');
  const method = command === 'start' ? 'orca.team.start'
    : command === 'get' ? 'orca.team.get'
      : command === 'list' ? 'orca.worker.list'
        : command === 'add-worker' ? 'orca.worker.create'
          : command === 'send' ? 'orca.worker.send'
            : command === 'idle' ? 'orca.worker.idle'
              : command === 'archive' ? 'orca.worker.archive'
                : command === 'focus' ? 'orca.worker.focus'
                  : 'orca.team.end';
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(), method, params: {
      leadSessionId,
      ...(command === 'add-worker' ? {
        label: requiredArg(params, 'label'), role: requiredArg(params, 'role'),
        ...(typeof params.agentKind === 'string' ? { agentKind: params.agentKind } : {}),
        ...(typeof params.providerId === 'string' ? { providerId: params.providerId } : {}),
        ...(typeof params.model === 'string' ? { model: params.model } : {}),
        ...(typeof params.effort === 'string' ? { effort: params.effort } : {}),
        ...(typeof params.initialTask === 'string' ? { initialTask: params.initialTask } : {}),
      } : {}),
      ...(['send', 'idle', 'archive', 'focus'].includes(command ?? '') ? { workerRef: requiredArg(params, 'workerRef') } : {}),
      ...(command === 'send' ? { content: requiredArg(params, 'message') } : {}),
    },
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'config' && command === 'defaults') {
  const response = await requestControl(resolveHeadlessPaths().socketFile, { id: randomUUID(), method: 'config.defaults.get' });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'config' && command === 'set-default') {
  const params = parseArgs(args);
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(), method: 'config.defaults.set', params: defaultsParams(params),
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'config' && command === 'reset-defaults') {
  const response = await requestControl(resolveHeadlessPaths().socketFile, { id: randomUUID(), method: 'config.defaults.reset' });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'config' && command === 'project-defaults') {
  const params = parseArgs(args);
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(), method: 'config.project-defaults.get', params: { workDir: requiredArg(params, 'workDir') },
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'config' && command === 'set-project-default') {
  const params = parseArgs(args);
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(), method: 'config.project-defaults.set',
    params: { workDir: requiredArg(params, 'workDir'), ...defaultsParams(params) },
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'config' && command === 'reset-project-defaults') {
  const params = parseArgs(args);
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(), method: 'config.project-defaults.reset', params: { workDir: requiredArg(params, 'workDir') },
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'device-link' && command === 'status') {
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(), method: 'device-link.status',
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'device-link' && command === 'set-name') {
  const params = parseArgs(args);
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(), method: 'device-link.set-name', params: { deviceName: requiredArg(params, 'name') },
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'device-link' && command === 'import-token') {
  const params = parseArgs(args);
  const token = await readSecretFromStdin();
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(), method: 'device-link.token.import', params: {
      token,
      ...(typeof params.apiBaseUrl === 'string' ? { apiBaseUrl: params.apiBaseUrl } : {}),
      ...(typeof params.deviceName === 'string' ? { deviceName: params.deviceName } : {}),
    },
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'device-link' && (command === 'enable' || command === 'disable')) {
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(), method: 'device-link.set-enabled', params: { enabled: command === 'enable' },
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'workdir' && command === 'allow') {
  const params = parseArgs(args);
  const response = await requestControl(resolveHeadlessPaths().socketFile, {
    id: randomUUID(), method: 'workdir.allow', params: { path: requiredArg(params, 'path') },
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'workdir' && command === 'list') {
  const response = await requestControl(resolveHeadlessPaths().socketFile, { id: randomUUID(), method: 'workdir.list' });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} else if (group === 'chat' && (command === undefined || command.startsWith('--'))) {
  const params = parseArgs(command === undefined ? args : [command, ...args]);
  await startInteractiveChat(undefined, false, false, interactiveStartParams(params));
} else if (group === 'chat' && command === 'attach') {
  const params = parseArgs(args);
  await startInteractiveChat(requiredArg(params, 'sessionId'));
} else if (group === 'chat' && command === 'setup') {
  await startInteractiveChat(undefined, false, true);
} else if (group === '--help' || group === '-h' || group === 'help' || group !== 'chat' || !['new', 'list', 'send', 'steer', 'events', 'stop', 'close', 'configure'].includes(command ?? '')) {
  const helpRequested = group === '--help' || group === '-h' || group === 'help';
  (helpRequested ? process.stdout : process.stderr).write([
    'Usage:',
    '  cindy help  # show this command reference',
    '  cindy login --email <address> [--region cn|global]  # Cindy account verification code',
    '  cindy login --phone <number> [--region cn|global]  # Cindy account verification code',
    '  cindy login --sso <organization-id> [--region cn|global]  # scan a terminal QR code to complete enterprise SSO',
    '  cindy logout',
    '  cindy whoami',
    '  cindy chat new [--model <id>] [--agent codex|claude-code] [--provider <id>] [--workdir <path>]',
    '  cindy [--agent codex|claude-code]  # start a chat (Codex by default)',
    '  cindy chat [--agent codex|claude-code]  # alias for cindy',
    '  cindy chat setup  # choose and save terminal defaults',
    '  cindy chat attach --session <id>  # reattach interactively after SSH reconnect',
    '  cindy chat list',
    '  cindy chat send --session <id> --message <text> [--file <absolute-path>] [--image <absolute-path>]',
    '  cindy chat steer --session <id> --message <text>',
    '  cindy chat events --session <id> [--after <sequence>]',
    '  cindy chat stop --session <id>',
    '  cindy chat close --session <id>',
    '  cindy chat configure --session <id> [--agent codex|claude-code] [--provider <id>|null] [--model <id>] [--effort <level>] [--permission <mode>]',
    '  cindy provider list [--agent codex|claude-code]',
    '  cindy provider add --id <slug> --name <name> --agent codex|claude-code --base-url <https-url> --model <id> [--model-name <name>] [--device-authorization-url <url> --token-url <url> --client-id <id> --scopes <scopes>]',
    '  cindy provider enable|disable --provider <id>',
    '  cindy provider import-secret --provider <id>  # reads API key/token from stdin without echoing',
    '  cindy provider device-code --provider <id>',
    '  cindy provider device-code-status --attempt-id <id>',
    '  cindy model list --agent codex|claude-code [--provider <id>]',
    '  cindy orca start|get|list|end --lead-session <id>',
    '  cindy orca add-worker --lead-session <id> --label <label> --role <role> [--agent <kind>] [--model <id>] [--initial-task <text>]',
    '  cindy orca send|idle|archive|focus --lead-session <id> --worker <worker-id-or-label> [--message <text>]',
    '  cindy schedule list|get --schedule <id>',
    '  cindy schedule create --name <name> --prompt <text> --cron <five-field-cron> [--timezone <IANA>] [--agent <kind>] [--provider <id>] [--model <id>] [--workdir <path>]',
    '  cindy schedule update --schedule <id> [schedule create flags]',
    '  cindy schedule pause|resume|delete|run-now --schedule <id>',
    '  cindy schedule runs --schedule <id> [--limit <n>]',
    '  cindy schedule delete-run --run <id>',
    '  cindy schedule status',
    '  cindy config defaults',
    '  cindy config set-default [--agent <kind>] [--provider <id>|null] [--model <id>|null] [--effort <level>] [--permission <mode>]',
    '  cindy config reset-defaults',
    '  cindy config project-defaults --workdir <absolute-directory>',
    '  cindy config set-project-default --workdir <absolute-directory> [same default flags]',
    '  cindy config reset-project-defaults --workdir <absolute-directory>',
    '  cindy device-link status',
    '  cindy device-link set-name --name <friendly-name>',
    '  cindy device-link import-token [--api-base-url <https-url>] [--device-name <name>]  # reads Cindy access token from stdin',
    '  cindy device-link enable|disable',
    '  cindy workdir allow --path <absolute-directory>',
    '  cindy workdir list',
  ].join('\n') + '\n');
  if (!helpRequested) process.exitCode = 2;
} else {
  const socketFile = resolveHeadlessPaths().socketFile;
  const params = parseArgs(args);
  let method: string;
  let requestParams: Record<string, unknown> | undefined;
  if (command === 'list') {
    method = 'session.list';
  } else if (command === 'new') {
    method = 'session.create';
    requestParams = params;
  } else if (command === 'events') {
    method = 'session.events';
    requestParams = { sessionId: requiredArg(params, 'sessionId'), afterSequence: numberArg(params, 'afterSequence', 0) };
  } else {
    const sessionId = requiredArg(params, 'sessionId');
    method = command === 'send' ? 'session.send' : command === 'steer' ? 'session.steer' : command === 'configure' ? 'session.configure' : command === 'close' ? 'session.close' : 'session.abort';
    requestParams = command === 'send'
      ? { sessionId, content: messageContent(params) }
      : command === 'steer'
        ? { sessionId, content: requiredArg(params, 'message') }
      : command === 'configure'
        ? { sessionId, ...sessionConfigurationParams(params) }
        : { sessionId };
  }
  const response = await requestControl(socketFile, { id: randomUUID(), method, params: requestParams });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
}

function parseArgs(args: string[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Expected --key value, got ${key ?? ''}`);
    const param = controlParamName(key.slice(2));
    const parsed = param === 'afterSequence'
      ? Number(value)
      : param === 'fastMode' ? parseBoolean(value, '--fast-mode') : value;
    if (param === 'file' || param === 'image') {
      const previous = map[param];
      map[param] = Array.isArray(previous) ? [...previous, parsed] : previous === undefined ? [parsed] : [previous, parsed];
    } else {
      map[param] = parsed;
    }
  }
  return map;
}

async function loginToCindy(params: Record<string, unknown>): Promise<void> {
  const email = typeof params.email === 'string' ? params.email.trim() : '';
  const phone = typeof params.phone === 'string' ? params.phone.trim() : '';
  const sso = typeof params.sso === 'string' ? params.sso.trim() : '';
  if ([email, phone, sso].filter(Boolean).length !== 1) throw new Error('Specify exactly one of --email, --phone, or --sso');
  const paths = resolveHeadlessPaths();
  const store = new HeadlessConfigStore(paths.configFile);
  const config = await store.read();
  const region = params.region === 'global' ? 'global' : params.region === 'cn' ? 'cn' : config.account?.region ?? 'cn';
  const deviceId = config.account?.deviceId ?? randomUUID();
  const endpoints = await resolveCindyEndpoints(region);
  const auth = createAuthClient(endpoints, region, deviceId);
  const rl = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY && stdout.isTTY) });
  try {
    let completed: Pick<DeviceAuthorizationToken, 'access_token' | 'refresh_token'> | Extract<LoginOutcome, { status: 'ok' }>;
    if (sso) {
      completed = await startSsoLogin(auth, sso, config.deviceName?.trim() || hostname(), rl);
    } else {
      const kind = email ? 'email' : 'phone';
      const identifier = email || phone;
      const providers = await auth.getProviders();
      if ((kind === 'email' && !providers.email) || (kind === 'phone' && !providers.phone)) {
        throw new Error(`Cindy ${kind} login is not enabled for the selected ${region} region; use cindy login --sso <organization-id> or another enabled method`);
      }
      await auth.requestCode(kind, identifier);
      const code = (await rl.question(`Enter the Cindy ${kind} verification code: `)).trim();
      if (!code) throw new Error('Verification code is required');
      const outcome = await auth.verifyCode(kind, identifier, code);
      completed = await finishLoginOutcome(auth, outcome, rl);
    }
    const response = await requestControl(paths.socketFile, {
      id: randomUUID(), method: 'account.login.complete', params: {
        region, deviceId,
        accessToken: 'access_token' in completed ? completed.access_token : completed.accessToken,
        refreshToken: 'refresh_token' in completed ? completed.refresh_token : completed.refreshToken,
      },
    });
    if (!response.ok) throw new Error(response.error.message);
    if (!(response.result as { authenticated?: unknown }).authenticated) {
      throw new Error((response.result as { error?: unknown }).error as string ?? 'Cindy account activation failed');
    }
    const persistent = (response.result as { persistent?: unknown }).persistent === true;
    stdout.write(persistent
      ? 'Cindy account connected and will be restored after service restarts. Run cindy whoami, then cindy chat.\n'
      : 'Cindy account connected for this daemon lifetime. No secure credential store is available, so re-login is required after a service restart. Run cindy whoami, then cindy chat.\n');
  } finally { rl.close(); }
}

async function logoutFromCindy(): Promise<void> {
  const response = await requestControl(resolveHeadlessPaths().socketFile, { id: randomUUID(), method: 'account.logout' });
  if (!response.ok) throw new Error(response.error.message);
  process.stdout.write('Cindy account disconnected.\n');
}

async function startSsoLogin(
  auth: CindyAuthClient,
  organizationId: string,
  deviceName: string,
  rl: ReturnType<typeof createInterface>,
): Promise<Pick<DeviceAuthorizationToken, 'access_token' | 'refresh_token'>> {
  const discovery = await auth.discoverSsoOrg(organizationId.toLowerCase());
  const connection = discovery.connections.length === 1
    ? discovery.connections[0]
    : await chooseSsoConnection(rl, discovery.connections);
  const authorization = await auth.startSsoDeviceAuthorization(connection.connectionId, deviceName);
  await displayDeviceAuthorization(authorization);
  const deadline = Date.now() + authorization.expires_in * 1_000;
  for (;;) {
    try {
      return await auth.pollSsoDeviceAuthorization(authorization.device_code);
    } catch (error) {
      if (!(error instanceof AuthApiError) || error.code !== 'DEVICE_AUTHORIZATION_PENDING') {
        if (error instanceof AuthApiError && error.code === 'DEVICE_AUTHORIZATION_EXPIRED') {
          throw new Error('The device code expired. Run cindy login again to generate a new QR code.');
        }
        throw error;
      }
      if (Date.now() >= deadline) throw new Error('The device code expired. Run cindy login again to generate a new QR code.');
      await new Promise<void>((resolve) => setTimeout(resolve, authorization.interval * 1_000));
    }
  }
}

async function displayDeviceAuthorization(authorization: { user_code: string; verification_uri_complete: string; expires_in: number }): Promise<void> {
  const lines = [
    `Scan this QR code with your phone to sign in to Cindy on this Linux host (valid for ${Math.ceil(authorization.expires_in / 60)} minutes):`,
    '',
  ];
  if (stdout.isTTY) {
    try { lines.push((await QRCode.toString(authorization.verification_uri_complete, { type: 'terminal', small: true })).trimEnd(), ''); } catch { /* The URL below remains a complete fallback. */ }
  }
  lines.push(
    `Login code: ${authorization.user_code}`,
    `Or open: ${authorization.verification_uri_complete}`,
    '',
    'Waiting for enterprise SSO to finish…',
  );
  stdout.write(`${lines.join('\n')}\n`);
}

async function chooseSsoConnection(
  rl: ReturnType<typeof createInterface>,
  connections: Awaited<ReturnType<CindyAuthClient['discoverSsoOrg']>>['connections'],
): Promise<Awaited<ReturnType<CindyAuthClient['discoverSsoOrg']>>['connections'][number]> {
  connections.forEach((connection, index) => stdout.write(`  ${index + 1}. ${connection.connectionName} (${connection.protocol})\n`));
  const selected = Number((await rl.question('Choose SSO connection: ')).trim()) - 1;
  if (!Number.isInteger(selected) || selected < 0 || selected >= connections.length) throw new Error('Invalid SSO connection selection');
  return connections[selected];
}

async function finishLoginOutcome(
  auth: CindyAuthClient,
  initial: LoginOutcome,
  rl: ReturnType<typeof createInterface>,
): Promise<Extract<LoginOutcome, { status: 'ok' }>> {
  let outcome = initial;
  for (;;) {
    if (outcome.status === 'ok') return outcome;
    if (outcome.status === 'select_account') {
      outcome.accounts.forEach((account, index) => stdout.write(`  ${index + 1}. ${account.displayName || account.email || account.id}\n`));
      const selected = Number((await rl.question('Choose Cindy account: ')).trim()) - 1;
      if (!Number.isInteger(selected) || selected < 0 || selected >= outcome.accounts.length) throw new Error('Invalid Cindy account selection');
      outcome = outcome.accountToken
        ? { status: 'ok', ...(await auth.exchangeAccountMembership(outcome.accountToken, outcome.accounts[selected].id)) }
        : await auth.selectAccount(outcome.loginTicket, outcome.accounts[selected].id);
      continue;
    }
    if (outcome.status === 'binding_required') {
      const contact = (await rl.question(`Enter ${outcome.bindType} to bind: `)).trim();
      if (!contact) throw new Error(`A ${outcome.bindType} is required to finish Cindy login`);
      await auth.requestBindingCode(outcome.bindTicket, outcome.bindType, contact);
      const code = (await rl.question(`Enter the Cindy ${outcome.bindType} verification code: `)).trim();
      outcome = await auth.verifyBinding(outcome.bindTicket, outcome.bindType, contact, code);
      continue;
    }
    await auth.requestSsoVerificationCode(outcome.verificationTicket);
    const code = (await rl.question(`Enter the Cindy ${outcome.channel} verification code sent to ${outcome.targetMasked}: `)).trim();
    outcome = await auth.verifySsoVerification(outcome.verificationTicket, code);
  }
}

function controlParamName(value: string): string {
  const aliases: Record<string, string> = {
    agent: 'agentKind',
    provider: 'providerId',
    workdir: 'workDir',
    permission: 'permissionMode',
    workspace: 'workspaceKind',
    session: 'sessionId',
    after: 'afterSequence',
    schedule: 'scheduleId',
    'lead-session': 'leadSessionId',
    worker: 'workerRef',
    'initial-task': 'initialTask',
    run: 'runId',
    cron: 'cronExpr',
  };
  return aliases[value] ?? toCamel(value);
}

function toCamel(value: string): string {
  return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function requiredArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${key} is required`);
  return value;
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  return value === undefined ? fallback : typeof value === 'number' ? value : Number.NaN;
}

function defaultsParams(params: Record<string, unknown>): Record<string, unknown> {
  const allowed = ['agentKind', 'providerId', 'model', 'effort', 'permissionMode'];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in params) out[key] = params[key] === 'null' ? null : params[key];
  }
  return out;
}

function interactiveStartParams(params: Record<string, unknown>): { agentKind?: 'codex' | 'claude-code' } {
  const keys = Object.keys(params);
  if (keys.some((key) => key !== 'agentKind')) {
    throw new Error('Interactive chat accepts only --agent codex|claude-code. Use `cindy help` for other commands.');
  }
  if (params.agentKind === undefined) return {};
  if (params.agentKind !== 'codex' && params.agentKind !== 'claude-code') {
    throw new Error('--agent must be codex or claude-code');
  }
  return { agentKind: params.agentKind };
}

function sessionConfigurationParams(params: Record<string, unknown>): Record<string, unknown> {
  const out = defaultsParams(params);
  if ('fastMode' in params) {
    if (typeof params.fastMode !== 'boolean') throw new Error('--fast-mode must be true or false');
    out.fastMode = params.fastMode;
  }
  if (Object.keys(out).length === 0) throw new Error('Specify at least one session setting to change');
  return out;
}

function messageContent(params: Record<string, unknown>): string | { type: 'user'; content: Array<Record<string, string>> } {
  const message = typeof params.message === 'string' ? params.message : '';
  const files = stringArray(params.file);
  const images = stringArray(params.image);
  if (files.length === 0 && images.length === 0) return requiredArg(params, 'message');
  const content: Array<Record<string, string>> = [];
  if (message.trim()) content.push({ type: 'text', text: message });
  for (const file of files) content.push({ type: 'file', path: file });
  for (const image of images) content.push({ type: 'image', path: image });
  if (content.length === 0) throw new Error('Provide --message, --file, or --image');
  return { type: 'user', content };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : [];
}

function scheduleParams(params: Record<string, unknown>): Record<string, unknown> {
  const out = { ...params };
  if (typeof out.workDir === 'string') {
    out.workingDir = out.workDir;
    delete out.workDir;
  }
  if (out.recurring !== undefined) out.recurring = parseBooleanValue(out.recurring, '--recurring');
  if (out.manual !== undefined) out.manual = parseBooleanValue(out.manual, '--manual');
  if (out.useWorktree !== undefined) out.useWorktree = parseBooleanValue(out.useWorktree, '--use-worktree');
  if (out.fastMode !== undefined) out.fastMode = parseBooleanValue(out.fastMode, '--fast-mode');
  if (out.persistentSession !== undefined) out.persistentSession = parseBooleanValue(out.persistentSession, '--persistent-session');
  if (out.silentWhenIdle !== undefined) out.silentWhenIdle = parseBooleanValue(out.silentWhenIdle, '--silent-when-idle');
  if (typeof out.intervalMs === 'string') out.intervalMs = Number(out.intervalMs);
  if (typeof out.limit === 'string') out.limit = Number(out.limit);
  return out;
}

function parseBooleanValue(value: unknown, flag: string): boolean {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${flag} must be true or false`);
}

function parseBoolean(value: string, name: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

async function readSecretFromStdin(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const value = Buffer.concat(chunks).toString('utf8').trim();
    if (!value) throw new Error('Secret input was empty');
    return value;
  }

  process.stderr.write('Secret (input hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    const value = await new Promise<string>((resolve, reject) => {
      let secret = '';
      const onData = (chunk: Buffer) => {
        for (const byte of chunk) {
          if (byte === 13 || byte === 10) {
            cleanup();
            process.stderr.write('\n');
            resolve(secret.trim());
          } else if (byte === 3) {
            cleanup();
            reject(new Error('Secret input cancelled'));
          } else if (byte === 8 || byte === 127) {
            secret = secret.slice(0, -1);
          } else {
            secret += Buffer.from([byte]).toString('utf8');
          }
        }
      };
      const cleanup = () => process.stdin.off('data', onData);
      process.stdin.on('data', onData);
    });
    if (!value) throw new Error('Secret input was empty');
    return value;
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
