import { promises as fs } from 'node:fs';

import type { AgentKind, EngineKind, ListAgentSkillsResult } from '@cindy/maker-core';
import { hasBuiltinAgentKind } from '../maker-host/engineKind.js';

import { visibleMessageTextForConversationSearch } from '../localDb/conversationSearch.pure.js';
import {
  activeCindyBuiltInAgentSkills,
  type BuiltInSkillDescriptor,
} from '../maker-host/built-in-skills.js';
import { parseDirectLearnInvocation, type CindyLearnInvocationGrant } from './invocationGrant.js';

interface LearnInvocationSession {
  id: string;
  instanceId: string;
  agentKind: AgentKind;
  workDir: string;
  remoteHostId: string | null;
  getStatus?(): 'active' | 'aborting' | 'closed' | 'error';
}

/** A live session of any engine; plugin-engine tasks are never granted a /learn capture. */
type AnyEngineLearnSession = Omit<LearnInvocationSession, 'agentKind'> & { agentKind: EngineKind };

interface LearnInvocationCaptureDeps {
  // Compared by identity only.
  getSession(id: string): AnyEngineLearnSession | null | undefined;
  builtInSkillDescriptors(): readonly BuiltInSkillDescriptor[];
  isSkillEnabled(source: string): boolean;
  canGrantUnqualifiedClaudeInvocation(id: string): Promise<boolean>;
  listSkills(session: LearnInvocationSession): Promise<ListAgentSkillsResult>;
}

/** Capture the trusted Skill file for this exact persisted and dispatched user turn. */
export function createCindyLearnInvocationCapture(deps: LearnInvocationCaptureDeps) {
  return async (
    session: AnyEngineLearnSession,
    persistedContent: unknown,
    dispatchedText: string,
  ): Promise<CindyLearnInvocationGrant | null> => {
    // /learn reads built-in engine skill catalogs (docs/plans/acp-plugin-bridge.md).
    if (!hasBuiltinAgentKind(session)) return null;
    const invocationText = visibleMessageTextForConversationSearch(
      'user',
      typeof persistedContent === 'string' ? persistedContent : JSON.stringify(persistedContent),
    );
    const persistedInvocation = parseDirectLearnInvocation(invocationText);
    const dispatchedInvocation = parseDirectLearnInvocation(dispatchedText);
    if (
      !persistedInvocation
      || !dispatchedInvocation
      || JSON.stringify(persistedInvocation) !== JSON.stringify(dispatchedInvocation)
    ) return null;
    if (
      session.remoteHostId
      || deps.getSession(session.id) !== session
      || (session.getStatus && session.getStatus() !== 'active')
    ) return null;

    if (session.agentKind === 'claude-code'
      && !/^\/cindy:learn(?:\s|$)/i.test(dispatchedText.trim())
      && !await deps.canGrantUnqualifiedClaudeInvocation(session.id)) return null;

    const descriptors = deps.builtInSkillDescriptors();
    const learnDescriptor = descriptors.find((descriptor) => descriptor.name === 'learn');
    if (!learnDescriptor || !deps.isSkillEnabled(learnDescriptor.absolutePath)) return null;

    const result = await deps.listSkills(session);
    if (result.errors?.length || deps.getSession(session.id) !== session) return null;
    // The explicit Cindy alias still selects the attested built-in file;
    // Pi exposes that file under its native skill:learn runtime command.
    const namespacedRuntimeName = session.agentKind === 'pi' ? 'skill:learn' : 'cindy:learn';
    const learnCandidates = activeCindyBuiltInAgentSkills(
      result.skills,
      descriptors,
      deps.isSkillEnabled,
    ).filter((skill) => (skill.name.toLowerCase() === 'learn' || skill.runtimeCommandName === 'cindy:learn')
      && (!/^\/cindy:learn(?:\s|$)/i.test(dispatchedText.trim())
        || (skill.builtIn === true && skill.runtimeCommandName === namespacedRuntimeName)));
    if (
      learnCandidates.length !== 1
      || learnCandidates.some((skill) => skill.builtIn !== true || !skill.path)
    ) return null;

    const resolvedSkillPath = await fs.realpath(learnCandidates[0]!.path!);
    if (deps.getSession(session.id) !== session) return null;
    return {
      version: 1,
      sessionInstanceId: session.instanceId,
      resolvedSkillPath,
    };
  };
}
