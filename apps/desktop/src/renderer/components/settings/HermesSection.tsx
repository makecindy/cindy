import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ExternalLink,
  FolderOpen,
  Network,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { invalidateHermesModelCatalog } from '@/hooks/useHermesModelCatalog';
import { HarnessProvidersCard } from './HarnessProvidersCard';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_DIVIDER_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';

interface HermesMcpServerItem {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: string;
  disabled?: boolean;
}

interface HermesStatusData {
  homePath: string;
  route: { model?: string; provider?: string; baseUrl?: string };
  models: string[];
  mcpServers: Record<string, HermesMcpServerItem>;
  plugins: Array<{
    id: string;
    source?: string;
    revision?: string;
    enabled: boolean;
  }>;
  skills: string[];
  error?: string;
}

export function HermesSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<HermesStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>('');

  // MCP server form state
  const [showAddServer, setShowAddServer] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [newServerType, setNewServerType] = useState<'http' | 'stdio'>('http');
  const [newServerTarget, setNewServerTarget] = useState('');
  const [addingServer, setAddingServer] = useState(false);
  const [togglingPlugin, setTogglingPlugin] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setLoading(true);
      const data = await window.electronAPI.maker.hermesConfig.getStatus();
      setStatus(data);
      if (data.route?.model) {
        setSelectedModel(data.route.model);
      }
    } catch {
      toast.error('Failed to load Hermes status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleSaveModel = async () => {
    if (!status?.route?.provider || !selectedModel.trim()) return;
    try {
      setSaving(true);
      await window.electronAPI.maker.hermesConfig.setDefaultRoute({
        model: selectedModel.trim(),
        provider: status.route.provider,
        baseUrl: status.route.baseUrl,
      });
      invalidateHermesModelCatalog();
      toast.success(t('chat.composer.hermesDefaultSuccess', { model: selectedModel }));
      await loadStatus();
    } catch {
      toast.error('Failed to update Hermes default model');
    } finally {
      setSaving(false);
    }
  };

  const [backupBusy, setBackupBusy] = useState(false);
  const handleBackup = async () => {
    setBackupBusy(true);
    try {
      const r = await window.electronAPI.maker.backup.create();
      toast.success(`Backup saved: ${r.archivePath}`);
    } catch {
      toast.error('Backup failed');
    } finally {
      setBackupBusy(false);
    }
  };
  const handleRestore = async () => {
    try {
      await window.electronAPI.maker.backup.restore();
    } catch {
      toast.error('Restore failed');
    }
  };

  const handleRevealHome = () => {
    if (!status?.homePath) return;
    try {
      window.electronAPI.showItemInFolder({ filePath: status.homePath });
    } catch {
      void window.electronAPI.openPath(status.homePath);
    }
  };

  const handleAddServer = async () => {
    const name = newServerName.trim();
    const target = newServerTarget.trim();
    if (!name || !target) return;
    try {
      setAddingServer(true);
      const parts = target.split(/\s+/).filter(Boolean);
      const serverConfig: HermesMcpServerItem =
        newServerType === 'http'
          ? { url: target }
          : { command: parts[0] ?? '', ...(parts.length > 1 ? { args: parts.slice(1) } : {}) };
      await window.electronAPI.maker.hermesConfig.setMcpServer(name, serverConfig);
      toast.success(`MCP server "${name}" configured`);
      setShowAddServer(false);
      setNewServerName('');
      setNewServerTarget('');
      await loadStatus();
    } catch {
      toast.error('Failed to configure MCP server');
    } finally {
      setAddingServer(false);
    }
  };

  const handleRemoveServer = async (name: string) => {
    try {
      await window.electronAPI.maker.hermesConfig.removeMcpServer(name);
      toast.success(`MCP server "${name}" removed`);
      await loadStatus();
    } catch {
      toast.error('Failed to remove MCP server');
    }
  };

  // Runs `hermes plugins enable|disable <id>` via the daemon; Hermes owns config.yaml.
  // Applies to new chats; a running chat keeps the plugins it started with.
  const handleTogglePlugin = async (id: string, enabled: boolean) => {
    setTogglingPlugin(id);
    try {
      await window.electronAPI.maker.hermesConfig.setPluginEnabled(id, enabled);
      toast.success(`Plugin "${id}" ${enabled ? 'enabled' : 'disabled'}. Applies to new chats.`);
      await loadStatus();
    } catch (error) {
      toast.error(
        `Could not ${enabled ? 'enable' : 'disable'} "${id}": ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setTogglingPlugin(null);
    }
  };

  const currentModel = status?.route?.model ?? '';
  const hasModelChanged = selectedModel.trim() !== currentModel && selectedModel.trim().length > 0;
  const configuredServers = Object.entries(status?.mcpServers ?? {});

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-center justify-between">
        <h2 className={SETTINGS_SECTION_TITLE_CLASS}>Hermes Harness</h2>
        <Button
          variant="secondary"
          tone="quiet"
          size="sm"
          onClick={() => void loadStatus()}
          disabled={loading}
          className="h-8 gap-1.5 px-2 text-12 text-[var(--settings-section-desc)]"
        >
          <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
          {t('common.refresh', 'Refresh')}
        </Button>
      </div>

      <div className={SETTINGS_CARD_CLASS}>
        {/* Row 1: Home & Runtime Status */}
        <div className={SETTINGS_ROW_CLASS}>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className={SETTINGS_ROW_LABEL_CLASS}>Hermes Home</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-11 font-medium text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Active
              </span>
            </div>
            <span className={cn(SETTINGS_ROW_HINT_CLASS, 'font-mono text-11')}>
              {status?.homePath ?? '~/.hermes-cindy'}
            </span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRevealHome}
            className="h-8 gap-1.5 text-12 shrink-0"
          >
            <FolderOpen size={14} />
            Reveal Folder
          </Button>
        </div>

        <div className={SETTINGS_ROW_DIVIDER_CLASS} />

        {/* Row 2: Default Model Route */}
        <div className={SETTINGS_ROW_CLASS}>
          <div className="flex min-w-0 flex-col gap-1">
            <span className={SETTINGS_ROW_LABEL_CLASS}>Home Default Model</span>
            <span className={SETTINGS_ROW_HINT_CLASS}>
              Provider:{' '}
              <code className="font-mono text-[var(--text-primary)]">
                {status?.route?.provider ?? 'none'}
              </code>
              {status?.route?.baseUrl && (
                <span className="ml-1 text-[var(--text-tertiary)]">({status.route.baseUrl})</span>
              )}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {status?.models && status.models.length > 0 ? (
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="h-8 rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--settings-menu-bg)] px-2.5 text-12 text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
              >
                {status.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                placeholder="Model name"
                className="h-8 w-44 rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--settings-menu-bg)] px-2.5 font-mono text-12 text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
              />
            )}

            <Button
              size="sm"
              onClick={() => void handleSaveModel()}
              disabled={!hasModelChanged || saving}
              className="h-8 text-12"
            >
              {saving ? <Spinner size="sm" /> : t('common.save', 'Save')}
            </Button>
          </div>
        </div>

        <div className={SETTINGS_ROW_DIVIDER_CLASS} />

        {/* Row 2b: Provider Registry (~/.cindy-harness/providers.yaml) */}
        <HarnessProvidersCard />

        <div className={SETTINGS_ROW_DIVIDER_CLASS} />

        {/* Row 3: MCP Servers Bridge */}
        <div className={cn(SETTINGS_ROW_CLASS, 'items-start flex-col gap-3')}>
          <div className="flex w-full items-center justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <Network size={14} className="text-violet-500" />
                <span className={SETTINGS_ROW_LABEL_CLASS}>MCP Servers</span>
                <span className="text-11 text-[var(--text-tertiary)]">
                  ({configuredServers.length})
                </span>
              </div>
              <span className={SETTINGS_ROW_HINT_CLASS}>
                Model Context Protocol servers loaded on every Hermes turn via{' '}
                <code className="font-mono">config.yaml</code>
              </span>
            </div>

            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowAddServer(!showAddServer)}
              className="h-8 gap-1.5 text-12 shrink-0"
            >
              {showAddServer ? <X size={13} /> : <Plus size={13} />}
              {showAddServer ? 'Cancel' : 'Add Server'}
            </Button>
          </div>

          {/* Add Server Inline Form */}
          {showAddServer && (
            <div className="flex w-full flex-col gap-2.5 rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--settings-menu-bg)] p-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Server name (e.g. cindy_bridge)"
                  value={newServerName}
                  onChange={(e) => setNewServerName(e.target.value)}
                  className="h-8 flex-1 rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--bg-card)] px-2.5 text-12 font-mono text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
                />
                <select
                  value={newServerType}
                  onChange={(e) => setNewServerType(e.target.value as 'http' | 'stdio')}
                  className="h-8 rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--bg-card)] px-2.5 text-12 text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
                >
                  <option value="http">Streamable HTTP / SSE</option>
                  <option value="stdio">Stdio Command</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder={
                    newServerType === 'http'
                      ? 'http://127.0.0.1:port/mcp/endpoint'
                      : 'command args (e.g. npx -y @modelcontextprotocol/server-sqlite)'
                  }
                  value={newServerTarget}
                  onChange={(e) => setNewServerTarget(e.target.value)}
                  className="h-8 flex-1 rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--bg-card)] px-2.5 text-12 font-mono text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
                />
                <Button
                  size="sm"
                  onClick={() => void handleAddServer()}
                  disabled={!newServerName.trim() || !newServerTarget.trim() || addingServer}
                  className="h-8 text-12 shrink-0"
                >
                  {addingServer ? <Spinner size="sm" /> : 'Confirm'}
                </Button>
              </div>
            </div>
          )}

          {/* Configured MCP Server List */}
          <div className="flex w-full flex-col gap-2">
            {configuredServers.length > 0 ? (
              configuredServers.map(([name, srv]) => (
                <div
                  key={name}
                  className="flex items-center justify-between rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--settings-menu-bg)] px-3 py-2 text-12"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[var(--text-primary)]">{name}</span>
                      <span className="rounded bg-[var(--bg-card)] px-1.5 py-0.5 text-10 font-mono text-[var(--text-secondary)] border border-[var(--settings-theme-card-border)]">
                        {srv.url ? 'http' : 'stdio'}
                      </span>
                      {srv.disabled && (
                        <span className="text-10 text-[var(--text-tertiary)]">disabled</span>
                      )}
                    </div>
                    <span className="truncate font-mono text-11 text-[var(--text-tertiary)] max-w-[500px]">
                      {srv.url ? srv.url : `${srv.command ?? ''} ${(srv.args ?? []).join(' ')}`}
                    </span>
                  </div>

                  <Button
                    variant="secondary"
                    tone="quiet"
                    size="sm"
                    onClick={() => void handleRemoveServer(name)}
                    className="h-7 w-7 p-0 text-[var(--text-tertiary)] hover:text-red-500"
                    title={`Remove ${name}`}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))
            ) : (
              <div className="flex items-center justify-between rounded-lg border border-dashed border-[var(--settings-theme-card-border)] px-3 py-2.5 text-12 text-[var(--text-tertiary)]">
                <span>No MCP servers configured in Hermes. Connect tools via HTTP or stdio.</span>
              </div>
            )}
          </div>
        </div>

        <div className={SETTINGS_ROW_DIVIDER_CLASS} />

        {/* Row: Local backup / restore */}
        <div className={SETTINGS_ROW_CLASS}>
          <div className="flex min-w-0 flex-col gap-1">
            <span className={SETTINGS_ROW_LABEL_CLASS}>Backup</span>
            <span className={SETTINGS_ROW_HINT_CLASS}>
              Archives the Cindy database, Hermes home (no caches or keys) and experts to{' '}
              <code className="font-mono">~/.cindy-harness/backups</code>
            </span>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleBackup()}
              disabled={backupBusy}
              className="h-8 text-12"
            >
              Back up now
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleRestore()}
              className="h-8 text-12"
            >
              Restore…
            </Button>
          </div>
        </div>

        <div className={SETTINGS_ROW_DIVIDER_CLASS} />

        {/* Row 4: Installed Plugins */}
        <div className={cn(SETTINGS_ROW_CLASS, 'items-start')}>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <Sparkles size={14} className="text-amber-500" />
              <span className={SETTINGS_ROW_LABEL_CLASS}>Plugins</span>
            </div>
            <span className={SETTINGS_ROW_HINT_CLASS}>
              Headless Hermes plugins installed in{' '}
              <code className="font-mono">~/.hermes-cindy/plugins</code>. Changes apply to new chats.
            </span>
          </div>

          <div className="flex flex-col items-end gap-1.5">
            {status?.plugins && status.plugins.length > 0 ? (
              status.plugins.map((plugin) => (
                <div
                  key={plugin.id}
                  className="flex items-center gap-2 rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--settings-menu-bg)] px-2.5 py-1 text-12"
                >
                  <span className="font-medium text-[var(--text-primary)]">{plugin.id}</span>
                  {plugin.enabled ? (
                    <span className="inline-flex items-center gap-0.5 text-11 text-emerald-600 dark:text-emerald-400">
                      <Check size={12} />
                      Enabled
                    </span>
                  ) : (
                    <span className="text-11 text-[var(--text-tertiary)]">Disabled</span>
                  )}
                  <Switch
                    checked={plugin.enabled}
                    disabled={togglingPlugin !== null}
                    onCheckedChange={(v) => void handleTogglePlugin(plugin.id, v)}
                    aria-label={`${plugin.enabled ? 'Disable' : 'Enable'} plugin ${plugin.id}`}
                  />
                  {plugin.source && (
                    <a
                      href={plugin.source}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    >
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              ))
            ) : (
              <span className="text-12 text-[var(--text-tertiary)]">No plugins installed</span>
            )}
          </div>
        </div>

        <div className={SETTINGS_ROW_DIVIDER_CLASS} />

        {/* Row 5: Built-in Skills */}
        <div className={cn(SETTINGS_ROW_CLASS, 'items-start')}>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <Wrench size={14} className="text-blue-500" />
              <span className={SETTINGS_ROW_LABEL_CLASS}>Skills</span>
            </div>
            <span className={SETTINGS_ROW_HINT_CLASS}>
              {status?.skills ? `${status.skills.length} categories active` : 'Active categories'}
            </span>
          </div>

          <div className="flex max-w-[420px] flex-wrap justify-end gap-1.5">
            {status?.skills && status.skills.length > 0 ? (
              status.skills.map((skill) => (
                <span
                  key={skill}
                  className="rounded-md bg-[var(--settings-menu-bg)] px-2 py-0.5 text-11 text-[var(--text-secondary)] border border-[var(--settings-theme-card-border)]"
                >
                  {skill}
                </span>
              ))
            ) : (
              <span className="text-12 text-[var(--text-tertiary)]">None</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
