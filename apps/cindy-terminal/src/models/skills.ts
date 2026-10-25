import { Maker, ClaudeCodeAgent, CodexAgent, PiAgent, type AgentKind, type AuthAdapter, type BaseAgent, type ListAgentSkillsOptions, type Logger } from '@cindy/maker-core';
import { nativeAuthState } from './runtime.js';
import type { TerminalCapabilities } from '../tasks/capabilities.js';
import type { TerminalSshService } from '../ssh.js';
import type { TerminalSshRuntime } from '../tasks/ssh-runtime.js';

/** Discovery uses the native agent's original Skill API and Maker filtering.
 * It opens no task, inference proxy or model request. The owner retires every
 * discovery process before its SSH pool or account storage closes. */
export function createTerminalSkillReader(host: {
  profileDir: string;
  storage: ConstructorParameters<typeof Maker>[0]['storage'];
  logger: Logger;
  capabilities: TerminalCapabilities;
  binary(kind: AgentKind): string | null;
  ssh?: TerminalSshService;
  sshRuntime?: TerminalSshRuntime;
  assertCurrent(): void;
}) {
  const agents = new Set<BaseAgent>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  const guard = () => { host.assertCurrent(); if (closed) throw new Error('SKILL_READER_CLOSED'); };
  async function read(kind: AgentKind, options: ListAgentSkillsOptions) {
    guard();
    const binaryPath = host.binary(kind);
    if (!binaryPath) throw new Error('ENGINE_NOT_INSTALLED');
    const remoteCodex = kind === 'codex' && options.remoteHostId;
    if (options.remoteHostId && !host.ssh) throw new Error('SSH_RUNTIME_UNAVAILABLE');
    if (remoteCodex) {
      if (!host.sshRuntime) throw new Error('SSH_RUNTIME_UNAVAILABLE');
      await host.sshRuntime.prepare('codex', remoteCodex); guard();
    }
    const auth: AuthAdapter = remoteCodex ? host.ssh!.codexAuth(remoteCodex) : {
      getState: () => nativeAuthState(kind, binaryPath), getAuthEnv: async () => ({}),
      triggerLogin: async () => { throw new Error('USE_NATIVE_CLI_LOGIN'); },
      logout: async () => { throw new Error('USE_NATIVE_CLI_LOGOUT'); },
    };
    const deps = {
      binaryPath, auth, logger: host.logger, runtimeConfig: { userDataPath: host.profileDir },
      getManagedSkills: () => host.capabilities.managed(options.remoteHostId ? [] : options.workingDir ? [options.workingDir] : []),
      getDisabledSkillPaths: () => host.capabilities.disabledSkillPaths(),
      getRemoteAgentFileOps: host.ssh?.pi.getRemoteAgentFileOps,
    };
    const agent = kind === 'claude-code' ? new ClaudeCodeAgent(deps)
      : kind === 'pi' ? new PiAgent(deps)
      : new CodexAgent({ ...deps, ...(remoteCodex ? {
        ...host.ssh!.codex,
        prepareCodexExtraSpawnConfig: async () => {
          guard(); if (!host.sshRuntime) throw new Error('SSH_RUNTIME_UNAVAILABLE');
          return host.sshRuntime.codexSpawn(remoteCodex);
        },
      } : {}) });
    agents.add(agent);
    try {
      const maker = new Maker({ agents: { [kind]: agent }, storage: host.storage, logger: host.logger });
      const result = await maker.listAgentSkills(kind, options);
      guard(); return result;
    } finally { agents.delete(agent); await agent.dispose(); }
  }
  return {
    listAgentSkills(kind: AgentKind, options: ListAgentSkillsOptions) {
      const work = read(kind, options); pending.add(work);
      void work.finally(() => pending.delete(work)).catch(() => {});
      return work;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...agents].map(agent => agent.dispose()));
      await Promise.allSettled([...pending]);
    },
  };
}
