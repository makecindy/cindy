import { RUNTIME_DIRECTORY, terminalNodeExecutable } from './version.js';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AgentSessionHandle, AgentSessionTeardownReason, BaseAgent, Logger, PiSubagentRunnerLaunchRequest, PiSubagentRunnerProcess} from '@cindy/maker-core';
import {spawnPiSubagentRunner as spawnOriginalRunner} from '@cindy/app-runtime/piSubagentRunnerHost';

/** Use the original runner protocol through Node's process port. */
export function spawnTerminalPiSubagent(request: PiSubagentRunnerLaunchRequest, entry = path.join(RUNTIME_DIRECTORY,'pi-subagent-process.cjs')) {
  return spawnOriginalRunner(request, (file, args, options) => spawn(terminalNodeExecutable(), [file, ...args], {
    cwd: options.cwd, env: options.env, windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  }), entry);
}

type OwnedRuntime = {
  close(reason: AgentSessionTeardownReason): Promise<void>;
};

/** A daemon owns native agents. Closing a per-task Maker releases its reference,
 * while the original Pi runtime keeps its detached runners and proxy leases.
 * Retire the agent when its actual processes exit; logout closes all handles
 * through the original account-boundary teardown before releasing credentials. */
export class TerminalPiRuntimeOwner {
  private readonly runtimes = new Set<OwnedRuntime>();
  private closing?: Promise<void>;
  private closeReason?: AgentSessionTeardownReason;
  constructor(private readonly logger: Logger) {}

  scope(spawn = spawnTerminalPiSubagent) {
    if (this.closing) throw new Error('Pi runtime owner is closed');
    const runners = new Set<PiSubagentRunnerProcess>();
    const handles = new Set<AgentSessionHandle>();
    let retired = false;
    let disposeNative: (() => Promise<void>) | undefined;
    let disposal: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      if (!disposeNative) return Promise.resolve();
      if (!disposal) {
        disposal = disposeNative().then(() => { this.runtimes.delete(owned); handles.clear(); });
        void disposal.catch(() => { disposal = undefined; });
      }
      return disposal;
    };
    const owned: OwnedRuntime = {
      close: async reason => {
        retired = true;
        const results = await Promise.allSettled([...handles].map(handle => handle.close({reason})));
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        try { await dispose(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, 'Pi runtime shutdown remains unconfirmed');
      },
    };
    return {
      spawn: (request: PiSubagentRunnerLaunchRequest): PiSubagentRunnerProcess => {
        if (retired || this.closing) throw new Error('Pi runtime owner is closed');
        const runner = spawn(request);
        runners.add(runner);
        runner.once('exit', () => {
          runners.delete(runner);
          if (retired && !runners.size) void dispose().catch(error => this.logger.warn('Pi retired runtime cleanup failed', {error: String(error)}));
        });
        return runner;
      },
      attach: <T extends BaseAgent>(agent: T): T => {
        if (disposeNative) throw new Error('Pi runtime scope already attached');
        this.runtimes.add(owned);
        disposeNative = agent.dispose.bind(agent);
        const start = agent.startSession.bind(agent);
        agent.startSession = async options => {
          if (retired || this.closing) throw new Error('Pi runtime owner is closed');
          const handle = await start(options);
          if (retired || this.closing) {
            await handle.close({reason: this.closeReason ?? 'account-boundary'});
            throw new Error('Pi runtime owner is closed');
          }
          handles.add(handle);
          return handle;
        };
        agent.dispose = async () => {
          retired = true;
          if (!runners.size || this.closing) await dispose();
        };
        return agent;
      },
    };
  }

  close(reason: AgentSessionTeardownReason = 'account-boundary'): Promise<void> {
    this.closeReason ??= reason;
    if (!this.closing) this.closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...this.runtimes].map(runtime => runtime.close(reason)));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Pi runtime owner shutdown remains unconfirmed');
    });
    return this.closing;
  }
}
