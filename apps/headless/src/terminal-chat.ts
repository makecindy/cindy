import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { cwd, stdin, stdout } from 'node:process';
import { requestControl, subscribeSessionEvents, type SessionEventSubscription } from './control-socket.js';
import { resolveHeadlessPaths } from './paths.js';
import { CindyTerminalUi, type TerminalCommand } from './terminal-ui.js';

type RpcResult = { ok: boolean; result?: unknown; error?: { message: string } };
type SessionController = { id: string; name: string; kind: 'terminal' };

/**
 * Deliberately small terminal interaction layer.  It uses the daemon for all
 * state and execution, so disconnecting SSH never stops a turn or creates an
 * agent process in the shell itself.
 */
export async function startInteractiveChat(
  initialSessionId?: string,
  takeover = false,
  configure = false,
  newSessionOptions: Record<string, unknown> = {},
): Promise<void> {
  return startLineInteractiveChat(initialSessionId, takeover, configure, newSessionOptions);
}

/** The line client remains the compatibility path for setup and dumb terminals. */
async function startLineInteractiveChat(
  initialSessionId?: string,
  takeover = false,
  configure = false,
  newSessionOptions: Record<string, unknown> = {},
): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Interactive chat requires a TTY; use cindy chat new/send in scripts.');
  }
  const socketFile = resolveHeadlessPaths().socketFile;
  const controller: SessionController = {
    id: `terminal:${process.pid}:${randomUUID()}`,
    name: `Linux terminal (${process.pid})`,
    kind: 'terminal',
  };
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    if (initialSessionId) {
      const existing = await rpc(socketFile, 'session.get', { sessionId: initialSessionId }, controller) as { id: string } | null;
      if (!existing) throw new Error(`Unknown session: ${initialSessionId}`);
      renderSessionChrome(existing as SessionView, true);
      const nextSessionId = await attachInteractiveChat(rl, socketFile, initialSessionId, controller, existing as SessionView);
      if (nextSessionId) await startInteractiveChat(nextSessionId);
      return;
    }
    const workspace = await defaultWorkspace(socketFile);
    if (!configure) {
      let preview: CreatePreview;
      let created: SessionView;
      try {
        // A bare `cindy` is deliberately Codex-first.  Other agents are an
        // explicit startup choice (`cindy --agent claude-code`).
        const params = { ...workspace, agentKind: 'codex', ...newSessionOptions };
        preview = await rpc(socketFile, 'session.create.preview', params, controller) as CreatePreview;
        created = await rpc(socketFile, 'session.create', params, controller) as SessionView;
      } catch (error) {
        stdout.write(`\nDefault session is not ready: ${error instanceof Error ? error.message : String(error)}\nOpening setup…\n\n`);
        const created = await configureNewSession(rl, socketFile, workspace, controller);
        renderSessionChrome(created, true);
        const nextSessionId = await attachInteractiveChat(rl, socketFile, created.id, controller, created);
        if (nextSessionId) await startInteractiveChat(nextSessionId);
        return;
      }
      // Only creation errors should open setup.  Once a session exists,
      // a transient daemon restart must keep this as the same conversation.
      renderSessionChrome(created, true, preview);
      const nextSessionId = await attachInteractiveChat(rl, socketFile, created.id, controller, created);
      if (nextSessionId) await startInteractiveChat(nextSessionId);
      return;
    }
    const created = await configureNewSession(rl, socketFile, workspace, controller);
    renderSessionChrome(created, true);
    const nextSessionId = await attachInteractiveChat(rl, socketFile, created.id, controller, created);
    if (nextSessionId) await startInteractiveChat(nextSessionId);
  } finally {
    rl.close();
  }
}

function shouldUseFullscreenTerminal(): boolean {
  // The experimental renderer is deliberately opt-in until it is replaced by
  // the production Codex-derived terminal surface. The stable line client is
  // the default and keeps existing SSH workflows reliable.
  return process.env.CINDY_TERMINAL_UI === '1' && process.env.TERM !== 'dumb';
}

const FULLSCREEN_COMMANDS: readonly TerminalCommand[] = [
  { name: '/help', description: 'Show available Cindy commands' },
  { name: '/settings', description: 'Choose model, provider and permissions' },
  { name: '/sessions', description: 'List active sessions' },
  { name: '/resume', description: 'Switch to a recent session' },
  { name: '/status', description: 'Show context and token usage' },
  { name: '/approve', description: 'Resolve a pending approval' },
  { name: '/attach', description: 'Attach a file to the next message' },
  { name: '/image', description: 'Attach an image to the next message' },
  { name: '/attachments', description: 'Review queued attachments' },
  { name: '/steer', description: 'Redirect the current turn' },
  { name: '/stop', description: 'Interrupt the current turn' },
  { name: '/clear', description: 'Clear this terminal view' },
  { name: '/quit', description: 'Leave; the session keeps running' },
];

/**
 * Full-screen Cindy terminal client.  It consumes the same local control
 * socket used by mobile and desktop, so the UI never owns an agent process or
 * a second copy of the conversation.
 */
async function startFullscreenInteractiveChat(
  initialSessionId?: string,
  takeover = false,
  newSessionOptions: Record<string, unknown> = {},
): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    return startLineInteractiveChat(initialSessionId, takeover, false, newSessionOptions);
  }
  const socketFile = resolveHeadlessPaths().socketFile;
  const controller: SessionController = {
    id: `terminal:${process.pid}:${randomUUID()}`,
    name: `Linux terminal (${process.pid})`,
    kind: 'terminal',
  };
  let session: SessionView;
  let preview: CreatePreview | undefined;
  if (initialSessionId) {
    const existing = await rpc(socketFile, 'session.get', { sessionId: initialSessionId }, controller) as SessionView | null;
    if (!existing) throw new Error(`Unknown session: ${initialSessionId}`);
    session = existing;
  } else {
    try {
      const workspace = await defaultWorkspace(socketFile);
      const params = { ...workspace, agentKind: 'codex', ...newSessionOptions };
      preview = await rpc(socketFile, 'session.create.preview', params, controller) as CreatePreview;
      session = await rpc(socketFile, 'session.create', params, controller) as SessionView;
    } catch (error) {
      // Initial configuration is intentionally kept in the line client.  It is
      // a one-time recovery path and avoids a second, less robust form engine.
      stdout.write(`\nDefault session is not ready: ${error instanceof Error ? error.message : String(error)}\nOpening setup…\n\n`);
      return startLineInteractiveChat(undefined, false, true, newSessionOptions);
    }
  }
  const nextSessionId = await runFullscreenSession(socketFile, session, controller, preview);
  if (nextSessionId) await startFullscreenInteractiveChat(nextSessionId);
}

async function runFullscreenSession(
  socketFile: string,
  session: SessionView,
  controller: SessionController,
  _preview?: CreatePreview,
): Promise<string | undefined> {
  let after = 0;
  let waitingForAgent = false;
  let usage: { tokens?: number; context?: number; window?: number } = {};
  let stream: SessionEventSubscription | undefined;
  let streamStopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let connectedOnce = false;
  let finish: (nextSessionId?: string) => void = () => undefined;
  const pendingInteractions = new Map<string, { kind: 'permission' | 'plan_review'; data: Record<string, unknown> }>();
  const pendingAttachments: Array<{ type: 'file' | 'image'; path: string }> = [];

  const ui = new CindyTerminalUi({
    commands: FULLSCREEN_COMMANDS,
    onSubmit: (line) => { void handleTerminalInput(line); },
    onInterrupt: () => {
      if (waitingForAgent) void rpc(socketFile, 'session.abort', { sessionId: session.id }, controller)
        .catch((error: unknown) => ui.addTranscript(`Error: ${message(error)}`));
    },
    onExit: () => finish(),
  });
  const refreshHeader = (current = session): void => {
    ui.setHeader([
      `Cindy · ${current.workDir || 'Dialogue'}`,
      `${current.agentKind} · ${current.providerId ?? 'default'} · ${current.model} · ${current.effort ?? 'high'} · ${current.permissionMode ?? 'ask'}`,
    ]);
  };
  const renderEvent = (event: { sequence: number; type: string; data: unknown }): void => {
    if (event.type === 'user_message') {
      waitingForAgent = false;
    }
    const agent = agentEvent(event);
    if (agent?.type === 'status') {
      const status = agent.data as { isRunning?: unknown; tokenUsage?: unknown; contextTokens?: unknown; contextWindow?: unknown } | null;
      usage = {
        tokens: typeof status?.tokenUsage === 'number' ? status.tokenUsage : usage.tokens,
        context: typeof status?.contextTokens === 'number' ? status.contextTokens : usage.context,
        window: typeof status?.contextWindow === 'number' ? status.contextWindow : usage.window,
      };
      if (status?.isRunning === true) {
        waitingForAgent = true;
        ui.setActivity('Working');
      } else if (status?.isRunning === false) {
        waitingForAgent = false;
        ui.setActivity();
      }
    }
    if (agent?.type === 'thinking') {
      waitingForAgent = true;
      ui.setActivity('Thinking');
    }
    if (agent?.type === 'tool_use') {
      waitingForAgent = true;
      ui.setActivity('Working');
    }
    if (agent?.type === 'done' || agent?.type === 'error') {
      waitingForAgent = false;
      ui.setActivity();
    }
    if (event.type === 'interaction_request' && event.data && typeof event.data === 'object') {
      const request = event.data as { requestId?: unknown; kind?: unknown } & Record<string, unknown>;
      if (typeof request.requestId === 'string' && (request.kind === 'permission' || request.kind === 'plan_review')) {
        pendingInteractions.set(request.requestId, { kind: request.kind, data: request });
        ui.addTranscript(`Approval needed: ${interactionSummary(request)}\nRun /approve to choose.`);
        return;
      }
    }
    const text = eventText(event);
    if (text) ui.addTranscript(text);
  };
  const consumeEvent = (event: { sequence: number; type: string; data: unknown }): void => {
    if (event.sequence <= after) return;
    after = event.sequence;
    renderEvent(event);
  };
  const refreshEvents = async (): Promise<void> => {
    const events = await rpc(socketFile, 'session.events', { sessionId: session.id, afterSequence: after, limit: 1_000 }, controller) as Array<{
      sequence: number; type: string; data: unknown;
    }>;
    events.forEach(consumeEvent);
  };
  const connectStream = async (): Promise<void> => new Promise<void>((resolve, reject) => {
    let acknowledged = false;
    stream = subscribeSessionEvents(socketFile, session.id, after, {
      onReady: () => {
        acknowledged = true;
        connectedOnce = true;
        reconnectAttempt = 0;
        resolve();
      },
      onEvent: consumeEvent,
      onDisconnect: (error) => {
        if (streamStopped) return;
        const delay = Math.min(5_000, 250 * (2 ** reconnectAttempt++));
        if (!acknowledged && !connectedOnce) {
          reject(error ?? new Error('Cindy event stream disconnected before it was ready'));
          return;
        }
        ui.addTranscript(`Cindy connection interrupted; reconnecting in ${Math.ceil(delay / 1_000)}s…${error ? ` (${error.message})` : ''}`);
        reconnectTimer = setTimeout(() => { void connectStream().catch(() => undefined); }, delay);
      },
    });
  });
  const handleTerminalInput = async (line: string): Promise<void> => {
    try {
      const command = line.startsWith(':') ? `/${line.slice(1)}` : line;
      if (command === '/quit' || command === '/q') {
        finish();
      } else if (command === '/help') {
        ui.addTranscript(fullscreenHelp());
      } else if (command === '/settings') {
        await openFullscreenSettings(ui, socketFile, session, controller, (updated) => {
          session = updated;
          refreshHeader(updated);
        });
      } else if (command === '/clear') {
        ui.clearTranscript();
      } else if (command === '/events') {
        await refreshEvents();
      } else if (command === '/sessions') {
        const sessions = await listResumableSessions(socketFile, controller);
        ui.addTranscript(sessions.length === 0 ? 'No active sessions.' : sessions.map((item, index) => `${index + 1}. ${item.title} · ${item.model} · ${item.id.slice(0, 8)}`).join('\n'));
      } else if (command === '/resume') {
        const sessions = await listResumableSessions(socketFile, controller);
        if (sessions.length === 0) ui.addTranscript('No active sessions to resume.');
        else {
          const selected = await ui.choose('Resume session', sessions, (item) => `${item.title} · ${item.model} · ${item.id.slice(0, 8)}`);
          if (selected.id === session.id) ui.addTranscript('Already in this session.'); else finish(selected.id);
        }
      } else if (command === '/status') {
        ui.addTranscript(formatUsage(usage));
      } else if (command === '/stop') {
        await rpc(socketFile, 'session.abort', { sessionId: session.id }, controller);
      } else if (command.startsWith('/steer ')) {
        const content = command.slice('/steer '.length).trim();
        if (!content) throw new Error('Usage: /steer <message>');
        await rpc(socketFile, 'session.steer', { sessionId: session.id, content }, controller);
        ui.addTranscript(`› ${content}`);
      } else if (command.startsWith('/attach ') || command.startsWith('/image ')) {
        const image = command.startsWith('/image ');
        const attachmentPath = command.slice(image ? '/image '.length : '/attach '.length).trim();
        if (!attachmentPath.startsWith('/')) throw new Error('Attachment paths must be absolute.');
        pendingAttachments.push({ type: image ? 'image' : 'file', path: attachmentPath });
        ui.addTranscript(`Attached for next message: ${attachmentPath}`);
      } else if (command === '/attachments') {
        ui.addTranscript(pendingAttachments.length === 0 ? 'No pending attachments.' : pendingAttachments.map((item, index) => `${index + 1}. ${item.type} · ${item.path}`).join('\n'));
      } else if (command === '/attachments clear') {
        pendingAttachments.splice(0);
        ui.addTranscript('Pending attachments cleared.');
      } else if (command === '/approve') {
        const choices = [...pendingInteractions.entries()];
        if (choices.length === 0) ui.addTranscript('No pending approvals.');
        else {
          const selected = await ui.choose('Approve request', choices, ([requestId, request]) => `${request.kind} · ${interactionSummary(request.data)} · ${requestId.slice(0, 8)}`);
          const behavior = await ui.choose('Decision', ['allow', 'deny'] as const, (item) => item === 'allow' ? 'Allow' : 'Deny');
          await rpc(socketFile, 'session.interaction.resolve', { sessionId: session.id, requestId: selected[0], decision: { kind: selected[1].kind, behavior } }, controller);
          pendingInteractions.delete(selected[0]);
          ui.addTranscript(behavior === 'allow' ? 'Approved.' : 'Denied.');
        }
      } else if (command.startsWith('/model ')) {
        await configureInteractiveSession(socketFile, session.id, { model: command.slice('/model '.length).trim() }, controller);
      } else if (command.startsWith('/provider ')) {
        const providerId = command.slice('/provider '.length).trim();
        await configureInteractiveSession(socketFile, session.id, { providerId: providerId === 'default' ? null : providerId }, controller);
      } else if (command.startsWith('/effort ')) {
        await configureInteractiveSession(socketFile, session.id, { effort: command.slice('/effort '.length).trim() }, controller);
      } else if (command.startsWith('/permission ')) {
        await configureInteractiveSession(socketFile, session.id, { permissionMode: command.slice('/permission '.length).trim() }, controller);
      } else if (command.startsWith('/agent ')) {
        const [agentKind, model, providerId] = command.slice('/agent '.length).trim().split(/\s+/, 3);
        if (!agentKind || !model || (agentKind !== 'codex' && agentKind !== 'claude-code')) throw new Error('Use /settings to choose an agent and model.');
        await configureInteractiveSession(socketFile, session.id, { agentKind, model, ...(providerId ? { providerId: providerId === 'default' ? null : providerId } : {}) }, controller);
      } else if (command.startsWith('/')) {
        throw new Error(`Unknown command: ${command}. Type /help for commands.`);
      } else {
        const content = pendingAttachments.length > 0
          ? { type: 'user', content: [{ type: 'text', text: line }, ...pendingAttachments.splice(0)] }
          : line;
        ui.addTranscript(`› ${line}`);
        waitingForAgent = true;
        ui.setActivity('Thinking');
        await rpc(socketFile, 'session.send', { sessionId: session.id, content }, controller);
      }
    } catch (error) {
      if (message(error) !== 'Selection cancelled.') ui.addTranscript(`Error: ${message(error)}`);
    }
  };
  try {
    await connectStream();
    refreshHeader();
    const completion = new Promise<string | undefined>((resolve) => { finish = resolve; });
    ui.mount();
    ui.addTranscript('Connected to Cindy. Type / to browse commands.');
    return await completion;
  } finally {
    streamStopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    stream?.close();
    ui.unmount();
  }
}

function fullscreenHelp(): string {
  return [
    '/settings  choose model, provider, effort and permissions',
    '/sessions  list sessions    /resume  switch session',
    '/approve   resolve a pending approval    /status  show usage',
    '/attach <path>  attach file    /image <path>  attach image',
    '/steer <text>  redirect turn    /stop  interrupt current turn',
    '/clear  clear view    /quit  leave terminal (session keeps running)',
  ].join('\n');
}

async function openFullscreenSettings(
  ui: CindyTerminalUi,
  socketFile: string,
  sessionId: SessionView,
  controller: SessionController,
  onUpdate: (session: SessionView) => void,
): Promise<void> {
  let current = sessionId;
  for (;;) {
    const action = await ui.choose('Settings', [
      'Model', 'Provider', 'Agent (also choose provider and model)', 'Reasoning effort', 'Permission mode', 'Save as defaults', 'Done',
    ], (item) => item);
    if (action === 'Done') return;
    if (action === 'Model') {
      const model = await selectModelForUi(ui, socketFile, current.agentKind, current.providerId, current.model);
      await configureInteractiveSession(socketFile, current.id, { model: model.id }, controller);
    } else if (action === 'Provider') {
      const provider = await selectProviderForUi(ui, socketFile, current.agentKind, current.providerId);
      const model = await selectModelForUi(ui, socketFile, current.agentKind, provider.id);
      await configureInteractiveSession(socketFile, current.id, { providerId: provider.id, model: model.id }, controller);
    } else if (action === 'Agent (also choose provider and model)') {
      const agentKind = await ui.choose('Agent', ['codex', 'claude-code'] as const, (item) => item);
      const provider = await selectProviderForUi(ui, socketFile, agentKind);
      const model = await selectModelForUi(ui, socketFile, agentKind, provider.id);
      await configureInteractiveSession(socketFile, current.id, { agentKind, providerId: provider.id, model: model.id }, controller);
    } else if (action === 'Reasoning effort') {
      const effort = await ui.choose('Reasoning effort', ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], (item) => item);
      await configureInteractiveSession(socketFile, current.id, { effort }, controller);
    } else if (action === 'Permission mode') {
      const permissionMode = await ui.choose('Permission mode', ['ask', 'default', 'acceptEdits', 'plan', 'auto'], (item) => item);
      await configureInteractiveSession(socketFile, current.id, { permissionMode }, controller);
    } else {
      await rpc(socketFile, 'config.defaults.set', {
        agentKind: current.agentKind, providerId: current.providerId ?? null, model: current.model,
        effort: current.effort, permissionMode: current.permissionMode,
      }, controller);
      ui.addTranscript('Saved as your default settings.');
    }
    current = await rpc(socketFile, 'session.get', { sessionId: current.id }, controller) as SessionView;
    onUpdate(current);
  }
}

async function selectProviderForUi(
  ui: CindyTerminalUi, socketFile: string, agentKind: string, currentId?: string,
): Promise<ProviderOption> {
  const providers = await rpc(socketFile, 'catalog.providers', { agentKind }) as ProviderOption[];
  const connected = providers.filter((provider) => provider.credentialConfigured);
  if (connected.length === 0) {
    const account = await rpc(socketFile, 'account.status') as { authenticated?: unknown; error?: unknown };
    throw new Error(noConfiguredProviderMessage(agentKind, account));
  }
  const selected = await ui.choose('Provider', connected, (item) => `${item.name} (${item.id})${item.id === currentId ? ' · current' : ''}`);
  return selected;
}

async function selectModelForUi(
  ui: CindyTerminalUi, socketFile: string, agentKind: string, providerId?: string, currentId?: string,
): Promise<ModelOption> {
  const models = await rpc(socketFile, 'catalog.models', { agentKind, ...(providerId ? { providerId } : {}) }) as ModelOption[];
  if (models.length === 0) throw new Error(`No models are available for ${agentKind}.`);
  return ui.choose('Model', models, (item) => `${item.name} (${item.id})${item.id === currentId ? ' · current' : ''}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SessionView = {
  id: string; agentKind: string; providerId?: string; model: string; workDir: string;
  workspaceKind?: string; effort?: string; permissionMode?: string;
};
type CreatePreview = Omit<SessionView, 'id'> & { sources?: Record<string, string> };
type ProviderOption = { id: string; name: string; credentialConfigured: boolean };
type ModelOption = { id: string; name: string; defaultEffort?: string | null };

async function configureNewSession(
  rl: ReturnType<typeof createInterface>,
  socketFile: string,
  initialWorkspace: { workDir: string; workspaceKind: 'project' | 'dialogue' },
  controller: SessionController,
): Promise<SessionView> {
    const enteredWorkdir = (await rl.question(`Project directory [${initialWorkspace.workDir || 'dialogue'}]: `)).trim();
    const workspace = enteredWorkdir
      ? { workDir: enteredWorkdir, workspaceKind: 'project' as const }
      : initialWorkspace;
    const agentKind = await choose(rl, 'Agent', ['codex', 'claude-code']);
    const provider = await selectProvider(rl, socketFile, agentKind);
    const model = await selectModel(rl, socketFile, agentKind, provider.id);
    const effort = await choose(rl, 'Effort', ['low', 'medium', 'high', 'xhigh'], undefined, model.defaultEffort ?? 'high');
    const permissionMode = await choose(rl, 'Permission', ['ask', 'default', 'acceptEdits', 'auto'], undefined, 'ask');
    const created = await rpc(socketFile, 'session.create', {
      agentKind, providerId: provider.id, model: model.id, ...workspace, effort, permissionMode,
    }, controller) as SessionView;
    const save = (await rl.question('Save these as your defaults? [Y/n]: ')).trim().toLowerCase();
    if (save !== 'n' && save !== 'no') {
      await rpc(socketFile, 'config.defaults.set', { agentKind, providerId: provider.id, model: model.id, effort, permissionMode }, controller);
    }
    return created;
}

async function attachInteractiveChat(
  rl: ReturnType<typeof createInterface>,
  socketFile: string,
  sessionId: string,
  controller: SessionController,
  session?: SessionView,
): Promise<string | undefined> {
  let after = 0;
  let pollingPaused = false;
  let waitingForAgent = false;
  let responding = false;
  let usage: { tokens?: number; context?: number; window?: number } = {};
  const pendingInteractions = new Map<string, { kind: 'permission' | 'plan_review'; data: Record<string, unknown> }>();
  const pendingAttachments: Array<{ type: 'file' | 'image'; path: string }> = [];
  const deferredEvents: Array<{ sequence: number; type: string; data: unknown }> = [];
  const renderEvent = (event: { sequence: number; type: string; data: unknown }): void => {
    if (event.type === 'user_message') {
      responding = false;
      waitingForAgent = false;
    }
    const agent = agentEvent(event);
    if (agent?.type === 'status') {
      const status = agent.data as { isRunning?: unknown; tokenUsage?: unknown; contextTokens?: unknown; contextWindow?: unknown } | null;
      const running = status?.isRunning;
      usage = {
        tokens: typeof status?.tokenUsage === 'number' ? status.tokenUsage : usage.tokens,
        context: typeof status?.contextTokens === 'number' ? status.contextTokens : usage.context,
        window: typeof status?.contextWindow === 'number' ? status.contextWindow : usage.window,
      };
      if (running === true && !waitingForAgent && !responding) {
        waitingForAgent = true;
        stdout.write('… Thinking…\n');
      }
      if (running === false) {
        waitingForAgent = false;
        responding = false;
      }
    }
    if (agent?.type === 'text') {
      waitingForAgent = false;
      responding = true;
    }
    if (agent?.type === 'done' || agent?.type === 'error') {
      waitingForAgent = false;
      responding = false;
    }
    if (event.type === 'interaction_request' && event.data && typeof event.data === 'object') {
      const request = event.data as { requestId?: unknown; kind?: unknown } & Record<string, unknown>;
      if (typeof request.requestId === 'string' && (request.kind === 'permission' || request.kind === 'plan_review')) {
        pendingInteractions.set(request.requestId, { kind: request.kind, data: request });
        stdout.write(`\nApproval needed: ${interactionSummary(request)}\nRun /approve to choose.\n`);
        return;
      }
    }
    const text = eventText(event);
    if (text) stdout.write(`${text}\n`);
  };
  const consumeEvent = (event: { sequence: number; type: string; data: unknown }): void => {
    if (event.sequence <= after) return;
    after = event.sequence;
    if (pollingPaused) deferredEvents.push(event); else renderEvent(event);
  };
  const flushDeferredEvents = (): void => {
    while (deferredEvents.length > 0) renderEvent(deferredEvents.shift()!);
  };
  const refreshEvents = async (): Promise<void> => {
    const events = await rpc(socketFile, 'session.events', { sessionId, afterSequence: after, limit: 1_000 }, controller) as Array<{
      sequence: number; type: string; data: unknown;
    }>;
    events.forEach(consumeEvent);
  };
  let stream: SessionEventSubscription | undefined;
  let streamStopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let streamConnectedOnce = false;
  const connectStream = async (): Promise<void> => new Promise<void>((resolve, reject) => {
    let acknowledged = false;
    stream = subscribeSessionEvents(socketFile, sessionId, after, {
      onReady: () => {
        acknowledged = true;
        streamConnectedOnce = true;
        reconnectAttempt = 0;
        resolve();
      },
      onEvent: consumeEvent,
      onDisconnect: (error) => {
        if (streamStopped) return;
        if (!acknowledged) {
          if (!streamConnectedOnce) {
            reject(error ?? new Error('Cindy event stream disconnected before it was ready'));
            return;
          }
          const delay = Math.min(5_000, 250 * (2 ** reconnectAttempt++));
          reconnectTimer = setTimeout(() => { void connectStream().catch(() => undefined); }, delay);
          return;
        }
        const delay = Math.min(5_000, 250 * (2 ** reconnectAttempt++));
        stdout.write(`\nCindy connection interrupted; reconnecting…${error ? ` (${error.message})` : ''}\n`);
        reconnectTimer = setTimeout(() => { void connectStream().catch(() => undefined); }, delay);
      },
    });
  });
  try {
    await connectStream();
    for (;;) {
      let answer: string;
      try {
        answer = await rl.question('› ');
      } catch (error) {
        // readline rejects its pending question on EOF (common on an SSH
        // disconnect).  Leaving the terminal must not turn that normal
        // condition into a stack trace, and the finally block below releases
        // only this terminal's controller claim.
        if (isReadlineEof(error)) return;
        throw error;
      }
      const line = answer.trim();
      if (!line) continue;
      // Slash commands match the Codex CLI convention.  Keep colon aliases
      // for existing muscle memory, but only advertise the slash form.
      const command = line.startsWith(':') ? `/${line.slice(1)}` : line;
      if (command === '/quit' || command === '/q') return undefined;
      if (command === '/help') {
        printHelp();
        continue;
      }
      if (command === '/settings') {
        pollingPaused = true;
        try {
          await openSettings(rl, socketFile, sessionId, controller);
        } catch (error) {
          stdout.write(`\nUnable to update settings; the session is unchanged: ${error instanceof Error ? error.message : String(error)}\n`);
        } finally {
          pollingPaused = false;
          flushDeferredEvents();
        }
        continue;
      }
      if (command === '/clear') {
        const current = await rpc(socketFile, 'session.get', { sessionId }, controller) as SessionView;
        renderSessionChrome(current, true);
        continue;
      }
      if (command === '/events') {
        await refreshEvents();
        continue;
      }
      if (command === '/sessions') {
        const sessions = await listResumableSessions(socketFile, controller);
        sessions.forEach((item, index) => stdout.write(`  ${index + 1}. ${item.title} · ${item.model} · ${item.id.slice(0, 8)}\n`));
        stdout.write('Use /resume to switch.\n');
        continue;
      }
      if (command === '/resume') {
        const sessions = await listResumableSessions(socketFile, controller);
        if (sessions.length === 0) {
          stdout.write('No active sessions to resume.\n');
          continue;
        }
        const selected = await choose(rl, 'Resume session', sessions, (item) => `${item.title} · ${item.model} · ${item.id.slice(0, 8)}`);
        if (selected.id === sessionId) {
          stdout.write('Already in this session.\n');
          continue;
        }
        return selected.id;
      }
      if (command === '/status') {
        stdout.write(`${formatUsage(usage)}\n`);
        continue;
      }
      if (command === '/stop') {
        await rpc(socketFile, 'session.abort', { sessionId }, controller);
        continue;
      }
      if (command.startsWith('/steer ')) {
        const content = command.slice('/steer '.length).trim();
        if (!content) throw new Error('Usage: /steer <message>');
        await rpc(socketFile, 'session.steer', { sessionId, content }, controller);
        continue;
      }
      if (command.startsWith('/attach ') || command.startsWith('/image ')) {
        const image = command.startsWith('/image ');
        const attachmentPath = command.slice(image ? '/image '.length : '/attach '.length).trim();
        if (!attachmentPath.startsWith('/')) throw new Error('Attachment paths must be absolute.');
        pendingAttachments.push({ type: image ? 'image' : 'file', path: attachmentPath });
        stdout.write(`Attached for next message: ${attachmentPath}\n`);
        continue;
      }
      if (command === '/attachments') {
        if (pendingAttachments.length === 0) stdout.write('No pending attachments.\n');
        else pendingAttachments.forEach((item, index) => stdout.write(`  ${index + 1}. ${item.type} · ${item.path}\n`));
        continue;
      }
      if (command === '/attachments clear') {
        pendingAttachments.splice(0);
        stdout.write('Pending attachments cleared.\n');
        continue;
      }
      if (command.startsWith('/model ')) {
        await configureInteractiveSession(socketFile, sessionId, { model: command.slice('/model '.length).trim() }, controller);
        continue;
      }
      if (command.startsWith('/agent ')) {
        const [agentKind, model, providerId] = command.slice('/agent '.length).trim().split(/\s+/, 3);
        if (!agentKind || !model || (agentKind !== 'codex' && agentKind !== 'claude-code')) {
          throw new Error('Use /settings to choose an agent and model.');
        }
        await configureInteractiveSession(socketFile, sessionId, {
          agentKind, model, ...(providerId ? { providerId: providerId === 'default' ? null : providerId } : {}),
        }, controller);
        continue;
      }
      if (command.startsWith('/provider ')) {
        const provider = command.slice('/provider '.length).trim();
        await configureInteractiveSession(socketFile, sessionId, { providerId: provider === 'default' ? null : provider }, controller);
        continue;
      }
      if (command.startsWith('/effort ')) {
        await configureInteractiveSession(socketFile, sessionId, { effort: command.slice('/effort '.length).trim() }, controller);
        continue;
      }
      if (command.startsWith('/permission ')) {
        await configureInteractiveSession(socketFile, sessionId, { permissionMode: command.slice('/permission '.length).trim() }, controller);
        continue;
      }
      if (command === '/approve') {
        const choices = [...pendingInteractions.entries()];
        if (choices.length === 0) {
          stdout.write('No pending approvals.\n');
          continue;
        }
        const selected = await choose(rl, 'Approve request', choices, ([requestId, request]) => `${request.kind} · ${interactionSummary(request.data)} · ${requestId.slice(0, 8)}`);
        const behavior = await choose(rl, 'Decision', ['allow', 'deny'], (item) => item === 'allow' ? 'Allow' : 'Deny');
        await rpc(socketFile, 'session.interaction.resolve', {
          sessionId, requestId: selected[0], decision: { kind: selected[1].kind, behavior },
        }, controller);
        pendingInteractions.delete(selected[0]);
        stdout.write(`${behavior === 'allow' ? 'Approved' : 'Denied'}.\n`);
        continue;
      }
      if (command.startsWith('/approve ')) {
        const [requestId, behavior] = command.slice('/approve '.length).trim().split(/\s+/, 2);
        if (!requestId || (behavior !== 'allow' && behavior !== 'deny')) throw new Error('Usage: /approve <request-id> <allow|deny>');
        const events = await rpc(socketFile, 'session.events', { sessionId, afterSequence: 0, limit: 1_000 }, controller) as Array<{ type: string; data: unknown }>;
        const request = events.find((event) => event.type === 'interaction_request'
          && event.data && typeof event.data === 'object'
          && (event.data as { requestId?: unknown }).requestId === requestId)?.data as { kind?: unknown } | undefined;
        if (request?.kind !== 'permission' && request?.kind !== 'plan_review') {
          throw new Error('Only permission and plan-review requests can be resolved from the terminal command');
        }
        await rpc(socketFile, 'session.interaction.resolve', {
          sessionId, requestId, decision: { kind: request.kind, behavior },
        }, controller);
        continue;
      }
      const content = pendingAttachments.length > 0
        ? { type: 'user', content: [{ type: 'text', text: line }, ...pendingAttachments.splice(0)] }
        : line;
      await rpc(socketFile, 'session.send', { sessionId, content }, controller);
      responding = false;
      if (!waitingForAgent) {
        waitingForAgent = true;
        stdout.write('… Thinking…\n');
      }
    }
  } finally {
    streamStopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    stream?.close();
  }
}

async function defaultWorkspace(socketFile: string): Promise<{ workDir: string; workspaceKind: 'project' | 'dialogue' }> {
  const current = cwd();
  const roots = await rpc(socketFile, 'workdir.list') as string[];
  const allowed = roots.some((root) => current === root || current.startsWith(`${root}/`));
  return allowed ? { workDir: current, workspaceKind: 'project' } : { workDir: '', workspaceKind: 'dialogue' };
}

export function formatSessionHeader(session: SessionView): string {
  const place = session.workDir || 'Dialogue';
  const provider = session.providerId ?? 'default';
  return [
    '╭─ Cindy ─────────────────────────────────────────────────────────────',
    `│ ${place} · ${session.agentKind} · ${provider} · ${session.model}`,
    `│ ${session.effort ?? 'high'} · ${session.permissionMode ?? 'ask'}   /help · /settings`,
    '╰────────────────────────────────────────────────────────────────────',
  ].join('\n');
}

function renderSessionChrome(session: SessionView, clear = false, _preview?: CreatePreview): void {
  if (clear) stdout.write('\x1b[2J\x1b[H');
  stdout.write(`${formatSessionHeader(session)}\n\n`);
}

function printHelp(): void {
  stdout.write('\n  /settings  choose model, provider, effort and permissions\n');
  stdout.write('  /sessions  list sessions    /resume  switch to a recent session\n');
  stdout.write('  /approve   choose a pending approval    /status  show context and usage\n');
  stdout.write('  /attach <absolute-path>  attach a file to your next message\n');
  stdout.write('  /image <absolute-path>   attach an image    /attachments [clear]\n');
  stdout.write('  /steer <text>  redirect current turn    /stop  stop current turn\n');
  stdout.write('  /events    refresh output                  /clear redraw\n');
  stdout.write('  /quit      leave terminal (session keeps running)\n\n');
}

async function listResumableSessions(socketFile: string, controller: SessionController): Promise<Array<SessionView & { title: string; status?: string }>> {
  const sessions = await rpc(socketFile, 'session.list', undefined, controller) as Array<SessionView & { title: string; status?: string }>;
  return sessions.filter((session) => session.status !== 'archived' && session.status !== 'deleted');
}

function interactionSummary(request: Record<string, unknown>): string {
  const title = typeof request.title === 'string' ? request.title
    : typeof request.description === 'string' ? request.description
      : typeof request.command === 'string' ? request.command
        : typeof request.path === 'string' ? request.path : 'Agent requests your decision';
  return title.replace(/\s+/g, ' ').slice(0, 180);
}

function formatUsage(usage: { tokens?: number; context?: number; window?: number }): string {
  const tokens = usage.tokens === undefined ? 'usage pending' : `${usage.tokens.toLocaleString()} tokens`;
  if (!usage.context || !usage.window) return `Status: ${tokens}`;
  const percentage = ((usage.context / usage.window) * 100).toFixed(1);
  return `Status: ${tokens} · context ${usage.context.toLocaleString()} / ${usage.window.toLocaleString()} (${percentage}%)`;
}

async function openSettings(
  rl: ReturnType<typeof createInterface>, socketFile: string, sessionId: string, controller: SessionController,
): Promise<void> {
  for (;;) {
    const current = await rpc(socketFile, 'session.get', { sessionId }, controller) as SessionView;
    stdout.write(`\n${formatSessionHeader(current)}\n`);
    const action = await choose(rl, 'Settings', [
      'Model', 'Provider', 'Agent (also choose provider and model)', 'Reasoning effort', 'Permission mode', 'Save as defaults', 'Done',
    ]);
    if (action === 'Done') return;
    if (action === 'Model') {
      const model = await selectModel(rl, socketFile, current.agentKind, current.providerId, current.model);
      await configureInteractiveSession(socketFile, sessionId, { model: model.id }, controller);
    } else if (action === 'Provider') {
      const provider = await selectProvider(rl, socketFile, current.agentKind, current.providerId);
      const model = await selectModel(rl, socketFile, current.agentKind, provider.id);
      await configureInteractiveSession(socketFile, sessionId, { providerId: provider.id, model: model.id }, controller);
    } else if (action === 'Agent (also choose provider and model)') {
      const agentKind = await choose(rl, 'Agent', ['codex', 'claude-code'], undefined, current.agentKind);
      const provider = await selectProvider(rl, socketFile, agentKind);
      const model = await selectModel(rl, socketFile, agentKind, provider.id);
      await configureInteractiveSession(socketFile, sessionId, { agentKind, providerId: provider.id, model: model.id }, controller);
    } else if (action === 'Reasoning effort') {
      const effort = await choose(rl, 'Reasoning effort', ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], undefined, current.effort);
      await configureInteractiveSession(socketFile, sessionId, { effort }, controller);
    } else if (action === 'Permission mode') {
      const permissionMode = await choose(rl, 'Permission mode', ['ask', 'default', 'acceptEdits', 'plan', 'auto'], undefined, current.permissionMode);
      await configureInteractiveSession(socketFile, sessionId, { permissionMode }, controller);
    } else {
      await rpc(socketFile, 'config.defaults.set', {
        agentKind: current.agentKind, providerId: current.providerId ?? null, model: current.model,
        effort: current.effort, permissionMode: current.permissionMode,
      }, controller);
      stdout.write('Saved as your default settings.\n');
    }
  }
}

async function selectProvider(
  rl: ReturnType<typeof createInterface>, socketFile: string, agentKind: string, currentId?: string,
): Promise<ProviderOption> {
  const providers = await rpc(socketFile, 'catalog.providers', { agentKind }) as ProviderOption[];
  const connected = providers.filter((provider) => provider.credentialConfigured);
  if (connected.length === 0) {
    const account = await rpc(socketFile, 'account.status') as { authenticated?: unknown; error?: unknown };
    throw new Error(noConfiguredProviderMessage(agentKind, account));
  }
  return choose(rl, 'Provider', connected, (item) => `${item.name} (${item.id})`, currentId, (item) => item.id);
}

async function selectModel(
  rl: ReturnType<typeof createInterface>, socketFile: string, agentKind: string, providerId?: string, currentId?: string,
): Promise<ModelOption> {
  const models = await rpc(socketFile, 'catalog.models', { agentKind, ...(providerId ? { providerId } : {}) }) as ModelOption[];
  if (models.length === 0) throw new Error(`No models are available for ${agentKind}.`);
  return choose(rl, 'Model', models, (item) => `${item.name} (${item.id})`, currentId, (item) => item.id);
}

async function configureInteractiveSession(
  socketFile: string,
  sessionId: string,
  patch: Record<string, unknown>,
  controller: SessionController,
): Promise<void> {
  await rpc(socketFile, 'session.configure', { sessionId, ...patch }, controller);
}

async function rpc(socketFile: string, method: string, params?: unknown, controller?: SessionController): Promise<unknown> {
  const result = await requestControl(socketFile, { id: randomUUID(), method, params, controller }) as RpcResult;
  if (!result.ok) throw new Error(result.error?.message ?? `Control request failed: ${method}`);
  return result.result;
}

async function choose<T>(
  rl: ReturnType<typeof createInterface>,
  label: string,
  choices: readonly T[],
  display: (item: T) => string = (item) => String(item),
  defaultValue?: string,
  value: (item: T) => string = (item) => String(item),
): Promise<T> {
  choices.forEach((item, index) => stdout.write(`  ${index + 1}. ${display(item)}\n`));
  const fallbackIndex = Math.max(0, defaultValue ? choices.findIndex((item) => value(item) === defaultValue) : 0);
  const answer = (await rl.question(`${label} [${fallbackIndex + 1}]: `)).trim();
  const index = answer ? Number(answer) - 1 : fallbackIndex;
  if (!Number.isInteger(index) || index < 0 || index >= choices.length) throw new Error(`Invalid ${label} selection.`);
  return choices[index];
}

/** Formats persisted agent events for the terminal without exposing raw protocol payloads. */
export function eventText(event: { type: string; data: unknown }): string | null {
  if (event.type === 'user_message') return null;
  if (event.type === 'agent_event' && event.data && typeof event.data === 'object') {
    const agent = event.data as { type?: unknown; data?: unknown };
    if (agent.type === 'text') {
      const text = eventTextValue(agent.data);
      return text || null;
    }
    if (agent.type === 'thinking') {
      // Codex persists thinking lifecycle objects. Only print deltas: start
      // has no content and final repeats the last delta verbatim.
      const thinking = agent.data as { stage?: unknown } | null;
      if (thinking && typeof thinking === 'object' && thinking.stage !== undefined && thinking.stage !== 'delta') return null;
      const text = eventTextValue(agent.data);
      return text ? `… ${text}` : null;
    }
    if (agent.type === 'tool_use') return `↳ tool ${format(agent.data)}`;
    if (agent.type === 'tool_result') return `↳ result ${format(agent.data)}`;
    if (agent.type === 'error') return `Error: ${format(agent.data)}`;
  }
  if (event.type === 'interaction_request') return `Approval needed: ${format(event.data)}`;
  return null;
}

function eventTextValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = (value as { text?: unknown }).text;
  return typeof text === 'string' && text.length > 0 ? text : null;
}

function agentEvent(event: { type: string; data: unknown }): { type?: string; data?: unknown } | null {
  if (event.type !== 'agent_event' || !event.data || typeof event.data !== 'object') return null;
  return event.data as { type?: string; data?: unknown };
}

export function noConfiguredProviderMessage(
  agentKind: string,
  account: { authenticated?: unknown; error?: unknown },
): string {
  if (account.authenticated === true) {
    return `No configured ${agentKind} provider. Import a provider credential first.`;
  }
  const reason = typeof account.error === 'string' && account.error.trim()
    ? ` (${account.error.trim()})`
    : '';
  return [
    `No configured ${agentKind} provider because the Cindy account is not connected${reason}.`,
    'Run `cindy login --sso XD` to use Cindy XD Gateway, or import a separate provider credential.',
  ].join(' ');
}

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function isReadlineEof(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return (name === 'AbortError' && code === 'ABORT_ERR') || code === 'ERR_USE_AFTER_CLOSE';
}
