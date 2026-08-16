import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { listCustomMcpServers } from '@/lib/customMcpServers';
import * as sessionService from '@/lib/sessionService';
import { cn } from '@/lib/utils';
import { isBotToolsetAvailableOnTarget } from '../../../shared/botRemoteCapabilities';

import type { BotCapabilities, BotProfile, BotSessionProjection } from './botStore';

interface BotSkillOption {
  name: string;
  description?: string;
  enabled?: boolean;
  runtimeStatus?: 'discovered' | 'approved' | 'loaded' | 'failed' | 'unknown';
  runtimeCommandName?: string;
}

interface BotToolsetOption {
  id: string;
  name: string;
  description: string;
  effectiveEnabled: boolean;
}

interface BotMcpOption {
  id: string;
  name: string;
}

type CatalogState = 'loading' | 'ready' | 'error';

function runtimeAgentKindForHarness(
  harness: BotCapabilities['harness'],
): 'claude-code' | 'codex' | 'pi' {
  return harness === 'claude' ? 'claude-code' : harness;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function SelectionMark({ selected }: { selected: boolean }) {
  return (
    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-[var(--border-default)]">
      {selected ? <Check size={12} /> : null}
    </span>
  );
}

function CapabilityModeSelect({
  value,
  onChange,
}: {
  value: 'inherit' | 'allowlist';
  onChange: (value: 'inherit' | 'allowlist') => void;
}) {
  const { t } = useTranslation();
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as 'inherit' | 'allowlist')}
      className="h-8 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 text-11 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
    >
      <option value="inherit">{t('bots.capabilityMode.inherit')}</option>
      <option value="allowlist">{t('bots.capabilityMode.allowlist')}</option>
    </select>
  );
}

export function BotCapabilitySettings({
  bot,
  capabilities,
  selectedSkills,
  runtimeSnapshot,
  remoteHostId,
  onCapabilitiesChange,
  onSelectedSkillsChange,
}: {
  bot: BotProfile;
  capabilities: BotCapabilities;
  selectedSkills: string[];
  runtimeSnapshot?: BotSessionProjection['runtimeSnapshot'];
  remoteHostId?: string | null;
  onCapabilitiesChange: (value: BotCapabilities) => void;
  onSelectedSkillsChange: (value: string[]) => void;
}) {
  const { t } = useTranslation();
  const [skillCatalog, setSkillCatalog] = useState<BotSkillOption[]>([]);
  const [toolsetCatalog, setToolsetCatalog] = useState<BotToolsetOption[]>([]);
  const [mcpCatalog, setMcpCatalog] = useState<BotMcpOption[]>([]);
  const [skillState, setSkillState] = useState<CatalogState>('loading');
  const [toolsetState, setToolsetState] = useState<CatalogState>('loading');
  const [mcpState, setMcpState] = useState<CatalogState>('loading');

  useEffect(() => {
    let cancelled = false;
    setSkillState('loading');
    setToolsetState('loading');
    setMcpState('loading');
    void (async () => {
      const workingDir = bot.canonicalSessionId
        ? await sessionService
            .get(bot.canonicalSessionId)
            .then((session) => session.workingDir ?? undefined)
            .catch(() => undefined)
        : undefined;
      const [skills, toolsets, mcps] = await Promise.allSettled([
        window.electronAPI.maker.listAgentSkills(runtimeAgentKindForHarness(capabilities.harness), {
          workingDir,
          remoteHostId: remoteHostId ?? undefined,
        }),
        window.electronAPI.maker.plugins.list(workingDir),
        listCustomMcpServers(),
      ]);
      if (cancelled) return;
      if (skills.status === 'fulfilled' && skills.value.success) {
        setSkillCatalog(
          (skills.value.skills ?? []).filter(
            (skill) => skill.enabled !== false && skill.runtimeStatus !== 'failed',
          ),
        );
        setSkillState('ready');
      } else {
        setSkillCatalog([]);
        setSkillState('error');
      }
      if (toolsets.status === 'fulfilled') {
        setToolsetCatalog(
          toolsets.value.map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            effectiveEnabled:
              item.effectiveEnabled &&
              isBotToolsetAvailableOnTarget({
                agentKind: runtimeAgentKindForHarness(capabilities.harness),
                remoteHostId,
                toolsetId: item.id,
              }),
          })),
        );
        setToolsetState('ready');
      } else {
        setToolsetCatalog([]);
        setToolsetState('error');
      }
      if (mcps.status === 'fulfilled') {
        setMcpCatalog(mcps.value.map((item) => ({ id: item.id, name: item.name })));
        setMcpState('ready');
      } else {
        setMcpCatalog([]);
        setMcpState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bot.canonicalSessionId, capabilities.harness, remoteHostId]);

  const resolved = runtimeSnapshot?.resolved;
  const appliedSkills = useMemo(() => new Set(readStringList(resolved?.skills)), [resolved]);
  const appliedToolsets = useMemo(() => new Set(readStringList(resolved?.toolsets)), [resolved]);
  const appliedMcpServers = useMemo(
    () => new Set(readStringList(resolved?.mcpServers)),
    [resolved],
  );
  const unavailableSkills = useMemo(
    () => new Set(readStringList(resolved?.unavailableSkills)),
    [resolved],
  );
  const unavailableToolsets = useMemo(
    () => new Set(readStringList(resolved?.unavailableToolsets)),
    [resolved],
  );
  const unavailableMcpServers = useMemo(
    () => new Set(readStringList(resolved?.unavailableMcpServers)),
    [resolved],
  );

  const updateCapability = <K extends keyof BotCapabilities>(key: K, value: BotCapabilities[K]) =>
    onCapabilitiesChange({ ...capabilities, [key]: value });

  const toggleSkill = (reference: string) => {
    if (capabilities.skillMode === 'inherit') {
      const inherited = skillCatalog.map((skill) => skill.runtimeCommandName?.trim() || skill.name);
      updateCapability('skillMode', 'allowlist');
      onSelectedSkillsChange(inherited.filter((item) => item !== reference));
      return;
    }
    onSelectedSkillsChange(
      selectedSkills.includes(reference)
        ? selectedSkills.filter((item) => item !== reference)
        : [...selectedSkills, reference],
    );
  };

  const toggleToolset = (id: string) => {
    const inherited = toolsetCatalog.filter((item) => item.effectiveEnabled).map((item) => item.id);
    const current = capabilities.toolsetMode === 'inherit' ? inherited : capabilities.toolsets;
    onCapabilitiesChange({
      ...capabilities,
      toolsetMode: 'allowlist',
      toolsets: current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    });
  };

  const toggleMcp = (id: string) => {
    const inherited = mcpCatalog.map((item) => item.id);
    const current = capabilities.mcpMode === 'inherit' ? inherited : capabilities.mcpServers;
    onCapabilitiesChange({
      ...capabilities,
      mcpMode: 'allowlist',
      mcpServers: current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    });
  };

  const catalogMessage = (state: CatalogState, emptyKey: string) => {
    if (state === 'loading') return t('bots.capabilityCatalogLoading');
    if (state === 'error') return t('bots.capabilityCatalogError');
    return t(emptyKey);
  };

  return (
    <div className="mt-4 flex flex-col gap-5">
      <div className="flex flex-col gap-2 text-12 text-[var(--text-secondary)]">
        <div className="flex items-center justify-between gap-3">
          <span>{t('bots.skillsLabel')}</span>
          <CapabilityModeSelect
            value={capabilities.skillMode}
            onChange={(mode) => {
              updateCapability('skillMode', mode);
              if (mode === 'inherit') onSelectedSkillsChange([]);
            }}
          />
        </div>
        {skillState !== 'ready' || skillCatalog.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-[var(--text-tertiary)]">
            {catalogMessage(skillState, 'bots.skillCatalogEmpty')}
          </p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {skillCatalog.map((skill) => {
              const reference = skill.runtimeCommandName?.trim() || skill.name;
              const selected =
                capabilities.skillMode === 'inherit' || selectedSkills.includes(reference);
              return (
                <button
                  type="button"
                  key={`${skill.name}:${reference}`}
                  onClick={() => toggleSkill(reference)}
                  className={cn(
                    'flex min-h-12 items-start gap-2 rounded-xl border px-3 py-2 text-left',
                    selected
                      ? 'border-[var(--focus-ring-soft)] bg-[var(--surface-chip)]'
                      : 'border-[var(--border-default)] hover:bg-[var(--surface-hover)]',
                  )}
                >
                  <SelectionMark selected={selected} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-12 font-medium text-[var(--text-primary)]">
                      {skill.name}
                    </span>
                    {skill.description ? (
                      <span className="mt-0.5 block line-clamp-2 text-11 leading-4 text-[var(--text-tertiary)]">
                        {skill.description}
                      </span>
                    ) : null}
                  </span>
                  {appliedSkills.has(reference) ? (
                    <span className="text-10 text-[var(--text-tertiary)]">
                      {t('bots.capabilityApplied')}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
        {selectedSkills
          .filter(
            (name) =>
              !skillCatalog.some(
                (skill) => skill.name === name || skill.runtimeCommandName === name,
              ),
          )
          .map((name) => (
            <button
              type="button"
              key={name}
              onClick={() => toggleSkill(name)}
              className="flex items-center justify-between rounded-lg border border-[var(--border-default)] px-3 py-2 text-left text-11 text-[var(--text-secondary)]"
            >
              <span className="truncate">{name}</span>
              <span className="shrink-0 text-[var(--text-tertiary)]">
                {unavailableSkills.has(name)
                  ? t('bots.capabilityUnavailable')
                  : t('bots.skillConfiguredUnavailable')}
              </span>
            </button>
          ))}
        <span className="text-11 text-[var(--text-tertiary)]">{t('bots.skillsDescription')}</span>
      </div>

      <div className="flex flex-col gap-2 text-12 text-[var(--text-secondary)]">
        <div className="flex items-center justify-between gap-3">
          <span>{t('bots.toolsetsLabel')}</span>
          <CapabilityModeSelect
            value={capabilities.toolsetMode}
            onChange={(mode) =>
              onCapabilitiesChange({
                ...capabilities,
                toolsetMode: mode,
                toolsets: mode === 'inherit' ? [] : capabilities.toolsets,
              })
            }
          />
        </div>
        {toolsetState !== 'ready' || toolsetCatalog.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-[var(--text-tertiary)]">
            {catalogMessage(toolsetState, 'bots.toolsetCatalogEmpty')}
          </p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {toolsetCatalog.map((toolset) => {
              const selected =
                capabilities.toolsetMode === 'inherit'
                  ? toolset.effectiveEnabled
                  : capabilities.toolsets.includes(toolset.id);
              return (
                <button
                  type="button"
                  key={toolset.id}
                  disabled={!toolset.effectiveEnabled}
                  onClick={() => toggleToolset(toolset.id)}
                  className={cn(
                    'flex min-h-12 items-start gap-2 rounded-xl border px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-55',
                    selected
                      ? 'border-[var(--focus-ring-soft)] bg-[var(--surface-chip)]'
                      : 'border-[var(--border-default)] hover:bg-[var(--surface-hover)]',
                  )}
                >
                  <SelectionMark selected={selected} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-12 font-medium text-[var(--text-primary)]">
                      {toolset.name}
                    </span>
                    <span className="mt-0.5 block line-clamp-2 text-11 leading-4 text-[var(--text-tertiary)]">
                      {toolset.effectiveEnabled
                        ? toolset.description
                        : t('bots.capabilityDisabledBySystem')}
                    </span>
                  </span>
                  {appliedToolsets.has(toolset.id) ? (
                    <span className="text-10 text-[var(--text-tertiary)]">
                      {t('bots.capabilityApplied')}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
        {capabilities.toolsets
          .filter((id) => !toolsetCatalog.some((item) => item.id === id))
          .map((id) => (
            <div
              key={id}
              className="flex items-center justify-between rounded-lg border border-[var(--border-default)] px-3 py-2 text-11 text-[var(--text-secondary)]"
            >
              <span className="truncate">{id}</span>
              <span className="shrink-0 text-[var(--text-tertiary)]">
                {unavailableToolsets.has(id)
                  ? t('bots.capabilityUnavailable')
                  : t('bots.capabilityNotInstalled')}
              </span>
            </div>
          ))}
      </div>

      <div className="flex flex-col gap-2 text-12 text-[var(--text-secondary)]">
        <div className="flex items-center justify-between gap-3">
          <span>{t('bots.mcpServersLabel')}</span>
          <CapabilityModeSelect
            value={capabilities.mcpMode}
            onChange={(mode) =>
              onCapabilitiesChange({
                ...capabilities,
                mcpMode: mode,
                mcpServers: mode === 'inherit' ? [] : capabilities.mcpServers,
              })
            }
          />
        </div>
        {mcpState !== 'ready' || mcpCatalog.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-[var(--text-tertiary)]">
            {catalogMessage(mcpState, 'bots.mcpCatalogEmpty')}
          </p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {mcpCatalog.map((server) => {
              const selected =
                capabilities.mcpMode === 'inherit' || capabilities.mcpServers.includes(server.id);
              return (
                <button
                  type="button"
                  key={server.id}
                  onClick={() => toggleMcp(server.id)}
                  className={cn(
                    'flex min-h-10 items-center gap-2 rounded-xl border px-3 py-2 text-left',
                    selected
                      ? 'border-[var(--focus-ring-soft)] bg-[var(--surface-chip)]'
                      : 'border-[var(--border-default)] hover:bg-[var(--surface-hover)]',
                  )}
                >
                  <SelectionMark selected={selected} />
                  <span className="min-w-0 flex-1 truncate text-12 font-medium text-[var(--text-primary)]">
                    {server.name}
                  </span>
                  {appliedMcpServers.has(server.id) ? (
                    <span className="text-10 text-[var(--text-tertiary)]">
                      {t('bots.capabilityApplied')}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
        {capabilities.mcpServers
          .filter((id) => !mcpCatalog.some((item) => item.id === id))
          .map((id) => (
            <div
              key={id}
              className="flex items-center justify-between rounded-lg border border-[var(--border-default)] px-3 py-2 text-11 text-[var(--text-secondary)]"
            >
              <span className="truncate">{id}</span>
              <span className="shrink-0 text-[var(--text-tertiary)]">
                {unavailableMcpServers.has(id)
                  ? t('bots.capabilityUnavailable')
                  : t('bots.capabilityNotInstalled')}
              </span>
            </div>
          ))}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex items-start gap-2 rounded-xl border border-[var(--border-default)] px-3 py-3 text-12 text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={capabilities.memory}
            onChange={(event) => updateCapability('memory', event.target.checked)}
          />
          <span>
            <span className="block font-medium text-[var(--text-primary)]">
              {t('bots.memoryLabel')}
            </span>
            <span className="mt-0.5 block text-11 leading-4 text-[var(--text-tertiary)]">
              {t('bots.memoryDescription')}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 rounded-xl border border-[var(--border-default)] px-3 py-3 text-12 text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={capabilities.automation}
            onChange={(event) => updateCapability('automation', event.target.checked)}
          />
          <span>
            <span className="block font-medium text-[var(--text-primary)]">
              {t('bots.automationLabel')}
            </span>
            <span className="mt-0.5 block text-11 leading-4 text-[var(--text-tertiary)]">
              {t('bots.automationDescription')}
            </span>
          </span>
        </label>
      </div>

      <label className="flex flex-col gap-2 rounded-xl border border-[var(--border-default)] px-3 py-3 text-12 text-[var(--text-secondary)]">
        <span>
          <span className="block font-medium text-[var(--text-primary)]">
            {t('bots.sessionControl.title')}
          </span>
          <span className="mt-0.5 block text-11 leading-4 text-[var(--text-tertiary)]">
            {t('bots.sessionControl.description')}
          </span>
        </span>
        <select
          value={capabilities.sessionControlMode}
          onChange={(event) => updateCapability(
            'sessionControlMode',
            event.target.value as BotCapabilities['sessionControlMode'],
          )}
          className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
        >
          <option value="none">{t('bots.sessionControl.none')}</option>
          <option value="observe">{t('bots.sessionControl.observe')}</option>
          <option value="coordinate">{t('bots.sessionControl.coordinate')}</option>
        </select>
        <span className="text-11 leading-4 text-[var(--text-tertiary)]">
          {t(`bots.sessionControl.${capabilities.sessionControlMode}Description`)}
        </span>
      </label>
    </div>
  );
}
