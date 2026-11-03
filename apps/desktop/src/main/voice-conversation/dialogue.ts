import { VoiceCallContext, type VoiceCallRecord } from '@cindy/maker-core';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { createMessage, broadcastMessageAgentMetaUpdate } from '../localDb/ipc/messages.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { formatForwardedRequest } from '../maker-ipc/forwardedRequest.js';
import { extractText as extractStoredMessageText } from '../sessionTaskSummary.logic.js';
import { requestExplicitUtilityText } from '../utility-model/oneShotCandidates.js';
import { readVoiceCompanionRoute } from './semanticExit.js';
import { dispatchVoiceTask, readVoiceCallMemory } from './taskBridge.js';
import { createLogger } from '../logger.js';

const log = createLogger('voice-conversation');

/** Owner-bound call adapter. Transcript bytes live only in the call card's
 * metadata, not ordinary chat text, model handoff history or memory learning. */
export class CompanionCallDialogue {
  private context: VoiceCallContext | undefined;
  private readonly db = getCurrentDbClientSnapshot();
  private readonly owner = activeOwnerScopeKey();
  private readonly broadcastScope = captureDataOwnerBroadcastScope();
  private saveTail: Promise<unknown> = Promise.resolve();
  private saved = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;
  private clearBoundary: number | null = null;
  private polling = false;
  private knownInputs = new Map<string, string>();

  constructor(
    private readonly input: {
      callId: string;
      botId: string;
      sessionId: string;
      emit(record: VoiceCallRecord): void;
    },
  ) {}

  private current = (): boolean =>
    !isAppSessionBoundaryPending() &&
    this.owner === activeOwnerScopeKey() &&
    this.db === getCurrentDbClientSnapshot();

  private assertCurrent = (): void => {
    if (!this.current()) throw new Error('call_owner_changed');
  };

  private assertActive = (): void => {
    this.assertCurrent();
    if (this.ended) throw new Error('call_ended');
  };

  async start(): Promise<void> {
    this.assertActive();
    const route = await readVoiceCompanionRoute(this.input.botId, this.input.sessionId);
    if (!route || !this.db) throw new Error('call_model_unavailable');
    const profile = await this.db.client.queryOne<{
      name: string;
      identity: string;
      configuration: string;
      clearedAt: number | null;
    }>(
      `SELECT p.display_name AS name, v.identity_source AS identity, v.capabilities_json AS configuration,
        s.cleared_at AS clearedAt FROM bot_profiles p
        JOIN bot_profile_versions v ON v.bot_id = p.id AND v.version = p.current_version
        JOIN sessions s ON s.id = p.canonical_session_id
        WHERE p.id = ? AND s.id = ?`,
      [this.input.botId, this.input.sessionId],
    );
    if (!profile) throw new Error('call_profile_unavailable');
    this.clearBoundary = profile.clearedAt;
    const recent = await this.db.client.query<{ role: string; content: string }>(
      `SELECT role, content FROM messages WHERE session_id = ? AND rewind_at IS NULL
        AND role IN ('user','assistant') AND content NOT IN ('','""')
        AND (? IS NULL OR created_at > ?) ORDER BY created_at DESC LIMIT 12`,
      [this.input.sessionId, this.clearBoundary, this.clearBoundary],
    );
    this.assertActive();
    let userContext = '';
    let memory = '';
    try {
      const config = JSON.parse(profile.configuration) as {
        userContextSource?: unknown;
        memory?: boolean;
      };
      if (typeof config.userContextSource === 'string')
        userContext = config.userContextSource.slice(0, 16_000);
      if (config.memory !== false)
        memory = (await readVoiceCallMemory(this.input.botId)).slice(0, 16_000);
    } catch {
      /* Identity still works with an old incomplete profile. */
    }
    this.assertActive();
    this.context = new VoiceCallContext({
      callId: this.input.callId,
      identity: `${profile.name}\n${profile.identity}\n${userContext}`.slice(0, 32_000),
      reference: JSON.stringify({ mainChat: recent.reverse(), memoryIndex: memory }).slice(-40_000),
      generate: async (prompt, systemPrompt, signal, onText) => {
        const result = await requestExplicitUtilityText(prompt, {
          ...route,
          systemPrompt,
          signal,
          maxTokens: 4_096,
          timeoutMs: 60_000,
          disableReasoning: true,
          onText,
          beforeDispatch: async () => {
            if (!this.current() || this.ended) return false;
            const latest = await readVoiceCompanionRoute(this.input.botId, this.input.sessionId);
            return (
              this.current() && !this.ended && JSON.stringify(latest) === JSON.stringify(route)
            );
          },
        });
        if (!result.ok) throw new Error('call_response_failed');
        return result.text;
      },
      handoff: async ({ id, inputId, original, supplement }) => {
        this.assertCurrent();
        if (this.ended) return false;
        const source = { userText: original, sessionId: this.input.sessionId, clientId: inputId };
        const validate = async () => {
          this.assertCurrent();
          if (this.ended) throw new Error('call_ended');
          const row = await this.db!.client.queryOne<{ clearedAt: number | null }>(
            'SELECT cleared_at AS clearedAt FROM sessions WHERE id = ?',
            [this.input.sessionId],
          );
          if (
            !row ||
            row.clearedAt !== this.clearBoundary ||
            !(await readVoiceCompanionRoute(this.input.botId, this.input.sessionId))
          )
            throw new Error('call_binding_changed');
          this.assertCurrent();
        };
        const accepted = await dispatchVoiceTask({
          targetSessionId: this.input.sessionId,
          clientId: id,
          message: formatForwardedRequest(source, supplement),
          persistedContent: original,
          autoReviewUserText: { kind: 'agent-request', request: source },
          resumeWithStoredPermissionMode: true,
          authorizationGuard: { validate, assertCurrent: this.assertActive },
        });
        log.info('call task handoff', { callId: this.input.callId, clientId: id, accepted });
        if (accepted && !this.ended) this.schedulePoll();
        return accepted;
      },
      changed: (record) => {
        if (this.current()) this.input.emit(record);
        // Serialize snapshots so an older streaming update cannot overwrite the
        // terminal record. Save only complete turns / handoff changes.
        if (record.turns.at(-1)?.complete !== false || record.endedAt) this.save(record);
      },
    });
    this.save(this.context.record);
    await this.saveTail;
    this.assertActive();
    if (!this.saved) throw new Error('call_record_unavailable');
    this.input.emit(this.context.record);
  }

  private save(record: VoiceCallRecord): void {
    const snapshot = structuredClone(record);
    let stage: 'owner' | 'insert' | 'update' | 'publish' = 'owner';
    this.saveTail = this.saveTail
      .catch(() => undefined)
      .then(async () => {
        this.assertCurrent();
        const id = `voice-call:${this.input.callId}`;
        stage = 'insert';
        await createMessage(
          this.input.sessionId,
          {
            clientId: id,
            role: 'assistant',
            content: '',
            createdAt: record.startedAt,
            agentMeta: { voiceCall: snapshot },
          },
          {
            broadcastOwnerScope: this.broadcastScope,
            expectedClearBoundaryMs: this.clearBoundary,
            // createMessage captures this owner's DbClient synchronously and
            // checks /clear atomically in message.insert. Its staged publication
            // callback cannot be combined with that guard. Fence broadcasts by
            // both owner and DB generation, then recheck before the next write.
            shouldBroadcast: this.current,
          },
        );
        this.assertCurrent();
        stage = 'update';
        const result = await this.db!.client.exec(
          `UPDATE messages SET agent_meta = json_set(COALESCE(agent_meta, '{}'), '$.voiceCall', json(?))
          WHERE session_id = ? AND client_id = ? AND rewind_at IS NULL
          AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND cleared_at IS ?)`,
          [
            JSON.stringify(snapshot),
            this.input.sessionId,
            id,
            this.input.sessionId,
            this.clearBoundary,
          ],
        );
        this.assertCurrent();
        if (!result.changes) return;
        this.saved = true;
        stage = 'publish';
        await broadcastMessageAgentMetaUpdate(this.input.sessionId, id, this.broadcastScope);
      })
      .catch((error: unknown) => {
        // Only controlled classifications: database errors can contain SQL,
        // transcript values or paths and must not enter diagnostics verbatim.
        const ownerCurrent = this.current();
        const cleared = typeof error === 'object' && error !== null &&
          'code' in error && error.code === 'REMOTE_OPTIMISTIC_INPUT_CLEARED';
        log.warn('call record persistence failed', {
          callId: this.input.callId,
          ownerCurrent,
          stage,
          reason: !ownerCurrent ? 'owner_changed' : cleared ? 'cleared' : 'storage_failed',
        });
      });
  }

  async submit(id: string, text: string, forceHandoff: boolean): Promise<boolean> {
    this.assertCurrent();
    if (this.ended || !this.context || !text.trim() || this.context.record.turns.length >= 2_000)
      return false;
    const previous = this.knownInputs.get(id);
    if (previous !== undefined && previous !== text) return false;
    this.knownInputs.set(id, text);
    const result = this.context.submit(id, text, forceHandoff);
    // Ordinary input is accepted into the call immediately. Generation failure
    // is reported through its owned transcript, never by holding the mic queue.
    return forceHandoff ? result : true;
  }

  promote(id: string): Promise<boolean> {
    this.assertCurrent();
    return this.ended
      ? Promise.resolve(false)
      : (this.context?.promote(id) ?? Promise.resolve(false));
  }

  private schedulePoll(): void {
    if (this.ended || this.timer || this.polling || !this.current()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, 600);
  }

  private async poll(): Promise<void> {
    this.polling = true;
    try {
      if (!this.current() || this.ended || !this.context || !this.db) return;
      for (const task of this.context.record.handoffs.filter((item) => item.state === 'accepted')) {
        // Background tasks inherit the protected user-source receipt. Match
        // that provenance, never titles, text similarity or the latest child.
        const delegated = await this.db.client.query<{ status: string; result: string | null }>(
          `SELECT status, result_summary AS result FROM bot_delegations
            WHERE parent_session_id = ?
              AND json_extract(permission_snapshot_json, '$.taskInput.requestSource.sessionId') = ?
              AND json_extract(permission_snapshot_json, '$.taskInput.requestSource.clientId') = ?`,
          [this.input.sessionId, this.input.sessionId, task.inputId],
        );
        if (!this.current() || this.ended) return;
        if (delegated.length) {
          if (
            delegated.every((item) =>
              ['completed', 'failed', 'cancelled', 'timed-out'].includes(item.status),
            )
          ) {
            this.context.deliverResult(task.id, JSON.stringify(delegated).slice(0, 32_000));
          }
          continue;
        }
        // Observe only the canonical reply after this exact accepted input,
        // stopping at the next user input. Unrelated replies cannot flow back.
        const rows = await this.db.client.query<{
          role: string;
          content: string;
          meta: string | null;
        }>(
          `SELECT m.role, m.content, m.agent_meta AS meta FROM messages m
            WHERE m.session_id = ? AND m.rewind_at IS NULL AND m.rowid >
              (SELECT rowid FROM messages WHERE session_id = ? AND client_id = ?)
            ORDER BY m.rowid LIMIT 200`,
          [this.input.sessionId, this.input.sessionId, task.id],
        );
        if (!this.current() || this.ended) return;
        for (const row of rows) {
          if (row.role === 'user') break;
          if (row.role === 'error') {
            this.context.deliverResult(
              task.id,
              JSON.stringify({
                status: 'failed',
                message: 'The task did not complete. Details are in the main chat.',
              }),
            );
            break;
          }
          if (row.role !== 'assistant') continue;
          try {
            const meta = JSON.parse(row.meta ?? '{}') as Record<string, unknown>;
            if (
              meta.turnCompleted !== true ||
              meta.voiceCall ||
              meta.assistantPhase === 'commentary'
            )
              continue;
            // The message writer stores strings verbatim; older rows can be
            // JSON-encoded strings. Use the existing text reader for both.
            const content = extractStoredMessageText(row.content, row.role);
            if (content.trim()) {
              this.context.deliverResult(task.id, content.slice(0, 32_000));
              break;
            }
          } catch {
            /* Wait for a complete canonical result. */
          }
        }
      }
    } catch {
      log.warn('call result observation failed', { callId: this.input.callId });
    } finally {
      this.polling = false;
      if (this.context?.record.handoffs.some((item) => item.state === 'accepted'))
        this.schedulePoll();
    }
  }

  async end(): Promise<void> {
    this.ended = true;
    clearTimeout(this.timer);
    this.context?.end();
    await this.saveTail;
  }
}
