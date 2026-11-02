import { MAIN_OWNED_SEND_CONTEXT, AUTO_REVIEW_SOURCE_CONTENT } from '@cindy/maker-core';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { personalRuleTargets, requirementsKey } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/requirements.js';
import type { RuleScope } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/types.js';
import { isDeepStrictEqual } from 'node:util';
import { readPersonalRuleStatus, type ApprovalRuleCommandDeps } from './approvalRuleCommandHandler.js';
import { parseRequirements, writeRequirements } from './approvalRuleWriteService.js';
import type { PersonalRuleEdit, PersonalRuleCaller, PersonalRuleResult } from '@cindy/mcps';

type LiveSession = { id: string; instanceId: string; agentKind: string; workDir: string;
  remoteHostId?: string | null; agentDeviceId?: string | null; getStatus(): string };
export type PersonalRuleChatDeps = ApprovalRuleCommandDeps & {
  getSession(id: string): LiveSession | undefined | null;
  inputIdentity?(id: string): { clientId: string } | null;
  ownerInput?(id: string): { clientId: string; authoredText?: string } | null;
  readMessage(sessionId: string, clientId: string): Promise<{ role: string; content: unknown; agentMeta?: unknown } | null>;
};
type Pending = { commit(): Promise<void> };
type CaptureInput = { sessionId: string; clientId: string; text: string; persisted: unknown; source: 'desktop' };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

// The composer persists a JSON envelope; display parsers also flatten arrays,
// references and attachments, so they are deliberately not authority readers.
function persistedOwnerText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const first = value.trimStart()[0];
  if (first !== '{' && first !== '[' && first !== '"') return value; // Historical bare text.
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  const body = record(parsed);
  if (!body || typeof body.text !== 'string'
    || Object.keys(body).some(key => !['text', 'images', 'files', 'slashCommandRanges'].includes(key))
    || !Array.isArray(body.images) || body.images.length !== 0
    || !Array.isArray(body.files) || body.files.length !== 0
    || (body.slashCommandRanges !== undefined
      && (!Array.isArray(body.slashCommandRanges) || body.slashCommandRanges.length !== 0))) return null;
  return body.text;
}

function persistedOwnerMeta(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return record(value);
  try { return record(JSON.parse(value)); } catch { return null; }
}

/** A bounded language recognizer, not permission inference. Unknown/ambiguous
 * requests stay unadopted. The complete authored message is stored verbatim. */
function keyedIntent(text: string): (Omit<PersonalRuleEdit, 'action'> & { action: 'set' | 'delete' }) | string {
  const value = text.trim();
  const remove = /^删除/.test(value);
  if (!(remove || /^记住[：:]/.test(value) || /^(?:设置|修改)[\s\S]*长期(?:规则|要求)/.test(value)
    || /^以后[\s\S]*请一直按这条长期要求/.test(value))) return 'persistent-intent-not-explicit';
  const declaration = value.replace(/^记住[：:]\s*/, '').split(/[：:]/, 1)[0]!;
  // A target is an affirmative heading field, never a key/body substring.
  const target = /^(?:记住[：:]\s*(?:(?:设置|修改)\s*)?|(?:设置|修改|删除)\s*|以后在\s*)(?:只对\s*)?(Codex|Claude Code|claude-code|CC|Pi)\s*(?:的\s*)?(?:个人|项目)/i.exec(value)?.[1];
  const targetHarness: PersonalRuleEdit['harness'] = target
    ? /codex/i.test(target) ? 'codex' : /^pi$/i.test(target) ? 'pi' : 'claude-code' : undefined;
  const personal = /个人/.test(declaration), project = /项目/.test(declaration);
  if (personal === project) return 'explicit-single-scope-required';
  const keys = [...value.matchAll(/\bkey\s+([a-z][a-z0-9_-]{0,63})(?![a-z0-9_-])/g)];
  if (keys.length !== 1) return 'explicit-key-required';
  if (!/规则|要求/.test(value)) return 'rule-intent-required';
  // Every supported write form needs an affirmative declaration up to the
  // body delimiter. Discussion/prohibition headings stay unadopted; body
  // negations (e.g. “不要执行危险命令”) remain verbatim rule content.
  const directWrite = /^(?:记住[：:]\s*(?:(?:设置|修改)\s*)?|(?:设置|修改)\s*)(?:(?:只对\s*)?(?:Codex|Claude Code|claude-code|CC|Pi)\s*(?:的\s*)?)?(?:个人|项目)\s*(?:Auto\s*)?(?:长期)?(?:规则|要求)\s*(?:[，,]\s*(?:设置|修改)\s*)?(?:[（(]\s*)?key\s+[a-z][a-z0-9_-]{0,63}\s*[）)]?\s*[：:]/i.test(value);
  const futureWrite = /^以后在\s*(?:(?:Codex|Claude Code|claude-code|CC|Pi)\s*(?:的\s*)?)?(?:个人|项目)\s*(?:Auto\s*)?(?:长期)?(?:规则|要求)里[，,]\s*请一直按这条长期要求执行\s*(?:[（(]\s*)?key\s+[a-z][a-z0-9_-]{0,63}\s*[）)]?\s*[：:]/i.test(value);
  if (!remove && !directWrite && !futureWrite) return 'persistent-write-not-explicit';
  if (remove && !/^删除\s*(?:(?:Codex|Claude Code|claude-code|CC|Pi)\s*(?:的)?\s*)?(?:个人|项目)\s*(?:Auto\s*)?(?:长期)?(?:规则|要求)\s*(?:[（(]\s*)?key\s+[a-z][a-z0-9_-]{0,63}\s*[）)]?\s*[。.!！]?$/i.test(value))
    return 'delete-exact-key-required';
  return { action: remove ? 'delete' : 'set', key: keys[0]![1]!,
    ...(targetHarness ? { harness: targetHarness } : {}), scope: project ? 'project' : 'user' };
}

type AuthoredRuleIntent = Omit<PersonalRuleEdit, 'action'> & { action: 'set' | 'delete'; authoredBody?: string };
const targetName = (name: string | undefined): PersonalRuleEdit['harness'] => name
  ? /codex/i.test(name) ? 'codex' : /^pi$/i.test(name) ? 'pi' : 'claude-code' : undefined;

/** Only explicit persistent operations are recognized. References identify one
 * stored body; the model never supplies replacement text or an authority span. */
function intent(text: string): AuthoredRuleIntent | string {
  const declaration = text.trim().replace(/^记住[：:]\s*/, '').split(/[：:\r\n]/, 1)[0]!;
  if (/(?:规则|要求)[\s\S]*\bkey\s/.test(declaration)) return keyedIntent(text);
  const value = text.trim();
  const reference = /^(删除|修改)\s*(?:(Codex|Claude Code|claude-code|CC|Pi)\s*(?:的\s*)?)?(个人|项目)?\s*(?:长期)?(?:规则|要求)\s*[「“]([\s\S]+?)[」”](?:\s*(?:为|改为)[：:]?([\s\S]+)|[。.!！]?)$/i.exec(value);
  if (reference) {
    const action = reference[1] === '删除' ? 'delete' : 'set';
    if ((action === 'set' && !reference[5]?.trim()) || (action === 'delete' && reference[5])) return 'persistent-write-not-explicit';
    const harness = targetName(reference[2]);
    return { action, scope: reference[3] === '项目' ? 'project' : 'user', reference: reference[4]!,
      ...(harness ? { harness } : {}), ...(action === 'set' ? { authoredBody: reference[5]! } : {}) };
  }
  if (/^修改/.test(value)) return 'existing-rule-reference-required';
  const remember = /^记住[：:]\s*([\s\S]+)$/.exec(value);
  const direct = /^(?:设置|修改)\s*((?:(?:Codex|Claude Code|claude-code|CC|Pi)\s*(?:的\s*)?)?(?:(?:个人|项目)\s*)?(?:长期)?(?:规则|要求)[：:][\s\S]+)$/i.exec(value);
  const futureScoped = /^以后在\s*([\s\S]*?(?:规则|要求))里[，,]\s*请一直按这条长期要求执行[：:]([\s\S]+)$/.exec(value);
  const future = /^以后([\s\S]+?)[，,]\s*请一直按这条长期要求(?:执行)?[。.!！]?$/.exec(value);
  let body = remember?.[1] ?? direct?.[1] ?? (futureScoped ? futureScoped[1] + '：' + futureScoped[2] : undefined)
    ?? (future ? '以后' + future[1] : undefined);
  if (!body?.trim()) return 'persistent-intent-not-explicit';
  // These are operation headings about not writing rules, not a blacklist of
  // negated rule content such as “不要执行危险命令/不要修改生产文件”.
  if (/^(?:这里)?(?:只是讨论|仅(?:仅)?(?:是|用于)?讨论|仅作为示例|用于讨论|示例|讨论)/.test(body)
    || /^以后(?:只是讨论|仅(?:仅)?(?:是|用于)?讨论|仅作为示例|示例|讨论)/.test(body)
    || /^(?:不要|请勿|禁止|别)(?:保存|修改|改动|设置|删除)\s*(?:(?:Codex|Claude Code|claude-code|CC|Pi)\s*的?\s*)?(?:个人|项目)?(?:长期)?(?:规则|要求)/i.test(body))
    return 'persistent-write-not-explicit';
  const heading = /^(?:(?:只对\s*)?(Codex|Claude Code|claude-code|CC|Pi)\s*(?:的\s*)?)?(?:(个人|项目)\s*)?(?:Auto\s*)?(?:长期)?(?:规则|要求)?\s*[：:]([\s\S]+)$/i.exec(body);
  const futureTarget = heading ? undefined : /^以后(?:只)?在\s*(Codex|Claude Code|claude-code|CC|Pi)(?:\s|的)/i.exec(body)?.[1];
  const harness = targetName(heading?.[1] ?? futureTarget);
  if (heading) body = heading[3]!;
  if (!body.trim()) return 'persistent-intent-not-explicit';
  // Unknown explicit target qualifiers must not silently widen to all ends.
  if (!heading && /^(?:只对|仅对|只在|仅在)/.test(body)) return 'unsupported-target-declaration';
  return { action: 'set', scope: heading?.[2] === '项目' ? 'project' : 'user',
    ...(harness ? { harness } : {}), authoredBody: body };
}

/** One factory per Main registration. Weak instance keys retire naturally with
 * sessions; one input replaces the prior receipt, never a durable credential. */
export function createPersonalRuleChat(deps: PersonalRuleChatDeps) {
  type Evidence = { current(): boolean; edit: AuthoredRuleIntent | string; text: string; clientId: string;
    result?: PersonalRuleResult; verifyReceipt?(): Promise<void>; run?: Promise<PersonalRuleResult>; save(): Promise<PersonalRuleResult> };
  const inputs = new WeakMap<LiveSession, Evidence>();
  const reject = (reason: string): PersonalRuleResult => ({ ok: false, errorCode: 'PERSONAL_RULE_NOT_ADOPTED', reason });
  function capture(input: CaptureInput): Pending | undefined {
    const session = deps.getSession(input.sessionId);
    if (!session) return undefined;
    const prior = inputs.get(session);
    const owner = deps.captureOwner();
    const generation = deps.getInputGeneration(input.sessionId);
    const instance = session.instanceId, cwd = session.workDir, harness = session.agentKind;
    if (!owner || !deps.ownerCurrent(owner) || persistedOwnerText(input.persisted) !== input.text
      || input.source !== 'desktop' || !input.clientId || session.remoteHostId || session.agentDeviceId) { inputs.delete(session); return undefined; }
    if (prior?.current() && prior.clientId === input.clientId && prior.text === input.text) {
      inputs.set(session, prior); return { async commit() {
        const result = await prior.save();
        if (!result.ok && result.reason === 'write-or-context-failed') throw new Error('Personal rule save failed');
      } };
    }
    const parsed = intent(input.text);
    const current = () => inputs.get(session) === evidence && deps.ownerCurrent(owner) && deps.getInputGeneration(input.sessionId) === generation
      && deps.getSession(input.sessionId) === session && session.instanceId === instance && session.workDir === cwd
      && session.agentKind === harness && session.getStatus() === 'active' && !session.remoteHostId && !session.agentDeviceId
      && !deps.isProvisional(input.sessionId)
      && (!deps.inputIdentity || deps.inputIdentity(input.sessionId)?.clientId === input.clientId);
    let committed = false;
    const evidence: Evidence = { current, edit: parsed, text: input.text, clientId: input.clientId,
      async save() {
        if (!committed || !current()) return reject('input-context-changed');
        if (typeof parsed === 'string') return reject(parsed);
        if (evidence.result) {
          try { await evidence.verifyReceipt?.(); return current() ? evidence.result : reject('input-context-changed'); }
          catch { return reject('write-or-context-failed'); }
        }
        if (evidence.run) return evidence.run;
        const operation = async (): Promise<PersonalRuleResult> => {
          const assert = () => { if (!current()) throw new Error('personal-rule-context-changed'); };
          assert();
          const row = await deps.readSession(input.sessionId); assert();
          const taskHarness = row?.agentKind === 'cc' ? 'claude-code' : row?.agentKind;
          if (!row || row.status !== 'active' || row.source !== 'desktop' || taskHarness !== harness
            || !['claude-code', 'codex', 'pi'].includes(harness) || row.remoteHostId || row.agentDeviceId || row.orcaRole || row.orcaRemoteLead
            || row.workingDir !== cwd) return reject('local-root-target-required');
          const identity = (value: Awaited<ReturnType<PersonalRuleChatDeps['readSession']>>) => value && [value.status, value.source, value.agentKind, value.workingDir,
            value.remoteHostId, value.agentDeviceId, value.orcaRole, value.orcaRemoteLead, value.workspaceKind, value.clearedAt];
          const rowIdentity = identity(row);
          const directory = fs.realpathSync(cwd), stat = fs.statSync(directory);
          if (!stat.isDirectory()) return reject('cwd-unverified');
          const directoryCurrent = () => { const latest = fs.statSync(fs.realpathSync(cwd));
            return fs.realpathSync(cwd) === directory && latest.isDirectory() && latest.dev === stat.dev && latest.ino === stat.ino; };
          const verify = async () => {
            assert(); if (!directoryCurrent()) throw new Error('personal-rule-directory-changed');
            const latest = await deps.readSession(input.sessionId); assert();
            if (!isDeepStrictEqual(identity(latest), rowIdentity)) throw new Error('personal-rule-task-changed');
            const message = await deps.readMessage(input.sessionId, input.clientId); assert();
            const meta = persistedOwnerMeta(message?.agentMeta);
            if (!message || message.role !== 'user' || message.content !== input.persisted
              || persistedOwnerText(message.content) !== input.text || !meta
              || (meta.autoResume !== undefined && meta.autoResume !== false)
              || meta.sharedTaskAuthor !== undefined || meta.sourcePlugin !== undefined
              || meta.botTaskCoordinationInput !== undefined
              || (meta.botTaskCoordination !== undefined && meta.botTaskCoordination !== false)
              || (meta.origin !== undefined && record(meta.origin)?.kind !== 'desktop')
              || meta.autoReviewUserText !== input.text)
              throw new Error('personal-rule-message-unverified');
            if (!directoryCurrent()) throw new Error('personal-rule-directory-changed');
          };
          evidence.verifyReceipt = verify;
          const store = deps.createStore(owner, () => { assert(); if (!directoryCurrent()) throw new Error('personal-rule-directory-changed'); });
          await verify();
          const scope = { ownerId: owner.ownerId, executionHostId: owner.executionHostId, harnesses: personalRuleTargets(parsed.harness ? [parsed.harness] : undefined)!,
            ...(parsed.scope === 'project' ? { projectId: directory } : {}) };
          const snapshot = await store.readSnapshot(scope); await verify();
          let key = parsed.key;
          if (parsed.reference !== undefined) {
            const authored = store.readSourceImportSnapshot().groups;
            const matching = (targetScope: RuleScope) => authored.filter(group => requirementsKey(group) !== undefined && isDeepStrictEqual(group.scope, targetScope)
              && group.clauses.some(clause => {
                if (clause.decision !== 'requirement') return false;
                const prior = intent(clause.original);
                return clause.original === parsed.reference || (typeof prior !== 'string' && prior.authoredBody === parsed.reference);
              }));
            let matches = matching(scope);
            // An explicit project edit may override one precisely referenced
            // user rule. Project deletion never falls back to deleting user data.
            if (!matches.length && parsed.action === 'set' && parsed.scope === 'project') {
              const { projectId: _project, ...userScope } = scope;
              matches = matching(userScope);
            }
            if (matches.length !== 1) return reject(matches.length ? 'ambiguous-rule-reference' : 'existing-rule-reference-required');
            key = requirementsKey(matches[0]!);
          }
          if (!key && parsed.action === 'set') key = 'rule-' + createHash('sha256').update(parsed.authoredBody ?? input.text).digest('hex').slice(0, 40);
          if (!key) return reject('existing-rule-reference-required');
          if (parsed.action === 'delete' && !store.readSourceImportSnapshot().groups.some(group => requirementsKey(group) === key
            && isDeepStrictEqual(group.scope, scope))) return reject('existing-exact-key-required');
          const raw = JSON.stringify({ id: key, targets: scope.harnesses, ...(parsed.action === 'set' ? { text: input.text } : {}) });
          if (('/approval-rule set ' + parsed.scope + ' --requirements ' + raw).length > 2048) return reject('capacity-exceeded');
          const requirements = parseRequirements(raw, parsed.action === 'delete');
          if (!requirements) return reject('invalid-requirements');
          const saved = await writeRequirements(store, snapshot.revision, scope, requirements, parsed.action === 'delete', verify);
          assert();
          return { ok: true, kind: parsed.action === 'delete' ? 'deleted' : 'saved', ...saved, key, clientId: input.clientId };
        };
        evidence.run = operation().then(result => { if (result.ok) evidence.result = result; return result; })
          .catch(() => reject('write-or-context-failed')).finally(() => { evidence.run = undefined; });
        return evidence.run;
      } };
    inputs.set(session, evidence); // Retire the old input before any Host await, including pending captures.
    return { async commit() {
      if (!current()) return;
      committed = true; inputs.set(session, evidence);
      // Explicit writes take effect on persistence, without a second publish or model decision.
      const result = await evidence.save();
      if (!result.ok && result.reason === 'write-or-context-failed') throw new Error('Personal rule save failed');
    } };
  }
  return { captureSend(sessionId: string, message: unknown, rawOptions: unknown): Pending | undefined {
    const options = rawOptions as { [MAIN_OWNED_SEND_CONTEXT]?: { origin: { kind: string }; rawChannelText: string };
      [AUTO_REVIEW_SOURCE_CONTENT]?: string;
      persistUserMessage?: { clientId?: string; content?: unknown; autoResume?: boolean; sourcePlugin?: unknown;
        sharedTaskAuthor?: unknown; botTaskCoordination?: unknown; origin?: { kind?: string } } } | undefined;
    const context = options?.[MAIN_OWNED_SEND_CONTEXT], persisted = options?.persistUserMessage;
    const active = deps.ownerInput?.(sessionId);
    const local = context?.origin.kind === 'desktop' || (!!active && active.clientId === persisted?.clientId
      && active.authoredText === options?.[AUTO_REVIEW_SOURCE_CONTENT]);
    const text = typeof message === 'string' ? message : (message as { type?: string; content?: unknown })?.type === 'user'
      ? (message as { content: unknown }).content : undefined;
    if (!local || !persisted?.clientId || persisted.autoResume || persisted.sourcePlugin || persisted.sharedTaskAuthor
      || persisted.botTaskCoordination || (persisted.origin && persisted.origin.kind !== 'desktop')
      || typeof text !== 'string' || text !== (context?.rawChannelText ?? active?.authoredText)) {
      const session = deps.getSession(sessionId); if (session) inputs.delete(session); return undefined;
    }
    return capture({ sessionId, clientId: persisted.clientId, text, persisted: persisted.content, source: 'desktop' });
  }, async edit(caller: PersonalRuleCaller, candidate: PersonalRuleEdit): Promise<PersonalRuleResult> {
    const session = caller.sessionId ? deps.getSession(caller.sessionId) : undefined;
    if (!session || !caller.sessionInstanceId || caller.sessionInstanceId !== session.instanceId || caller.remoteHostId)
      return reject('local-session-instance-required');
    if (candidate.action === 'status') {
      try { return { ok: true, kind: 'status', statuses: await readPersonalRuleStatus(deps, session.id) }; }
      catch { return reject('status-context-unverified'); }
    }
    const evidence = inputs.get(session);
    if (!evidence || !evidence.current()) return reject('no-current-accepted-owner-input');
    if (typeof evidence.edit === 'string') return reject(evidence.edit);
    const { authoredBody: _body, ...expected } = evidence.edit;
    if (!isDeepStrictEqual(candidate, expected)) return reject('candidate-does-not-match-owner-request');
    return deps.withSessionLock(session.id, () => evidence.save());
  } };
}

let host: ReturnType<typeof createPersonalRuleChat> | undefined;
export function configurePersonalRuleChat(value: ReturnType<typeof createPersonalRuleChat>): void { host = value; }
export function editPersonalRuleChat(caller: PersonalRuleCaller, edit: PersonalRuleEdit): Promise<PersonalRuleResult> {
  return host ? host.edit(caller, edit) : Promise.resolve({ ok: false, errorCode: 'HOST_NOT_READY', reason: 'personal-rule-host-unavailable' });
}
