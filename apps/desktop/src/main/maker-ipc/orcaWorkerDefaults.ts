import type { AgentKind } from '@cindy/maker-core';
import type { WorkerCreationSelection } from '../../shared/workerCreationSelection';
import type {
  OrcaLeadSessionSnapshot,
  OrcaWorkerCreateParams,
  OrcaWorkerCreationDeps,
  OrcaWorkerCreationResult,
  OrcaWorkerProviderRoutingContext,
} from './orcaWorkerCreationService';

export type OrcaWorkerCreateRequest = Omit<OrcaWorkerCreateParams, 'agent'> & {
  agent?: AgentKind;
  /** Host-only: MCP creation opts in; manual UI and enableTeam retain their own choices. */
  useCreationPrefs?: boolean;
};
export interface WorkerDefaultsResolution {
  source: 'memory' | 'original-policy' | 'explicit';
  fallbackReason?: string;
}

type Resolution =
  | {
      ok: true;
      params: OrcaWorkerCreateParams;
      defaults: WorkerDefaultsResolution;
      routing?: OrcaWorkerProviderRoutingContext;
    }
  | Extract<OrcaWorkerCreationResult, { ok: false }>;
const agents: AgentKind[] = ['claude-code', 'codex', 'pi'];
const invalid = (message: string): Resolution => ({
  ok: false,
  errorCode: 'INVALID_PARAMS',
  message,
});

/** Resolve a whole submitted route before any reservation, worktree or Agent side effect. */
export async function resolveWorkerCreationDefaults(
  input: OrcaWorkerCreateRequest,
  lead: OrcaLeadSessionSnapshot,
  deps: Pick<
    OrcaWorkerCreationDeps,
    'getCreationSelection' | 'getProviderRoutingContext' | 'getAvailableModels' | 'isSelfDeviceId'
  >,
): Promise<Resolution> {
  const original: WorkerDefaultsResolution = {
    source: input.agent !== undefined && input.model !== undefined ? 'explicit' : 'original-policy',
  };
  const explicitRoute = input.agentDeviceId !== undefined || input.providerId !== undefined;
  const remembered =
    input.useCreationPrefs &&
    !explicitRoute &&
    !lead.remoteHostId &&
    input.executionDeviceId === undefined
      ? deps.getCreationSelection?.()
      : null;
  if (!remembered)
    return input.agent
      ? { ok: true, params: { ...input, agent: input.agent }, defaults: original }
      : invalid(
          'Specify agent: no applicable manually submitted Worker model selection is available.',
        );

  const location = (id: string | null | undefined) =>
    id && !deps.isSelfDeviceId?.(id) ? id : null;
  const rememberedLocation = location(remembered.agentDeviceId);
  const catalogs = new Map<string, Promise<OrcaWorkerProviderRoutingContext>>();
  const catalog = (agent: AgentKind, device: string | null) => {
    const key = JSON.stringify([agent, device]);
    let read = catalogs.get(key);
    if (!read) {
      read = deps.getProviderRoutingContext(agent, null, device);
      catalogs.set(key, read);
    }
    return read;
  };
  // Changed models use the original Lead location; a valid saved model already proves its Agent.
  const infer = async (device: string | null): Promise<AgentKind[]> => {
    const matches: AgentKind[] = [];
    for (const agent of agents) {
      const route = await catalog(agent, device);
      const models = route.remoteCodexModels ?? deps.getAvailableModels(agent);
      if (
        models.some((model) => model.id === input.model) &&
        route.availability[agent].some(
          (provider) =>
            provider.models.includes(input.model!) &&
            (!input.providerId || provider.id === input.providerId),
        )
      )
        matches.push(agent);
    }
    return matches;
  };
  let agent = input.agent;
  const mayRemember =
    !(input.agent !== undefined && input.model !== undefined) &&
    (input.agent === undefined || input.agent === remembered.agent) &&
    (input.model === undefined || input.model === remembered.model);
  let fallbackReason: string | undefined;
  let savedRouting: OrcaWorkerProviderRoutingContext | undefined;
  let savedProvider: string | null = remembered.providerId;
  if (mayRemember) {
    try {
      savedRouting = await catalog(remembered.agent, rememberedLocation);
      const providers = savedRouting.availability[remembered.agent];
      const models = savedRouting.remoteCodexModels ?? deps.getAvailableModels(remembered.agent);
      savedProvider ??= savedRouting.resolveDefaultProviderIdForModel(
        remembered.agent,
        remembered.model,
      );
      const provider = providers.find((item) => item.id === savedProvider);
      const model = models.find((item) => item.id === remembered.model);
      if (!model) fallbackReason = 'the model is no longer available';
      else if (!provider) fallbackReason = 'the provider is disconnected or unavailable';
      else if (!provider.models.includes(remembered.model))
        fallbackReason = 'the provider no longer offers this model';
      else {
        const tuning = provider.effortMetaByModel?.[remembered.model] ?? model;
        if (
          input.effort === undefined &&
          remembered.effort !== '' &&
          !tuning.effortsUnknown &&
          !(tuning.efforts ?? []).includes(remembered.effort)
        )
          fallbackReason = 'the saved reasoning effort is no longer available';
        else if (
          input.fast === undefined &&
          remembered.fast &&
          remembered.agent !== 'claude-code' &&
          !(remembered.fast === 'ultrafast'
            ? provider.ultrafastModels?.includes(remembered.model)
            : (provider.fastModels?.includes(remembered.model) ?? model.supportsFastMode))
        )
          fallbackReason = 'the saved Fast mode is no longer available';
      }
    } catch (error) {
      // Never return remote exception text (it can contain endpoint or credential details).
      const message = error instanceof Error ? error.message : '';
      fallbackReason = message.includes('REMOTE_AGENT_SHARE_PAUSED')
        ? 'the shared provider is paused'
        : message.includes('REMOTE_AGENT_SHARE_REMOVED')
          ? 'the shared provider was removed'
          : rememberedLocation?.startsWith('share:')
            ? 'the shared provider is unavailable'
            : rememberedLocation
              ? 'the Agent computer is offline or unreachable'
              : 'the provider catalog is unavailable';
    }
    if (fallbackReason) {
      fallbackReason = `Saved route (${describeSelection(remembered)}) is unavailable: ${fallbackReason}.`;
      if (!input.agent && !input.model)
        return invalid(`${fallbackReason} Specify agent and retry.`);
    }
  }
  if (!agent && mayRemember && !fallbackReason) agent = remembered.agent;
  if (!agent && input.model) {
    try {
      const device =
        !fallbackReason && mayRemember
          ? rememberedLocation
          : location(input.agentDeviceId === undefined ? lead.agentDeviceId : input.agentDeviceId);
      const candidates = await infer(device);
      // A rejected saved route must not contribute even its Agent as a tie-breaker.
      agent =
        candidates.length === 1
          ? candidates[0]
          : !fallbackReason && candidates.includes(remembered.agent)
            ? remembered.agent
            : undefined;
      if (!agent)
        return invalid(
          `${fallbackReason ? `${fallbackReason} ` : ''}Model is unavailable or belongs to multiple agents; specify agent and retry.`,
        );
    } catch {
      return invalid(
        `${fallbackReason ? `${fallbackReason} ` : ''}Cannot infer agent from the current catalog; specify agent and retry.`,
      );
    }
  }
  if (!fallbackReason && mayRemember && (!agent || agent === remembered.agent)) {
    return {
      ok: true,
      params: {
        ...input,
        agent: remembered.agent,
        model: remembered.model,
        providerId: savedProvider,
        agentDeviceId: rememberedLocation,
        effort: input.effort ?? ((remembered.effort || undefined) as OrcaWorkerCreateParams['effort']),
        fast: input.fast ?? remembered.fast,
      },
      defaults: { source: 'memory' },
      routing: savedRouting,
    };
  }
  if (!agent)
    return invalid(
      'Specify agent and retry; explicit provider or location does not select an agent.',
    );
  return {
    ok: true,
    params: { ...input, agent },
    defaults: {
      ...original,
      ...(fallbackReason
        ? {
            source: 'original-policy',
            fallbackReason: `${fallbackReason} Used the original defaults policy.`,
          }
        : {}),
    },
  };
}

function describeSelection(selection: WorkerCreationSelection): string {
  // Human-readable harness/model plus generic location: no device/share IDs or connection secrets.
  const device =
    selection.agentDeviceId === null
      ? 'this computer'
      : selection.agentDeviceId.startsWith('share:')
        ? 'shared provider'
        : 'another computer';
  return `${selection.agent}, ${selection.model}, ${device}`;
}
