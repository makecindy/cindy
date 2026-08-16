import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  BellRing,
  Bot,
  Check,
  Clock3,
  Download,
  ImagePlus,
  MessageCircleMore,
  Plus,
  RefreshCcw,
  Settings2,
  Sparkles,
  Upload,
} from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import * as sessionService from '@/lib/sessionService';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { VendorSegmentedSwitcher } from '@/components/new-chat/VendorSegmentedSwitcher';
import { useAvailableAgents } from '@/hooks/useAvailableAgents';
import { getDraft } from '@/state/newMakerDraft';
import type { MakerVendor } from '@/lib/ccAgent.types';
import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import { useRegisterContentHeader } from '../feature-context';
import {
  applyBotImMigration,
  listBotChannelConnections,
  listBotImMigrations,
  planBotImMigration,
  rollbackBotImMigration,
  setCanonicalBotSession,
  updateBotProfile,
  upsertBotChannel,
  useBotProfiles,
  exportBotBundle,
  importBotBundle,
  type BotCapabilities,
  type BotChannel,
  type BotChannelConnection,
  type BotImMigrationPlan,
  type BotImMigrationRecord,
  type BotProfile,
} from './botStore';
import { AddBotDialog } from './AddBotDialog';
import { BotCapabilitySettings } from './BotCapabilitySettings';
import { BotProjectSettings } from './BotProjectSettings';
import { BotAutomationSettings } from './BotAutomationSettings';
import { BotRouteSettings } from './BotRouteSettings';
import { BotLifecycleSettings } from './BotLifecycleSettings';
import { BotEventInboxSettings } from './BotEventInboxSettings';
import { BotChannelCapabilitySummary } from './BotChannelCapabilitySummary';

const AVATARS = ['🤖', '✦', '◈', '◎', '☄️', '🧭'];
const AVATAR_COLORS = ['violet', 'blue', 'amber', 'graphite'] as const;

function channelLabel(channel: BotChannel): string {
  return channel === 'local' ? 'Local Bot' : channel[0].toUpperCase() + channel.slice(1);
}

function avatarColorStyle(color: string): CSSProperties {
  const colors: Record<string, string> = {
    violet: 'var(--accent-cta-bg)',
    blue: 'var(--focus-ring-soft)',
    amber: 'var(--text-secondary)',
    graphite: 'var(--text-primary)',
  };
  return { backgroundColor: colors[color] ?? colors.violet };
}

function BotAvatar({ bot, size = 'h-10 w-10' }: { bot: BotProfile; size?: string }) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-xl text-lg', size)}
      style={avatarColorStyle(bot.avatarColor)}
    >
      <span aria-hidden>{bot.avatar || '🤖'}</span>
    </span>
  );
}

function BotSettings({
  bot,
  onBack,
  onRenew,
  onOpenSession,
  renewing,
}: {
  bot: BotProfile;
  onBack: () => void;
  onRenew: () => Promise<boolean>;
  onOpenSession: (sessionId: string, searchJump?: ConversationSearchJump) => void;
  renewing: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description);
  const [identitySource, setIdentitySource] = useState(bot.identitySource ?? '');
  const [userContextSource, setUserContextSource] = useState(bot.userContextSource ?? '');
  const [avatar, setAvatar] = useState(bot.avatar);
  const [avatarColor, setAvatarColor] = useState(bot.avatarColor);
  const [selectedSkills, setSelectedSkills] = useState<string[]>(bot.skills);
  const [capabilities, setCapabilities] = useState<BotCapabilities>(bot.capabilities);
  const [channelBusy, setChannelBusy] = useState<string | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [channelConnections, setChannelConnections] = useState<BotChannelConnection[]>([]);
  const [migrationPlan, setMigrationPlan] = useState<BotImMigrationPlan | null>(null);
  const [migrationRecords, setMigrationRecords] = useState<BotImMigrationRecord[]>([]);
  const [rollbackRecord, setRollbackRecord] = useState<BotImMigrationRecord | null>(null);
  const [profileApplyPrompt, setProfileApplyPrompt] = useState<{
    currentVersion: number;
    activeVersion: number;
  } | null>(null);
  const [profileApplyError, setProfileApplyError] = useState<string | null>(null);
  const [portabilityBusy, setPortabilityBusy] = useState(false);
  const [portabilityNotice, setPortabilityNotice] = useState<string | null>(null);
  const { availableVendors, loaded: availableAgentsLoaded } = useAvailableAgents();
  const selectedProject = bot.projectBindings?.find((binding) => binding.isDefault);
  const sshRemote = Boolean(selectedProject?.remoteHostId);
  const vendor: MakerVendor = capabilities.harness === 'claude' ? 'cc' : capabilities.harness;
  const hiddenVendors = useMemo<MakerVendor[]>(() => {
    if (!availableAgentsLoaded) return [];
    return (['cc', 'codex', 'pi'] as const).filter((item) => !availableVendors.has(item));
  }, [availableAgentsLoaded, availableVendors]);
  const canonicalProjection = bot.sessions.find((item) => item.kind === 'chat');
  const runtimeState =
    bot.currentVersion !== undefined &&
    canonicalProjection?.profileVersion !== undefined &&
    bot.currentVersion > canonicalProjection.profileVersion
      ? 'pendingRenew'
      : canonicalProjection?.runtimeSnapshot?.status === 'degraded'
        ? 'degraded'
        : canonicalProjection?.runtimeSnapshot?.status === 'failed'
          ? 'failed'
          : canonicalProjection?.runtimeSnapshot?.status === 'prepared'
            ? 'prepared'
            : canonicalProjection?.runtimeSnapshot?.status === 'applied'
              ? 'applied'
              : 'saved';

  useEffect(() => {
    setName(bot.name);
    setDescription(bot.description);
    setIdentitySource(bot.identitySource ?? '');
    setUserContextSource(bot.userContextSource ?? '');
    setAvatar(bot.avatar);
    setAvatarColor(bot.avatarColor);
    setSelectedSkills(bot.skills);
    setCapabilities(bot.capabilities);
  }, [bot]);

  useEffect(() => {
    let cancelled = false;
    void listBotChannelConnections()
      .then((rows) => {
        if (!cancelled) setChannelConnections(rows.filter((row) => row.accountKey));
      })
      .catch(() => {
        if (!cancelled) setChannelError(t('bots.migration.errors.load'));
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id, t]);

  useEffect(() => {
    let cancelled = false;
    void listBotImMigrations(bot.id)
      .then((rows) => {
        if (!cancelled) setMigrationRecords(rows);
      })
      .catch(() => {
        if (!cancelled) setChannelError(t('bots.migration.errors.load'));
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id, t]);

  const updateCapability = <K extends keyof BotCapabilities>(key: K, value: BotCapabilities[K]) =>
    setCapabilities((current) => ({ ...current, [key]: value }));

  const [saving, setSaving] = useState(false);
  const save = async () => {
    const updated = await updateBotProfile(bot.id, {
      name: name.trim() || bot.name,
      description: description.trim(),
      identitySource,
      userContextSource,
      avatar,
      avatarColor,
      capabilities,
      skills: selectedSkills,
    });
    const activeVersion = canonicalProjection?.profileVersion;
    if (
      updated.currentVersion !== undefined &&
      activeVersion !== undefined &&
      updated.currentVersion > activeVersion
    ) {
      setProfileApplyError(null);
      setProfileApplyPrompt({ currentVersion: updated.currentVersion, activeVersion });
      return true;
    }
    return false;
  };

  const saveAndContinue = () => {
    setSaving(true);
    setProfileApplyError(null);
    void save()
      .then((needsApply) => {
        if (!needsApply) onBack();
      })
      .catch(() => setProfileApplyError(t('bots.profileApply.saveFailed')))
      .finally(() => setSaving(false));
  };

  const renewAndApplyProfile = () => {
    setProfileApplyError(null);
    void onRenew().then((renewed) => {
      if (!renewed) setProfileApplyError(t('bots.profileApply.renewFailed'));
    });
  };

  const visibleChannelConnections = useMemo(() => {
    const byKey = new Map<string, BotChannelConnection>();
    for (const connection of channelConnections) {
      if (!connection.accountKey) continue;
      byKey.set(
        `${connection.kind}\u0000${connection.ownership}\u0000${connection.accountKey}`,
        connection,
      );
    }
    for (const channel of bot.channels ?? []) {
      if (channel.kind === 'local') continue;
      const accountKey =
        typeof channel.config?.accountKey === 'string' ? channel.config.accountKey.trim() : '';
      if (!accountKey) continue;
      const ownership =
        channel.config?.ownership === 'server-relay' ? 'server-relay' : 'local-adapter';
      const key = `${channel.kind}\u0000${ownership}\u0000${accountKey}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        id:
          typeof channel.config?.connectionId === 'string'
            ? channel.config.connectionId
            : `saved:${channel.id}`,
        kind: channel.kind,
        ownership,
        status: 'unavailable',
        connected: false,
        accountKey,
        accountName:
          typeof channel.config?.accountName === 'string' ? channel.config.accountName : null,
        scopeKey: typeof channel.config?.scopeKey === 'string' ? channel.config.scopeKey : null,
        routable: true,
        features: Array.isArray(channel.config?.features)
          ? channel.config.features.filter(
              (item): item is BotChannelConnection['features'][number] => typeof item === 'string',
            )
          : [],
      });
    }
    return [...byKey.values()].sort(
      (a, b) =>
        channelLabel(a.kind).localeCompare(channelLabel(b.kind)) ||
        Number(b.connected) - Number(a.connected) ||
        (a.accountName ?? a.accountKey ?? '').localeCompare(b.accountName ?? b.accountKey ?? ''),
    );
  }, [bot.channels, channelConnections]);

  const mountedChannelFor = (connection: BotChannelConnection) =>
    (bot.channels ?? []).find((channel) => {
      if (!channel.enabled || channel.kind !== connection.kind) return false;
      const accountKey =
        typeof channel.config?.accountKey === 'string' ? channel.config.accountKey.trim() : '';
      const ownership =
        channel.config?.ownership === 'server-relay' ? 'server-relay' : 'local-adapter';
      return accountKey === connection.accountKey && ownership === connection.ownership;
    });

  const toggleChannel = async (connection: BotChannelConnection) => {
    if (!connection.accountKey || !connection.routable) return;
    setChannelBusy(connection.id);
    setChannelError(null);
    try {
      const mounted = mountedChannelFor(connection);
      if (mounted) {
        const migration = migrationRecords.find(
          (row) => row.channelId === mounted.id && row.status === 'applied',
        );
        if (migration) {
          setRollbackRecord(migration);
        } else {
          await upsertBotChannel(bot.id, connection.kind, false, mounted.config, mounted.id);
        }
        return;
      }
      setMigrationPlan(await planBotImMigration(bot.id, connection.id));
    } catch {
      setChannelError(t('bots.migration.errors.preflight'));
    } finally {
      setChannelBusy(null);
    }
  };

  const confirmMigration = async () => {
    if (!migrationPlan) return;
    setChannelBusy(migrationPlan.connection.id);
    setChannelError(null);
    try {
      await applyBotImMigration(
        bot.id,
        migrationPlan.connection.id,
        migrationPlan.planHash,
        globalThis.crypto.randomUUID(),
      );
      setMigrationRecords(await listBotImMigrations(bot.id));
      setMigrationPlan(null);
    } catch {
      setChannelError(t('bots.migration.errors.apply'));
    } finally {
      setChannelBusy(null);
    }
  };

  const confirmRollback = async () => {
    if (!rollbackRecord) return;
    setChannelBusy(rollbackRecord.connectionId);
    setChannelError(null);
    try {
      const result = await rollbackBotImMigration(bot.id, rollbackRecord.id);
      setMigrationRecords(await listBotImMigrations(bot.id));
      setRollbackRecord(null);
      const bindingWarning = result.warnings?.find(
        (warning) => warning.code === 'binding-restore-conflict',
      );
      if (bindingWarning) {
        setChannelError(
          t('bots.migration.warnings.binding-restore-conflict', {
            count: bindingWarning.count,
          }),
        );
      }
    } catch {
      setChannelError(t('bots.migration.errors.rollback'));
    } finally {
      setChannelBusy(null);
    }
  };
  if (bot.status === 'archived') {
    return (
      <main className="h-full overflow-y-auto bg-[var(--surface)] px-8 py-8" role="main">
        <div className="mx-auto flex max-w-4xl flex-col gap-5">
          <button
            type="button"
            onClick={onBack}
            className="-ml-2 inline-flex w-fit items-center gap-2 rounded-lg px-2 py-1.5 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <ArrowLeft size={15} />
            {t('bots.title')}
          </button>
          <header className="flex items-center gap-3">
            <BotAvatar bot={bot} size="h-14 w-14" />
            <div>
              <p className="text-12 font-medium uppercase tracking-[0.16em] text-[var(--text-tertiary)]">
                {t('bots.lifecycle.archivedTitle')}
              </p>
              <h1 className="mt-1 text-24 font-medium text-[var(--text-primary)]">{bot.name}</h1>
              {bot.description ? (
                <p className="mt-1 text-12 text-[var(--text-secondary)]">{bot.description}</p>
              ) : null}
            </div>
          </header>
          <BotLifecycleSettings bot={bot} onOpenSession={onOpenSession} />
          <BotEventInboxSettings bot={bot} />
        </div>
      </main>
    );
  }
  return (
    <main className="h-full overflow-y-auto bg-[var(--surface)] px-8 py-8" role="main">
      <div className="mx-auto flex max-w-4xl flex-col gap-5">
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 inline-flex w-fit items-center gap-2 rounded-lg px-2 py-1.5 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <ArrowLeft size={15} />
          {t('bots.backToChat')}
        </button>
        <header className="flex items-center gap-3">
          <BotAvatar bot={{ ...bot, avatar, avatarColor }} size="h-14 w-14" />
          <div>
            <p className="text-12 font-medium uppercase tracking-[0.16em] text-[var(--text-tertiary)]">
              {t('bots.settings')}
            </p>
            <h1 className="mt-1 text-24 font-medium text-[var(--text-primary)]">{bot.name}</h1>
          </div>
        </header>

        <section className="flex items-center justify-between gap-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
          <div>
            <p className="text-13 font-medium text-[var(--text-primary)]">
              {t('bots.sessionLifecycleTitle')}
            </p>
            <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
              {t('bots.sessionLifecycleDescription')}
            </p>
          </div>
          <button
            type="button"
            onClick={renewAndApplyProfile}
            disabled={renewing}
            className="inline-flex h-8 shrink-0 items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 text-12 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            <RefreshCcw size={14} className={renewing ? 'animate-spin' : undefined} />
            {renewing ? t('bots.renewing') : t('bots.renew')}
          </button>
        </section>
        {profileApplyError ? (
          <p className="-mt-2 text-12 text-[var(--text-danger)]" role="alert">
            {profileApplyError}
          </p>
        ) : null}

        <BotLifecycleSettings bot={bot} onOpenSession={onOpenSession} />

        <BotEventInboxSettings bot={bot} />

        <BotProjectSettings bot={bot} />

        <BotRouteSettings bot={bot} onOpenTask={onOpenSession} />

        <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
          <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
            <Bot size={16} />
            {t('bots.channelsTitle')}
          </div>
          <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
            {t('bots.channelsDescription')}
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-xl border border-[var(--border-default)] px-3 py-2">
              <span>
                <span className="block text-12 text-[var(--text-primary)]">
                  {channelLabel('local')}
                </span>
                <span className="block text-10 text-[var(--text-tertiary)]">
                  {t('bots.channelLocalOwned')}
                </span>
              </span>
              <span className="text-11 text-[var(--text-secondary)]">
                {t('bots.channelMounted')}
              </span>
            </div>
            {visibleChannelConnections.map((connection) => {
              const mounted = mountedChannelFor(connection);
              const label =
                connection.accountName || connection.accountKey || channelLabel(connection.kind);
              return (
                <div
                  key={connection.id}
                  className="rounded-xl border border-[var(--border-default)] px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-12 text-[var(--text-primary)]">
                        {channelLabel(connection.kind)} · {label}
                      </span>
                      <span className="block truncate text-10 text-[var(--text-tertiary)]">
                        {connection.ownership === 'server-relay'
                          ? t('bots.channelServerRelay')
                          : t('bots.channelLocalAdapter')}
                        {' · '}
                        {connection.connected
                          ? t('bots.channelConnected')
                          : t('bots.channelOffline')}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={channelBusy !== null || !connection.routable}
                      onClick={() => void toggleChannel(connection)}
                      className="h-7 shrink-0 rounded-full border border-[var(--border-default)] px-2.5 text-10 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:cursor-default disabled:opacity-70"
                    >
                      {channelBusy === connection.id
                        ? '…'
                        : mounted
                          ? t('bots.channelMounted')
                          : t('bots.channelMount')}
                    </button>
                  </div>
                  <BotChannelCapabilitySummary connection={connection} />
                </div>
              );
            })}
          </div>
          {visibleChannelConnections.length === 0 ? (
            <p className="mt-3 rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-12 text-[var(--text-tertiary)]">
              {t('bots.channelConnectionRequired', { channel: 'IM' })}
            </p>
          ) : null}
          {channelError ? (
            <p className="mt-3 text-11 text-[var(--text-danger)]">{channelError}</p>
          ) : null}
        </section>

        <Dialog.Root
          open={migrationPlan !== null}
          onOpenChange={(open) => {
            if (!open && channelBusy === null) setMigrationPlan(null);
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-32px)] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 outline-none">
              <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">
                {t('bots.migration.title')}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                {t('bots.migration.description')}
              </Dialog.Description>
              {migrationPlan ? (
                <div className="mt-4 space-y-3">
                  <div className="rounded-xl bg-[var(--surface-chip)] p-3 text-12 text-[var(--text-secondary)]">
                    <p className="font-medium text-[var(--text-primary)]">
                      {channelLabel(migrationPlan.connection.kind)} ·{' '}
                      {migrationPlan.connection.accountName || migrationPlan.connection.accountKey}
                    </p>
                    <p className="mt-1">
                      {t('bots.migration.legacyTaskCount', {
                        count: migrationPlan.candidates.length,
                      })}
                    </p>
                  </div>
                  {migrationPlan.conflicts.length > 0 ? (
                    <div className="rounded-xl border border-[var(--text-danger)]/30 bg-[var(--surface-chip)] p-3">
                      <p className="text-12 font-medium text-[var(--text-danger)]">
                        {t('bots.migration.blocked')}
                      </p>
                      <ul className="mt-2 list-disc space-y-1 pl-4 text-11 text-[var(--text-secondary)]">
                        {migrationPlan.conflicts.map((conflict, index) => (
                          <li key={`${conflict.code}:${conflict.sessionId ?? index}`}>
                            {t(`bots.migration.conflicts.${conflict.code}`)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {migrationPlan.warnings.length > 0 ? (
                    <ul className="list-disc space-y-1 pl-4 text-11 text-[var(--text-secondary)]">
                      {migrationPlan.warnings.map((warning) => (
                        <li key={warning.code}>{t(`bots.migration.warnings.${warning.code}`)}</li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="text-11 leading-5 text-[var(--text-tertiary)]">
                    {t('bots.migration.preserveData')}
                  </p>
                </div>
              ) : null}
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={channelBusy !== null}
                  onClick={() => setMigrationPlan(null)}
                  className="h-8 rounded-lg px-3 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                >
                  {t('bots.cancel')}
                </button>
                <button
                  type="button"
                  disabled={!migrationPlan?.canApply || channelBusy !== null}
                  onClick={() => void confirmMigration()}
                  className="h-8 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-11 font-medium text-[var(--accent-pure-cta-fg)] disabled:opacity-50"
                >
                  {channelBusy ? t('bots.migration.applying') : t('bots.migration.apply')}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <Dialog.Root
          open={rollbackRecord !== null}
          onOpenChange={(open) => {
            if (!open && channelBusy === null) setRollbackRecord(null);
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 outline-none">
              <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">
                {t('bots.migration.rollbackTitle')}
              </Dialog.Title>
              <Dialog.Description className="mt-2 text-12 leading-5 text-[var(--text-secondary)]">
                {t('bots.migration.rollbackDescription')}
              </Dialog.Description>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={channelBusy !== null}
                  onClick={() => setRollbackRecord(null)}
                  className="h-8 rounded-lg px-3 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                >
                  {t('bots.cancel')}
                </button>
                <button
                  type="button"
                  disabled={channelBusy !== null}
                  onClick={() => void confirmRollback()}
                  className="h-8 rounded-lg border border-[var(--border-default)] px-3 text-11 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                >
                  {channelBusy ? t('bots.migration.rollingBack') : t('bots.migration.rollback')}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
          <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
            <ImagePlus size={16} />
            {t('bots.identityTitle')}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {AVATARS.map((item) => (
              <button
                type="button"
                key={item}
                onClick={() => setAvatar(item)}
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-xl border text-lg',
                  avatar === item
                    ? 'border-[var(--focus-ring-soft)] bg-[var(--surface-chip)]'
                    : 'border-[var(--border-default)] hover:bg-[var(--surface-hover)]',
                )}
                aria-label={t('bots.chooseAvatar', { avatar: item })}
              >
                {item}
              </button>
            ))}
            <div className="ml-2 flex items-center gap-1.5">
              {AVATAR_COLORS.map((item) => (
                <button
                  type="button"
                  key={item}
                  onClick={() => setAvatarColor(item)}
                  className={cn(
                    'h-5 w-5 rounded-full border-2 border-[var(--surface-elevated)] outline outline-1 outline-[var(--border-default)]',
                    avatarColor === item && 'ring-2 ring-[var(--focus-ring-soft)]',
                  )}
                  style={avatarColorStyle(item)}
                  aria-label={t('bots.chooseAvatarColor', { color: item })}
                />
              ))}
            </div>
          </div>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
              {t('bots.nameLabel')}
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
              />
            </label>
            <div className="flex flex-col justify-end text-12 text-[var(--text-tertiary)]">
              {t('bots.channelLabel')}: {channelLabel(bot.channel)}
            </div>
          </div>
          <label className="mt-4 flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
            {t('bots.descriptionLabel')}
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              className="resize-none rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
            />
          </label>
          <label className="mt-4 flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
            {t('bots.identitySourceLabel')}
            <textarea
              value={identitySource}
              onChange={(event) => setIdentitySource(event.target.value)}
              placeholder={t('bots.identitySourcePlaceholder')}
              rows={6}
              className="resize-y rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
            />
            <span className="text-11 leading-5 text-[var(--text-tertiary)]">
              {t('bots.identitySourceDescription')}
            </span>
          </label>
          <label className="mt-4 flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
            {t('bots.userContextSourceLabel')}
            <textarea
              value={userContextSource}
              onChange={(event) => setUserContextSource(event.target.value)}
              placeholder={t('bots.userContextSourcePlaceholder')}
              rows={4}
              className="resize-y rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
            />
            <span className="text-11 leading-5 text-[var(--text-tertiary)]">
              {t('bots.userContextSourceDescription')}
            </span>
          </label>
        </section>

        <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
              <Sparkles size={16} />
              {t('bots.capabilitiesTitle')}
            </div>
            <span className="rounded-full bg-[var(--surface-chip)] px-2.5 py-1 text-10 text-[var(--text-secondary)]">
              {t(`bots.runtimeState.${runtimeState}`)}
            </span>
          </div>
          <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
            {t('bots.capabilitiesDescription')}
          </p>
          <p className="mt-2 rounded-lg bg-[var(--surface-chip)] px-3 py-2 text-11 leading-5 text-[var(--text-secondary)]">
            {t('bots.capabilitiesDeferred')}
          </p>
          <div className="mt-4 grid min-w-0 gap-4 md:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
              <span>{t('bots.harnessLabel')}</span>
              <VendorSegmentedSwitcher
                value={vendor}
                hiddenVendors={hiddenVendors}
                dense
                width={300}
                className="max-w-full"
                ariaLabel={t('bots.harnessLabel')}
                onChange={(next) => {
                  if (next === 'orca') return;
                  const prefs = getDraft().lastByVendor[next];
                  setCapabilities((current) => ({
                    ...current,
                    harness: next === 'cc' ? 'claude' : next,
                    model: prefs.model,
                    providerId: prefs.providerId ?? null,
                    effort: prefs.effort,
                    fastMode: getDraft().fastModeByModel[prefs.model] === true,
                    skillMode: 'inherit',
                  }));
                }}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
              <span>{t('bots.modelLabel')}</span>
              <ModelSelector
                modelId={capabilities.model}
                effort={capabilities.effort}
                vendorKey={vendor}
                currentProviderId={capabilities.providerId ?? null}
                triggerVariant="field"
                popoverSide="bottom"
                ariaContext={t('bots.modelLabel')}
                excludeSubscriptionDirect={sshRemote}
                excludeChatBridgedCodex={sshRemote}
                fastMode={vendor === 'cc' ? undefined : capabilities.fastMode}
                onFastModeChange={
                  vendor === 'cc' ? undefined : (enabled) => updateCapability('fastMode', enabled)
                }
                onModelChange={(model) => updateCapability('model', model)}
                onEffortChange={(effort) => updateCapability('effort', effort)}
                onProviderChange={(providerId, model, effort) =>
                  setCapabilities((current) => ({
                    ...current,
                    providerId,
                    model: model ?? current.model,
                    effort: effort || current.effort,
                  }))
                }
                onNavigateToProviders={() => navigate('/settings?tab=providers')}
                unknownModelLabel={(model) => t('bots.modelUnavailable', { model })}
              />
            </div>
          </div>
          <BotCapabilitySettings
            bot={bot}
            capabilities={capabilities}
            selectedSkills={selectedSkills}
            runtimeSnapshot={canonicalProjection?.runtimeSnapshot}
            remoteHostId={selectedProject?.remoteHostId}
            onCapabilitiesChange={setCapabilities}
            onSelectedSkillsChange={setSelectedSkills}
          />
          <label className="mt-4 flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
            {t('bots.permissionsLabel')}
            <select
              value={capabilities.permissions}
              onChange={(event) =>
                updateCapability(
                  'permissions',
                  event.target.value as BotCapabilities['permissions'],
                )
              }
              className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
            >
              <option value="ask">{t('bots.permissionAsk')}</option>
              <option value="trusted">{t('bots.permissionTrusted')}</option>
            </select>
          </label>
        </section>

        <BotAutomationSettings
          bot={bot}
          enabled={bot.capabilities.automation}
          trusted={bot.capabilities.permissions === 'trusted'}
          onOpenTask={onOpenSession}
        />

        <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
          <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
            <Download size={16} />
            {t('bots.portability.title')}
          </div>
          <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
            {t('bots.portability.description')}
          </p>
          {portabilityNotice ? (
            <p
              className="mt-3 rounded-lg bg-[var(--surface-chip)] px-3 py-2 text-11 leading-5 text-[var(--text-secondary)]"
              role="status"
            >
              {portabilityNotice}
            </p>
          ) : null}
          <button
            type="button"
            disabled={portabilityBusy}
            onClick={() => {
              setPortabilityBusy(true);
              setPortabilityNotice(null);
              void exportBotBundle(bot.id)
                .then((result) => {
                  if (!result.canceled) {
                    setPortabilityNotice(
                      result.redactionCount
                        ? t('bots.portability.exportedRedacted', { count: result.redactionCount })
                        : t('bots.portability.exported'),
                    );
                  }
                })
                .catch((error: unknown) => {
                  setPortabilityNotice(error instanceof Error ? error.message : String(error));
                })
                .finally(() => setPortabilityBusy(false));
            }}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 text-12 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            <Download size={14} />
            {portabilityBusy ? t('bots.portability.exporting') : t('bots.portability.export')}
          </button>
        </section>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onBack}
            className="h-9 rounded-lg px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
          >
            {t('bots.cancel')}
          </button>
          <button
            type="button"
            onClick={saveAndContinue}
            disabled={saving}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--accent-cta-bg)] px-3.5 text-12 font-medium text-[var(--accent-pure-cta-fg)] hover:opacity-90"
          >
            <Check size={15} />
            {t('bots.save')}
          </button>
        </div>
      </div>

      <Dialog.Root
        open={profileApplyPrompt !== null}
        onOpenChange={(open) => {
          if (!open && !renewing) setProfileApplyPrompt(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 outline-none">
            <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">
              {t('bots.profileApply.title')}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-12 leading-5 text-[var(--text-secondary)]">
              {profileApplyPrompt
                ? t('bots.profileApply.description', {
                    currentVersion: profileApplyPrompt.currentVersion,
                    activeVersion: profileApplyPrompt.activeVersion,
                  })
                : null}
            </Dialog.Description>
            {profileApplyError ? (
              <p className="mt-3 text-12 text-[var(--text-danger)]" role="alert">
                {profileApplyError}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={renewing}
                onClick={() => {
                  setProfileApplyPrompt(null);
                  onBack();
                }}
                className="h-8 rounded-lg px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
              >
                {t('bots.profileApply.keepCurrent')}
              </button>
              <button
                type="button"
                disabled={renewing}
                onClick={renewAndApplyProfile}
                className="inline-flex h-8 items-center gap-2 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-12 font-medium text-[var(--accent-pure-cta-fg)] hover:opacity-90 disabled:opacity-50"
              >
                <RefreshCcw size={14} className={renewing ? 'animate-spin' : undefined} />
                {renewing ? t('bots.renewing') : t('bots.profileApply.renewAndApply')}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}

export function BotsHomeView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { botId, sessionId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const bots = useBotProfiles();
  const creatingBotRef = useRef<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [createSessionError, setCreateSessionError] = useState<unknown>(null);
  const [addOpen, setAddOpen] = useState(searchParams.get('add') === '1');
  const importingRef = useRef(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const selectedBot = useMemo(() => bots.find((bot) => bot.id === botId) ?? null, [botId, bots]);
  const settingsOpen = searchParams.get('settings') === '1';

  const createCanonicalSession = useCallback(
    async (
      bot: BotProfile,
      expectedCanonicalSessionId: string | null = bot.canonicalSessionId ?? null,
      recoverMissingOnly = false,
    ): Promise<import('@/lib/ccAgent.types').Session> => {
      try {
        setCreateSessionError(null);
        const result = await window.electronAPI.localDb.bots.createCanonicalSession({
          botId: bot.id,
          expectedCanonicalSessionId,
          expectedProfileVersion: bot.currentVersion ?? 1,
          recoverMissingOnly,
        });
        const updated = result.session;
        setCanonicalBotSession(bot.id, {
          id: updated.id,
          title: updated.title,
          updatedAt: Date.now(),
        });
        return updated;
      } catch (error) {
        setCreateSessionError(error);
        throw error;
      }
    },
    [],
  );

  const renewBotSession = useCallback(
    async (bot: BotProfile): Promise<boolean> => {
      setIsCreatingSession(true);
      try {
        const next = await createCanonicalSession(bot);
        if (!next) return false;
        navigate(`/bots/${bot.id}/session/${next.id}`, { replace: true });
        return true;
      } catch {
        // The settings view remains mounted and can surface a localized error.
        return false;
      } finally {
        setIsCreatingSession(false);
      }
    },
    [createCanonicalSession, navigate],
  );

  useEffect(() => {
    if (!botId && bots[0]) {
      const target = bots.find((bot) => bot.status !== 'archived') ?? bots[0];
      const query = searchParams.toString();
      const nextQuery =
        target.status !== 'active'
          ? new URLSearchParams({ ...Object.fromEntries(searchParams), settings: '1' }).toString()
          : query;
      navigate(`/bots/${target.id}${nextQuery ? `?${nextQuery}` : ''}`, { replace: true });
    }
  }, [botId, bots, navigate, searchParams]);

  const headerContent = useMemo(
    () => (
      <div className="flex items-center gap-2 text-13 font-medium text-[var(--text-primary)]">
        <Bot size={15} />
        {selectedBot?.name ?? t('bots.title')}
      </div>
    ),
    [selectedBot?.name, t],
  );
  useRegisterContentHeader(headerContent);

  useEffect(() => {
    if (searchParams.get('add') === '1') setAddOpen(true);
  }, [searchParams]);

  useEffect(() => {
    if (searchParams.get('import') !== '1' || importingRef.current) return;
    importingRef.current = true;
    setSearchParams(
      (current) => {
        current.delete('import');
        return current;
      },
      { replace: true },
    );
    void importBotBundle()
      .then((result) => {
        if (result.canceled) return;
        setImportNotice(
          t('bots.portability.imported', {
            channels: result.disabledChannels?.length ?? 0,
            automations: result.pausedAutomations ?? 0,
          }),
        );
        if (result.botId) navigate(`/bots/${result.botId}?settings=1`, { replace: true });
      })
      .catch((error: unknown) => {
        setImportNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        importingRef.current = false;
      });
  }, [navigate, searchParams, setSearchParams, t]);

  useEffect(() => {
    if (!selectedBot || settingsOpen) return;
    if (selectedBot.status !== 'active') {
      navigate(`/bots/${selectedBot.id}?settings=1`, { replace: true });
      return;
    }

    const canonicalSessionId = selectedBot.canonicalSessionId;
    let cancelled = false;
    if (canonicalSessionId) {
      setIsCreatingSession(false);
      void sessionService
        .get(canonicalSessionId)
        .then(async (session) => {
          if (cancelled) return;
          if (session.status !== 'active') {
            setIsCreatingSession(true);
            const next = await createCanonicalSession(selectedBot);
            if (!cancelled) {
              setIsCreatingSession(false);
              if (next) navigate(`/bots/${selectedBot.id}/session/${next.id}`, { replace: true });
            }
            return;
          }
          if (session.source !== 'bot') {
            // A renderer-held canonicalSessionId is not authority to reclassify an
            // arbitrary existing Session. Preserve the existing task and create a
            // fresh Bot-owned Session instead.
            setIsCreatingSession(true);
            const next = await createCanonicalSession(selectedBot);
            if (!cancelled) {
              setIsCreatingSession(false);
              if (next) navigate(`/bots/${selectedBot.id}/session/${next.id}`, { replace: true });
            }
            return;
          }
          setCanonicalBotSession(selectedBot.id, {
            id: canonicalSessionId,
            title: session.title || selectedBot.name,
            updatedAt: Date.parse(session.updatedAt) || Date.now(),
          });
          if (!cancelled && sessionId !== canonicalSessionId) {
            navigate(`/bots/${selectedBot.id}/session/${canonicalSessionId}`, { replace: true });
          }
        })
        .catch(async () => {
          if (cancelled) return;
          setIsCreatingSession(true);
          // The profile pointer is still the CAS authority even when its Session
          // row disappeared. Passing null can never repair that state because
          // main correctly sees a non-null canonical pointer. Preserve the
          // observed id so a concurrent Renew still loses the CAS safely.
          const next = await createCanonicalSession(selectedBot, canonicalSessionId, true).catch(
            () => null,
          );
          if (!cancelled) {
            setIsCreatingSession(false);
            if (next) navigate(`/bots/${selectedBot.id}/session/${next.id}`, { replace: true });
          }
        });
      return;
    }

    if (sessionId || creatingBotRef.current === selectedBot.id) return;

    creatingBotRef.current = selectedBot.id;
    setIsCreatingSession(true);
    void createCanonicalSession(selectedBot)
      .then((session) => {
        if (cancelled) return;
        setIsCreatingSession(false);
        if (!session) {
          creatingBotRef.current = null;
          return;
        }
        navigate(`/bots/${selectedBot.id}/session/${session.id}`, { replace: true });
      })
      .catch(() => {
        if (cancelled) return;
        setIsCreatingSession(false);
        creatingBotRef.current = null;
      });

    return () => {
      cancelled = true;
    };
  }, [createCanonicalSession, selectedBot, sessionId, settingsOpen, navigate]);

  const openAdd = () => {
    setAddOpen(true);
    setSearchParams((current) => {
      current.set('add', '1');
      return current;
    });
  };
  const closeAdd = (open: boolean) => {
    setAddOpen(open);
    if (!open && searchParams.has('add'))
      setSearchParams(
        (current) => {
          current.delete('add');
          return current;
        },
        { replace: true },
      );
  };
  const handleCreated = (bot: BotProfile) => navigate(`/bots/${bot.id}`);

  if (!selectedBot) {
    return (
      <main
        className="h-full overflow-y-auto bg-[var(--surface)] px-4 py-6 sm:px-8 sm:py-8"
        role="main"
      >
        <div className="mx-auto flex max-w-3xl flex-col items-center py-10 text-center sm:py-20">
          <Bot size={34} className="text-[var(--text-tertiary)]" />
          <h1 className="mt-5 text-24 font-medium text-[var(--text-primary)]">
            {t('bots.emptyTitle')}
          </h1>
          <p className="mt-2 max-w-md text-13 leading-6 text-[var(--text-secondary)]">
            {t('bots.emptyDescription')}
          </p>
          <div className="mt-6 grid w-full gap-3 text-left sm:grid-cols-2">
            {(
              [
                [Sparkles, 'identity'],
                [BellRing, 'events'],
                [Clock3, 'automation'],
                [MessageCircleMore, 'channels'],
              ] as const
            ).map(([Icon, key]) => (
              <div
                key={String(key)}
                className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4"
              >
                <Icon size={16} className="text-[var(--text-secondary)]" />
                <p className="mt-3 text-13 font-medium text-[var(--text-primary)]">
                  {t(`bots.emptyBenefits.${key}.title`)}
                </p>
                <p className="mt-1 text-11 leading-5 text-[var(--text-secondary)]">
                  {t(`bots.emptyBenefits.${key}.description`)}
                </p>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={openAdd}
            className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--accent-cta-bg)] px-3.5 text-12 font-medium text-[var(--accent-pure-cta-fg)] hover:opacity-90"
          >
            <Plus size={15} />
            {t('bots.add')}
          </button>
        </div>
        <AddBotDialog open={addOpen} onOpenChange={closeAdd} onCreated={handleCreated} />
      </main>
    );
  }

  if (settingsOpen) {
    return (
      <>
        <BotSettings
          bot={selectedBot}
          onRenew={() => renewBotSession(selectedBot)}
          onOpenSession={(targetSessionId, searchJump) => {
            const projection = selectedBot.sessions.find((item) => item.id === targetSessionId);
            const route =
              projection?.kind === 'history'
                ? `/bots/${selectedBot.id}/history/${targetSessionId}`
                : `/bots/${selectedBot.id}/session/${targetSessionId}`;
            navigate(route, { state: searchJump ? { searchJump } : undefined });
          }}
          renewing={isCreatingSession}
          onBack={() => {
            if (selectedBot.status === 'archived') {
              navigate('/bots', { replace: true });
              return;
            }
            setSearchParams(
              (current) => {
                current.delete('settings');
                return current;
              },
              { replace: true },
            );
          }}
        />
        <AddBotDialog open={addOpen} onOpenChange={closeAdd} onCreated={handleCreated} />
      </>
    );
  }

  return (
    <>
      <main className="flex h-full items-center justify-center bg-[var(--surface)]" role="main">
        <p className="max-w-lg px-6 text-center text-13 text-[var(--text-secondary)]">
          {importNotice ??
            (createSessionError && !isCreatingSession
              ? t('ccAgent.draft.createSessionFailed')
              : t('ccAgent.common.loading'))}
        </p>
      </main>
      <AddBotDialog open={addOpen} onOpenChange={closeAdd} onCreated={handleCreated} />
    </>
  );
}
