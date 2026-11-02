import { Fragment, useEffect, useRef, useState } from 'react';
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
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_DIVIDER_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';

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
    <div id="settings-search-target-local-agent" className="mt-6 flex flex-col gap-[14px]">
      <h2 className={SETTINGS_SECTION_TITLE_CLASS}>{t('localAgent.title')}</h2>
      <div
        className={SETTINGS_CARD_CLASS}
        aria-busy={loading || Boolean(revoking) || Boolean(saving)}
      >
        {developer && (
          <>
            <div className={SETTINGS_ROW_CLASS}>
              <div className="flex min-w-0 flex-col gap-1">
                <p className={SETTINGS_ROW_LABEL_CLASS}>{t('localAgent.developerConnection')}</p>
                <p role="status" className={SETTINGS_ROW_HINT_CLASS}>
                  {t(`localAgent.developerState.${developer.state}`)}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                disabled={developer.state !== 'ready' || copying}
                onClick={() => void copyConnection()}
              >
                {t('localAgent.copyCode')}
              </Button>
            </div>
            <div className={SETTINGS_ROW_DIVIDER_CLASS} />
          </>
        )}
        {connections.length ? (
          connections.map((connection, index) => (
            <Fragment key={connection.id}>
              {index > 0 && <div className={SETTINGS_ROW_DIVIDER_CLASS} />}
              <div className={SETTINGS_ROW_CLASS}>
                <div className="flex min-w-0 flex-col gap-1">
                  <p className={`${SETTINGS_ROW_LABEL_CLASS} break-words`}>{connection.name}</p>
                  <p className={`${SETTINGS_ROW_HINT_CLASS} break-all`}>
                    {connection.clientId
                      ? t('localAgent.clientId', { id: connection.clientId })
                      : t('localAgent.description')}
                  </p>
                </div>
                <Button
                  className="shrink-0"
                  variant="secondary"
                  size="sm"
                  disabled={Boolean(revoking) || Boolean(saving)}
                  aria-label={t('localAgent.revokeConnection', { app: connection.name })}
                  onClick={() => void revoke(connection.id)}
                >
                  {t(revoking === connection.id ? 'localAgent.revoking' : 'localAgent.revoke')}
                </Button>
              </div>
              <div className={SETTINGS_ROW_CLASS}>
                <div className="flex min-w-0 flex-col gap-1">
                  <label
                    htmlFor={`local-agent-visible-${connection.id}`}
                    className={SETTINGS_ROW_LABEL_CLASS}
                  >
                    {t('localAgent.createVisibleSessions')}
                  </label>
                  <p
                    id={`local-agent-visible-hint-${connection.id}`}
                    className={SETTINGS_ROW_HINT_CLASS}
                  >
                    {t('localAgent.createVisibleSessionsHint')}
                  </p>
                </div>
                <Switch
                  id={`local-agent-visible-${connection.id}`}
                  aria-describedby={`local-agent-visible-hint-${connection.id}`}
                  checked={connection.createVisibleSessions === true}
                  disabled={Boolean(revoking) || Boolean(saving)}
                  onCheckedChange={(enabled) => void setVisibleSessions(connection.id, enabled)}
                />
              </div>
            </Fragment>
          ))
        ) : (
          <div className={SETTINGS_ROW_CLASS}>
            <div className="flex min-w-0 flex-col gap-1">
              <p role={failed ? 'status' : undefined} className={SETTINGS_ROW_LABEL_CLASS}>
                {t(
                  loading
                    ? 'localAgent.loading'
                    : failed
                      ? 'localAgent.failed'
                      : 'localAgent.empty',
                )}
              </p>
              {!loading && !failed && (
                <p className={SETTINGS_ROW_HINT_CLASS}>{t('localAgent.description')}</p>
              )}
            </div>
          </div>
        )}
      </div>
      {failed && connections.length > 0 && (
        <p role="status" className={SETTINGS_ROW_HINT_CLASS}>
          {t('localAgent.failed')}
        </p>
      )}
    </div>
  );
}
