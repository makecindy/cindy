import { localAgentSettings } from './LocalAgentSection.settings-search';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import type {
  LocalAgentConnection,
  LocalAgentDeveloperConnection,
} from '../../../shared/localAgent';
import {
  SETTINGS_HINT,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from '@/components/ui/settings-rows';

export function LocalAgentSection() {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<LocalAgentConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revoking, setRevoking] = useState<string>();
  const [saving, setSaving] = useState<string>();
  const [developer, setDeveloper] = useState<LocalAgentDeveloperConnection | null>(null);
  const [copying, setCopying] = useState(false);
  const copyingRef = useRef(false);
  const busy = useRef(false);
  useEffect(() => {
    let alive = true,
      revision = 0;
    const refresh = () => {
      const request = ++revision;
      void window.electronAPI.localAgent
        .developerConnection()
        .then((value) => {
          if (alive && revision === request) setDeveloper(value);
        })
        .catch(() => {
          if (alive && revision === request) {
            setDeveloper((previous) => (previous ? { state: 'failed' } : null));
            setFailed(true);
          }
        });
      void window.electronAPI.localAgent
        .connections()
        .then((value) => {
          if (alive && revision === request) {
            setConnections(value);
            setFailed(false);
          }
        })
        .catch(() => {
          if (alive && revision === request) setFailed(true);
        })
        .finally(() => {
          if (alive && revision === request) setLoading(false);
        });
    };
    const unsubscribe = window.electronAPI.localAgent.onConnectionsChanged(refresh);
    refresh();
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  const copyConnection = async () => {
    if (copyingRef.current) return;
    copyingRef.current = true;
    setCopying(true);
    try {
      const value = await window.electronAPI.localAgent.developerConnection();
      setDeveloper(value);
      if (!value || value.state !== 'ready') return;
      await navigator.clipboard.writeText(value.code);
      toast.success(t('localAgent.codeCopied'));
    } catch {
      toast.error(t('localAgent.codeCopyFailed'));
    } finally {
      copyingRef.current = false;
      setCopying(false);
    }
  };
  const revoke = async (id: string) => {
    if (busy.current) return;
    busy.current = true;
    setRevoking(id);
    try {
      if (await window.electronAPI.localAgent.revoke(id)) {
        setConnections((previous) => previous.filter((item) => item.id !== id));
        setFailed(false);
      }
    } catch (error) {
      toast.error(extractIpcError(error)?.message ?? t('localAgent.revokeFailed'));
    } finally {
      busy.current = false;
      setRevoking(undefined);
    }
  };
  const setVisibleSessions = async (id: string, enabled: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(id);
    try {
      if (!(await window.electronAPI.localAgent.setCreateVisibleSessions(id, enabled)))
        throw new Error('Connection unavailable');
      setConnections((previous) =>
        previous.map((connection) =>
          connection.id === id ? { ...connection, createVisibleSessions: enabled } : connection,
        ),
      );
    } catch (error) {
      toast.error(extractIpcError(error)?.message ?? t('localAgent.saveFailed'));
    } finally {
      busy.current = false;
      setSaving(undefined);
    }
  };
  return (
    <SettingsSection
      id={localAgentSettings.connections.targetId}
      className="mt-6"
      title={t(localAgentSettings.connections.titleKey)}
      aria-busy={loading || Boolean(revoking) || Boolean(saving)}
    >
      {/* 每个连接一张卡片：撤销和它下面的开关属于同一个应用。 */}
      {developer && (
        <SettingsCard>
          <SettingsRow
            title={t('localAgent.developerConnection')}
            hint={<span role="status">{t(`localAgent.developerState.${developer.state}`)}</span>}
            trailing={
              <Button
                data-setting-id={localAgentSettings.connections.id}
                variant="secondary"
                size="sm"
                className="shrink-0"
                disabled={developer.state !== 'ready' || copying}
                onClick={() => void copyConnection()}
              >
                {t('localAgent.copyCode')}
              </Button>
            }
          />
        </SettingsCard>
      )}
      {connections.length ? (
        connections.map((connection) => (
          <SettingsCard key={connection.id}>
            <SettingsRow
              title={connection.name}
              hint={
                <span className="break-all">
                  {connection.clientId
                    ? t('localAgent.clientId', { id: connection.clientId })
                    : t('localAgent.description')}
                </span>
              }
              trailing={
                <Button
                  data-settings-search-action="Revoke the selected local agent connection"
                  className="shrink-0"
                  variant="secondary"
                  size="sm"
                  disabled={Boolean(revoking) || Boolean(saving)}
                  aria-label={t('localAgent.revokeConnection', { app: connection.name })}
                  onClick={() => void revoke(connection.id)}
                >
                  {t(revoking === connection.id ? 'localAgent.revoking' : 'localAgent.revoke')}
                </Button>
              }
            />
            <SettingsRow
              title={
                <label htmlFor={`local-agent-visible-${connection.id}`}>
                  {t('localAgent.createVisibleSessions')}
                </label>
              }
              hint={
                <span id={`local-agent-visible-hint-${connection.id}`}>
                  {t('localAgent.createVisibleSessionsHint')}
                </span>
              }
              trailing={
                <Switch
                  data-setting-id={localAgentSettings.connections.id}
                  id={`local-agent-visible-${connection.id}`}
                  aria-describedby={`local-agent-visible-hint-${connection.id}`}
                  checked={connection.createVisibleSessions === true}
                  disabled={Boolean(revoking) || Boolean(saving)}
                  onCheckedChange={(enabled) => void setVisibleSessions(connection.id, enabled)}
                />
              }
            />
          </SettingsCard>
        ))
      ) : (
        <SettingsCard>
          <SettingsRow
            title={
              <span role={failed ? 'status' : undefined}>
                {t(
                  loading
                    ? 'localAgent.loading'
                    : failed
                      ? 'localAgent.failed'
                      : 'localAgent.empty',
                )}
              </span>
            }
            hint={!loading && !failed ? t('localAgent.description') : undefined}
          />
        </SettingsCard>
      )}
      {failed && connections.length > 0 && (
        <p role="status" className={SETTINGS_HINT}>
          {t('localAgent.failed')}
        </p>
      )}
    </SettingsSection>
  );
}
