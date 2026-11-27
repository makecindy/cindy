import { useState, type ReactNode } from 'react';
import { SubagentModelSectionView } from '@/components/settings/SubagentModelSection';
import { AuxiliaryModelSectionView } from '@/components/settings/AuxiliaryModelSection';
import { decodeCatalogModelPin } from '../../../shared/catalogModelPin';
import type { AuxiliaryModelOption } from '../../../shared/auxiliaryModelSettings';
import type { CloudSettingsDomain, CloudSettingsState } from '../../../shared/cloudSettings';

/** Resolves true once the target confirmed the write; failures are already reported. */
type Attempt = (
  domain: CloudSettingsDomain,
  set: Record<string, unknown>,
  clear?: string[],
) => Promise<boolean>;
type Route = { providerId: string | null; modelId: string };
const isRoute = (value: unknown): value is Route =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof (value as Route).modelId === 'string';

export function CloudSubagentSettings({
  state,
  deviceId,
  disabled,
  attempt,
  headingStatus,
}: {
  state: CloudSettingsState;
  deviceId: string;
  disabled: boolean;
  attempt: Attempt;
  /** The group could not be read: the status in its heading row. */
  headingStatus?: ReactNode;
}) {
  const route = isRoute(state.value?.claudeCode) ? state.value.claudeCode : null;
  const customized = (key: string) => state.customizedKeys?.includes(key) ?? false;
  // The target's allowlist; a saved source missing from it is shown as disconnected.
  const sources = (state.choices?.claudeCode ?? []).map(({ value }) => value).filter(isRoute);
  return (
    <SubagentModelSectionView
      headingStatus={headingStatus}
      claudeCode={route?.modelId ?? null}
      claudeCodeProviderId={route?.providerId ?? null}
      codexSmartSubagentRouting={state.value?.codexSmartSubagentRouting === true}
      claudeCustomized={customized('claudeCode')}
      smartRoutingCustomized={customized('codexSmartSubagentRouting')}
      pending={disabled}
      providersLoading={false}
      claudeSourceDisconnected={
        !!route?.providerId &&
        !sources.some((source) => source.providerId === route.providerId)
      }
      deviceId={deviceId}
      setClaudeModel={async (modelId, providerId) => {
        if (modelId === route?.modelId && providerId === (route?.providerId ?? null)) return;
        await attempt('subagentModel', {
          claudeCode: modelId === null ? null : { providerId, modelId },
        });
        return true;
      }}
      resolveClaudeProviderId={(_modelId, providerId) => providerId}
      resetClaude={() => void attempt('subagentModel', {}, ['claudeCode'])}
      resetSmartRouting={() => void attempt('subagentModel', {}, ['codexSmartSubagentRouting'])}
      setSmartRouting={(next) =>
        void attempt('subagentModel', { codexSmartSubagentRouting: next })
      }
    />
  );
}

/** Target auxiliary pins; labels follow the Host format "Agent · Model · Provider". */
function auxiliaryOption(id: string, label: string, available: boolean): AuxiliaryModelOption {
  const route = decodeCatalogModelPin(id);
  const [agentSuffix = '', modelName = route?.model ?? id, group = route?.providerId ?? ''] =
    label.split(' · ');
  return {
    id,
    label,
    group,
    providerId: route?.providerId ?? '',
    agentKind: route?.agentKind ?? 'pi',
    modelId: route?.model ?? id,
    modelName,
    budget: false,
    subscription: false,
    agentSuffix,
    available,
  };
}

export function CloudAuxiliarySettings({
  state,
  disabled,
  attempt,
  headingStatus,
}: {
  state: CloudSettingsState;
  disabled: boolean;
  attempt: Attempt;
  /** The group could not be read: the status in its heading row. */
  headingStatus?: ReactNode;
}) {
  const [drafting, setDrafting] = useState(false);
  const models = Array.isArray(state.value?.models) ? state.value.models.map(String) : [];
  const offered = (state.choices?.models ?? []).map(({ value, label }) =>
    auxiliaryOption(String(value), label, true),
  );
  // A saved pin the target no longer offers stays visible as unavailable.
  const options = [
    ...offered,
    ...models.filter((id) => !offered.some((option) => option.id === id)).map((id) => auxiliaryOption(id, id, false)),
  ];
  return (
    <AuxiliaryModelSectionView
      headingStatus={headingStatus}
      models={models}
      options={options}
      pending={disabled}
      signInHint={false}
      drafting={drafting}
      setDrafting={setDrafting}
      persistModels={(next) => attempt('auxiliaryModel', next.length ? { models: next } : {}, next.length ? undefined : ['models'])}
    />
  );
}
