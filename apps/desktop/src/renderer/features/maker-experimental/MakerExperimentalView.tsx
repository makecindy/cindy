/**
 * MakerExperimentalView — Maker IPC / agent event 链路的独立诊断页面。
 *
 * 路由：/maker-experimental
 *
 * 设计意图：
 * - 不替换标准 chat UI
 * - 给开发者一个最小入口验证 maker:* IPC 链路通畅
 * - 显示原始 AgentEvent JSON，方便诊断
 */

import { useState, useEffect, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import { useMakerSession } from '@/hooks/useMakerSession';

const CLAUDE_MODELS = ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
const CODEX_MODELS = ['gpt-5'];

type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
type PermissionMode = 'ask' | 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

interface EffortDescriptorShape { id: Effort; displayName: string }
interface PermissionModeDescriptorShape { id: PermissionMode; displayName: string }
interface AgentCapabilitiesShape {
  effortLevels?: EffortDescriptorShape[];
  permissionModes?: PermissionModeDescriptorShape[];
  // 其他字段实验页用不到
}

export function MakerExperimentalView(): ReactElement {
  const { t } = useTranslation();
  const m = useMakerSession();
  const [agentKind, setAgentKind] = useState<'claude-code' | 'codex'>('claude-code');
  const [workingDir, setWorkingDir] = useState('');
  const [model, setModel] = useState(CLAUDE_MODELS[0]);
  const [effort, setEffort] = useState<Effort>('medium');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('auto');
  const [inputText, setInputText] = useState('');
  const [imagePath, setImagePath] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<AgentCapabilitiesShape | null>(null);

  // agentKind 改变时拉对应 capabilities，effort 选项 / 默认值跟着变
  useEffect(() => {
    if (!m.isReady) return;
    const api = (window as unknown as {
      electronAPI?: { maker?: { getCapabilities: (k: string) => Promise<AgentCapabilitiesShape> } };
    }).electronAPI?.maker;
    if (!api) return;
    let cancelled = false;
    void api.getCapabilities(agentKind).then((caps) => {
      if (cancelled) return;
      setCapabilities(caps);
      // 切 agent 后如果当前 effort/permission 不在新 list 里，回退到两边都支持的安全默认
      setEffort((current) =>
        caps.effortLevels && !caps.effortLevels.some((e) => e.id === current)
          ? 'medium'
          : current,
      );
      setPermissionMode((current) =>
        caps.permissionModes && !caps.permissionModes.some((p) => p.id === current)
          ? 'auto'
          : current,
      );
    });
    return () => { cancelled = true; };
  }, [agentKind, m.isReady]);

  if (!m.isReady) {
    return (
      <div style={{ padding: 24, color: '#d4d4d4' }}>
        <h2>{t('makerExperimental.notReadyHeading')}</h2>
        <p>{t('makerExperimental.notReadyBody')}</p>
      </div>
    );
  }

  const handleAgentChange = (k: 'claude-code' | 'codex') => {
    setAgentKind(k);
    setModel(k === 'claude-code' ? CLAUDE_MODELS[0] : CODEX_MODELS[0]);
  };

  const handleCreate = async () => {
    if (!workingDir) {
      alert(t('makerExperimental.workingDirRequired'));
      return;
    }
    try {
      setSendError(null);
      await m.createSession({
        agentKind,
        workingDir,
        model,
        effort,
        permissionMode,
        displayReasoning: 'summarized',
      });
    } catch (e) {
      console.error('createSession failed', e);
    }
  };

  const handleSend = async () => {
    if (!inputText.trim() && !imagePath.trim()) return;
    try {
      setSendError(null);
      const attachments = imagePath
        ? [{ type: 'image' as const, path: imagePath }]
        : undefined;
      const result = await m.send(inputText, attachments);
      if (result.accepted === false) {
        setSendError(t('makerExperimental.sendNotAccepted'));
        return;
      }
      setInputText('');
      // 不清 imagePath，便于多轮发同一图
    } catch (e) {
      console.error('send failed', e);
    }
  };

  const models = agentKind === 'claude-code' ? CLAUDE_MODELS : CODEX_MODELS;
  const displayError = sendError ?? m.error;

  return (
    <div style={{ padding: 24, color: '#d4d4d4', fontFamily: 'sans-serif', maxWidth: 1200 }}>
      <h2 style={{ marginTop: 0 }}>{t('makerExperimental.title')}</h2>
      <p style={{ color: '#888', fontSize: 13 }}>
        {t('makerExperimental.description')}
      </p>

      {/* 配置区 */}
      <div style={{
        background: '#1a1a1a', padding: 16, borderRadius: 8, marginBottom: 16,
        display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 12px', alignItems: 'center',
      }}>
        <div>{t('makerExperimental.agentLabel')}</div>
        <div>
          <label style={{ marginRight: 16 }}>
            <input
              type="radio"
              checked={agentKind === 'claude-code'}
              onChange={() => handleAgentChange('claude-code')}
              disabled={!!m.session}
              className="accent-[var(--text-primary)]"
            /> Claude Code
          </label>
          <label>
            <input
              type="radio"
              checked={agentKind === 'codex'}
              onChange={() => handleAgentChange('codex')}
              disabled={!!m.session}
              className="accent-[var(--text-primary)]"
            /> Codex
          </label>
        </div>

        <label htmlFor="maker-experimental-working-dir">{t('makerExperimental.workingDirLabel')}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="maker-experimental-working-dir"
            type="text"
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            disabled={!!m.session}
            style={{ flex: 1, padding: '4px 8px', background: '#262626', color: '#d4d4d4', border: '1px solid #333' }}
            placeholder={t('makerExperimental.workingDirPlaceholder')}
          />
          <button
            type="button"
            disabled={!!m.session}
            onClick={async () => {
              const api = (window as unknown as {
                electronAPI?: { dialog?: { showOpenDirectory: (p?: { defaultPath?: string }) => Promise<{ success: boolean; path: string | null }> } };
              }).electronAPI?.dialog;
              if (!api) {
                alert(t('makerExperimental.dialogUnavailable'));
                return;
              }
              const res = await api.showOpenDirectory(workingDir ? { defaultPath: workingDir } : undefined);
              if (res.success && res.path) setWorkingDir(res.path);
            }}
            style={{
              padding: '4px 12px',
              background: '#404040',
              color: '#d4d4d4',
              border: '1px solid #333',
              borderRadius: 4,
              cursor: m.session ? 'default' : 'pointer',
              opacity: m.session ? 0.5 : 1,
            }}
          >
            {t('makerExperimental.selectButton')}
          </button>
        </div>

        <label htmlFor="maker-experimental-model">{t('makerExperimental.modelLabel')}</label>
        <select
          id="maker-experimental-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={!!m.session}
          style={{ padding: '4px 8px', background: '#262626', color: '#d4d4d4', border: '1px solid #333' }}
        >
          {models.map((m_) => (<option key={m_} value={m_}>{m_}</option>))}
        </select>

        <label htmlFor="maker-experimental-effort">{t('makerExperimental.effortLabel')}</label>
        <select
          id="maker-experimental-effort"
          value={effort}
          onChange={(e) => setEffort(e.target.value as Effort)}
          disabled={!!m.session}
          style={{ padding: '4px 8px', background: '#262626', color: '#d4d4d4', border: '1px solid #333' }}
        >
          {[...(capabilities?.effortLevels ?? [
            { id: 'low' as Effort, displayName: 'low' },
            { id: 'medium' as Effort, displayName: 'medium' },
            { id: 'high' as Effort, displayName: 'high' },
          ])].reverse().map((e_) => (
            <option key={e_.id} value={e_.id}>{e_.displayName}</option>
          ))}
        </select>

        <label htmlFor="maker-experimental-permission">{t('makerExperimental.permissionLabel')}</label>
        <select
          id="maker-experimental-permission"
          value={permissionMode}
          onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
          disabled={!!m.session}
          style={{ padding: '4px 8px', background: '#262626', color: '#d4d4d4', border: '1px solid #333' }}
        >
          {(capabilities?.permissionModes ?? [
            { id: 'auto' as PermissionMode, displayName: 'auto' },
            { id: 'bypassPermissions' as PermissionMode, displayName: 'bypassPermissions' },
          ]).map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}{p.id === 'ask' || p.id === 'default' || p.id === 'plan' || p.id === 'acceptEdits' ? ' ⚠' : ''}
            </option>
          ))}
        </select>

        <div></div>
        <div style={{ fontSize: 11, color: '#737373', lineHeight: 1.4 }}>
          {t('makerExperimental.warningHint')}
        </div>

        <div></div>
        <div>
          {!m.session ? (
            <button
              type="button"
              onClick={handleCreate}
              style={{ padding: '6px 16px', background: '#2563eb', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
            >{t('makerExperimental.createSession')}</button>
          ) : (
            <button
              type="button"
              onClick={() => void m.close()}
              style={{ padding: '6px 16px', background: '#dc2626', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
            >{t('makerExperimental.closeSession')}</button>
          )}
        </div>
      </div>

      {/* Session 状态 */}
      {m.session && (
        <div style={{ background: '#1a1a1a', padding: 12, borderRadius: 8, marginBottom: 16, fontSize: 12 }}>
          <div><strong>{t('makerExperimental.sessionField')}</strong> {m.session.sessionId}</div>
          <div><strong>{t('makerExperimental.agentField')}</strong> {m.session.agentKind} | <strong>{t('makerExperimental.statusField')}</strong> {m.status}</div>
          {displayError && <div style={{ color: '#dc2626' }}><strong>{t('makerExperimental.errorField')}</strong> {displayError}</div>}
        </div>
      )}

      {/* 发送区 */}
      {m.session && (
        <div style={{ marginBottom: 16 }}>
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder={t('makerExperimental.messagePlaceholder')}
            rows={3}
            style={{
              width: '100%', padding: 8, background: '#262626', color: '#d4d4d4',
              border: '1px solid #333', borderRadius: 4, boxSizing: 'border-box',
            }}
          />
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              value={imagePath}
              onChange={(e) => setImagePath(e.target.value)}
              placeholder={t('makerExperimental.imagePathPlaceholder')}
              style={{
                flex: 1, padding: '4px 8px', background: '#262626', color: '#d4d4d4',
                border: '1px solid #333', borderRadius: 4,
              }}
            />
            <button
              type="button"
              onClick={handleSend}
              style={{ padding: '6px 16px', background: '#16a34a', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
            >{t('makerExperimental.send')}</button>
            <button
              type="button"
              onClick={() => void m.abort()}
              style={{ padding: '6px 16px', background: '#737373', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
            >{t('makerExperimental.abort')}</button>
            <button
              type="button"
              onClick={m.clearEvents}
              style={{ padding: '6px 16px', background: '#404040', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
            >{t('makerExperimental.clear')}</button>
          </div>
        </div>
      )}

      {/* 事件流 */}
      <div>
        <h3 style={{ marginBottom: 8 }}>{t('makerExperimental.eventsHeading', { count: m.events.length })}</h3>
        <div style={{
          background: '#0a0a0a', padding: 12, borderRadius: 8, maxHeight: 600, overflowY: 'auto',
          fontFamily: 'monospace', fontSize: 11, color: '#a3a3a3',
        }}>
          {m.events.length === 0 ? (
            <div style={{ color: '#525252' }}>{t('makerExperimental.noEvents')}</div>
          ) : (
            m.events.map((e) => (
              <div key={e.id} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #262626' }}>
                <div style={{ color: '#fbbf24' }}>
                  #{e.id} <strong>{e.event.type}</strong> <span style={{ color: '#525252' }}>({e.event.source})</span>
                </div>
                <pre style={{ margin: '4px 0 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {JSON.stringify(e.event.data, null, 2)}
                </pre>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
