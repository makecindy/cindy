/**
 * AddRemoteProjectDialog — pick a folder on a connected remote target.
 *
 * device-link 接入后,「远程目标」统一两类(顶部下拉 optgroup 区分):
 *   - SSH 远程主机(`remoteSsh.list()` 的 ready hosts)
 *   - device-link 同账号被控设备(`online && remoteControlEnabled && !isSelf`)
 * 选谁决定走哪套浏览适配器(见 remoteBrowseAdapters.ts);弹窗 UI 只认统一接口,
 * 导航一律用 entry.childPath / ListResult.parent,两类来源的路径差异封装在适配器里
 * (device-link 被控端可能是 Windows → 用 handler 回传的 native 路径,renderer 不拼接)。
 *
 * 工作流:
 *   1. 打开 → 拉 SSH ready hosts + 可控设备 → 默认选第一个目标,默认路径 `~`
 *   2. 路径变 / 目标变 → adapter.listDir(远端 ls / 隧道 fs:list-dir),渲染子目录
 *   3. 双击 entry → cd 进(用 entry.childPath);「返回上级」用 ListResult.parent
 *   4. 「添加项目」→ adapter.statPath 校验 → existing dir 直接 onProjectAdded(带 kind);
 *      missing → confirm 提示,同意则 adapter.mkdirP,失败 toast
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Folder, FolderSymlink, ChevronLeft, RotateCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import { useControllableDevices } from '@/hooks/useControllableDevices';
import { useCCSessions } from '@/hooks/useCCSessions';
import {
  sshBrowseAdapter,
  deviceLinkBrowseAdapter,
  type RemoteBrowseAdapter,
  type BrowseEntry,
} from './remoteBrowseAdapters';
import {
  sshExistingProjects,
  loadDeviceLinkExistingProjects,
  type ExistingRemoteProject,
} from './remoteExistingProjects';

/** 用户最终确认添加的远程项目,带来源 kind —— 调用方据此决定立即建会话(SSH)还是进草稿(device-link)。 */
export type RemoteProjectTarget =
  | { kind: 'ssh'; hostId: string; path: string }
  | { kind: 'device-link'; deviceId: string; deviceName: string; path: string };

/** 下拉里的一个可选远程目标(SSH 主机 / 被控设备)。 */
type RemoteTarget =
  | { key: string; kind: 'ssh'; hostId: string; label: string }
  | { key: string; kind: 'device'; deviceId: string; deviceName: string; label: string };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 打开本弹窗的设备。**指名了就只认这一台**:它不在可选目标里(离线 / 撤销被控)时选中项留空,
   * 不回落到别的目标 —— 静默换机器会让用户在以为是 A 的界面里把项目建到 B 上。
   * 未指名(从通用入口打开)时才由用户自己在下拉里选。
   */
  initialDeviceId?: string | null;
  /** vendor 不在 dialog 里选 —— 由父层根据当前 draft / segmented switcher 决定。 */
  onProjectAdded: (target: RemoteProjectTarget) => void | Promise<void>;
}

export function AddRemoteProjectDialog({
  open,
  onOpenChange,
  initialDeviceId,
  onProjectAdded,
}: Props) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  // 打开时把焦点交给主输入(目标选择器),不落在关闭 X 上(DESIGN §14.2)。
  const targetSelectRef = useRef<HTMLSelectElement>(null);

  // 可控设备走 live hook;SSH ready hosts 在打开时拉一次。
  const devices = useControllableDevices();
  const [sshHosts, setSshHosts] = useState<RemoteHostSnapshot[]>([]);
  // SSH「已有项目」数据源:本地 active 会话(按 host 过滤,见 sshExistingProjects)。
  const { sessions } = useCCSessions();

  const targets = useMemo<RemoteTarget[]>(() => {
    const ssh: RemoteTarget[] = sshHosts.map((h) => ({
      key: `ssh:${h.config.id}`,
      kind: 'ssh',
      hostId: h.config.id,
      label: `${h.config.id} (${h.config.user}@${h.config.hostname})`,
    }));
    const dev: RemoteTarget[] = devices.map((d) => ({
      key: `device:${d.deviceId}`,
      kind: 'device',
      deviceId: d.deviceId,
      deviceName: d.name,
      label: d.name,
    }));
    return [...ssh, ...dev];
  }, [sshHosts, devices]);

  const sshTargets = useMemo(() => targets.filter((tg) => tg.kind === 'ssh'), [targets]);
  const deviceTargets = useMemo(() => targets.filter((tg) => tg.kind === 'device'), [targets]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedTarget = useMemo(
    () => targets.find((tg) => tg.key === selectedKey) ?? null,
    [targets, selectedKey],
  );

  // 默认「已有项目」模式,「浏览文件夹」为次要;切目标 / 重开都重置回 existing。
  const [mode, setMode] = useState<'existing' | 'browse'>('existing');
  const [deviceExisting, setDeviceExisting] = useState<ExistingRemoteProject[]>([]);
  const [existingLoading, setExistingLoading] = useState(false);
  // path 初始空 —— existing 模式下「添加」靠选中项目填充;进 browse 模式才置 `~` 并 ls。
  const [path, setPath] = useState<string>('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [busy, setBusy] = useState(false);
  // refreshList 请求序号 —— 快速切目标 / 双击进目录时旧请求晚到不得覆盖当前状态。
  const requestSeqRef = useRef(0);

  // 选中目标 → 取对应浏览适配器。key 变才重建(同 key 引用稳定,不触发浏览 effect 抖动)。
  const adapter = useMemo<RemoteBrowseAdapter | null>(() => {
    if (!selectedTarget) return null;
    return selectedTarget.kind === 'ssh'
      ? sshBrowseAdapter(selectedTarget.hostId)
      : deviceLinkBrowseAdapter(selectedTarget.deviceId);
  }, [selectedTarget?.key]);

  // SSH 已有项目:本地会话里该 host 的 project 会话去重(同步,随 sessions 实时重算);
  // device-link 已有项目走隧道异步拉(deviceExisting)。existing 列表取二者之一。
  const sshExisting = useMemo<ExistingRemoteProject[] | null>(() => {
    if (!selectedTarget || selectedTarget.kind !== 'ssh') return null;
    return sshExistingProjects(sessions, selectedTarget.hostId);
  }, [selectedTarget, sessions]);
  const existingProjects = sshExisting ?? deviceExisting;

  // 打开时拉 SSH ready hosts;重置选中(配置可能在设置里改过,不保留上次状态)。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await window.electronAPI.remoteSsh.list();
        if (cancelled) return;
        setSshHosts(res.hosts.filter((h) => h.status === 'ready'));
      } catch {
        if (!cancelled) setSshHosts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 默认选中:打开时 / 目标集变化后若当前选中已失效,落到第一个可用目标。
  useEffect(() => {
    if (!open) {
      setSelectedKey(null);
      return;
    }
    if (selectedKey && targets.some((tg) => tg.key === selectedKey)) return;
    const preferredKey = initialDeviceId ? `device:${initialDeviceId}` : null;
    if (preferredKey) {
      // 调用方**指名**了设备(从该设备的工作区 picker 点进来的)。此时绝不能回落到别的目标:
      // targets 只含在线设备,被指名的那台一旦离线就匹配不到,静默落到 targets[0](可能是某台
      // SSH 主机或另一台设备)会让用户以为在浏览 A、实际把 B 的路径加进草稿,把草稿切到意外的机器。
      // 匹配不到就保持未选中,由目标选择器显示空态 —— 宁可让用户自己再选一次。
      setSelectedKey(targets.some((target) => target.key === preferredKey) ? preferredKey : null);
      return;
    }
    setSelectedKey(targets[0]?.key ?? null);
  }, [open, targets, selectedKey, initialDeviceId]);

  /**
   * 调用方指名了设备、但它不在可选目标里(离线 / 撤销被控)。用于给「未选中」这个状态一个解释 ——
   * 上一轮刻意不回落到别的目标,代价就是必须把原因说出来。
   */
  const requestedDeviceUnavailable =
    initialDeviceId != null && !targets.some((tg) => tg.key === `device:${initialDeviceId}`);

  const refreshList = useCallback(
    async (browseApi: RemoteBrowseAdapter, targetPath: string) => {
      const mySeq = ++requestSeqRef.current;
      setLoadingList(true);
      try {
        const res = await browseApi.listDir(targetPath);
        if (mySeq !== requestSeqRef.current) return;
        setParent(res.parent);
        setEntries(res.entries);
      } catch (err) {
        if (mySeq !== requestSeqRef.current) return;
        toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'newChat.addRemoteProject.toast.listFailed' })));
        setEntries([]);
      } finally {
        if (mySeq === requestSeqRef.current) setLoadingList(false);
      }
    },
    [t],
  );

  // 切目标 / 打开:重置回「已有项目」模式 + 清浏览态(浏览的 ls 等进入 browse 模式才惰性触发)。
  useEffect(() => {
    if (!open) return;
    setMode('existing');
    setPath('');
    setEntries([]);
    setParent(null);
  }, [open, selectedTarget?.key]);

  // device-link「已有项目」:隧道拉被控端 recent_workdirs(SSH 走同步 memo,不进这里)。
  // 用局部 cancelled 作废旧请求,不动 requestSeqRef(那是 browse 的 ls 序号)。
  useEffect(() => {
    if (!open || !selectedTarget || selectedTarget.kind !== 'device') {
      setDeviceExisting([]);
      setExistingLoading(false);
      return;
    }
    let cancelled = false;
    setExistingLoading(true);
    setDeviceExisting([]);
    void (async () => {
      try {
        const projects = await loadDeviceLinkExistingProjects(selectedTarget.deviceId);
        if (!cancelled) setDeviceExisting(projects);
      } catch {
        if (!cancelled) setDeviceExisting([]);
      } finally {
        if (!cancelled) setExistingLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, selectedTarget?.key]);

  // 进入 browse 模式才 ls(惰性,省一次无谓远端往返)。bump seq 作废未落地的旧请求。
  useEffect(() => {
    if (!open || mode !== 'browse' || !adapter) return;
    requestSeqRef.current += 1;
    setEntries([]);
    setParent(null);
    setPath('~');
    void refreshList(adapter, '~');
  }, [open, mode, adapter, refreshList]);

  const handleEntryClick = useCallback((entry: BrowseEntry) => {
    // 单击 = 选中(把路径填进输入框),不进入。
    setPath(entry.childPath);
  }, []);

  const handleEntryDouble = useCallback(
    (entry: BrowseEntry) => {
      setPath(entry.childPath);
      if (adapter) void refreshList(adapter, entry.childPath);
    },
    [adapter, refreshList],
  );

  const isEntrySelected = useCallback((entry: BrowseEntry): boolean => path === entry.childPath, [path]);

  const handleParent = useCallback(() => {
    if (parent == null || !adapter) return;
    setPath(parent);
    void refreshList(adapter, parent);
  }, [parent, adapter, refreshList]);

  const handleAddProject = useCallback(async (explicitPath?: string) => {
    if (!selectedTarget || !adapter) return;
    const dir = (explicitPath ?? path).trim();
    if (!dir) {
      toast.error(t('newChat.addRemoteProject.toast.pathEmpty'));
      return;
    }
    setBusy(true);
    try {
      const stat = await adapter.statPath(dir);
      let finalPath = stat.resolvedPath;
      if (stat.kind === 'file') {
        toast.error(t('newChat.addRemoteProject.toast.pathIsFile', { path: finalPath }));
        return;
      }
      if (stat.kind === 'missing') {
        const ok = await confirm({
          title: t('newChat.addRemoteProject.confirmCreate.title'),
          description: t('newChat.addRemoteProject.confirmCreate.description', {
            path: finalPath,
            hostId: selectedTarget.label,
          }),
          confirmText: t('newChat.addRemoteProject.confirmCreate.ok'),
          cancelText: t('newChat.addRemoteProject.confirmCreate.cancel'),
        });
        if (!ok) return;
        const mk = await adapter.mkdirP(dir);
        finalPath = mk.resolvedPath;
      }
      if (selectedTarget.kind === 'ssh') {
        await onProjectAdded({ kind: 'ssh', hostId: selectedTarget.hostId, path: finalPath });
      } else {
        await onProjectAdded({
          kind: 'device-link',
          deviceId: selectedTarget.deviceId,
          deviceName: selectedTarget.deviceName,
          path: finalPath,
        });
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'newChat.addRemoteProject.toast.addFailed' })));
    } finally {
      setBusy(false);
    }
  }, [selectedTarget, adapter, path, confirm, onProjectAdded, onOpenChange, t]);

  const noTargets = targets.length === 0;

  return (
    <Dialog.Root open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-50"
          style={{ backgroundColor: 'var(--overlay-modal, rgba(0,0,0,0.4))' }}
        />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex w-[560px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl shadow-[var(--confirm-shadow)]"
          style={{
            backgroundColor: 'var(--surface-elevated, #ffffff)',
            border: '1px solid var(--border-default, #d4d4d4)',
            maxHeight: '88vh',
          }}
          onEscapeKeyDown={busy ? (e) => e.preventDefault() : undefined}
          onInteractOutside={busy ? (e) => e.preventDefault() : undefined}
          onOpenAutoFocus={(e) => {
            // Radix 默认聚焦内容区首个可聚焦元素(这里是关闭 X)。覆盖成聚焦目标选择器,
            // 让焦点落在主输入上;无目标(select 未渲染)时保留默认行为。
            if (targetSelectRef.current) {
              e.preventDefault();
              targetSelectRef.current.focus();
            }
          }}
        >
          {/* Header */}
          <div
            className="flex flex-col gap-1 px-5 py-4"
            style={{ borderBottom: '1px solid var(--border-default, #d4d4d4)' }}
          >
            <div className="flex items-center justify-between">
              <Dialog.Title
                className="text-15 font-medium"
                style={{ color: 'var(--text-primary)' }}
              >
                {t('newChat.addRemoteProject.title')}
              </Dialog.Title>
              <Dialog.Close asChild disabled={busy}>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t('newChat.addRemoteProject.cancel')}
                  className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-chip)] disabled:opacity-40"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <p className="text-12" style={{ color: 'var(--text-tertiary)' }}>
              {t('newChat.addRemoteProject.hint')}
            </p>
          </div>

          {/* Body */}
          <div className="flex flex-col gap-3 px-5 py-4">
            {noTargets ? (
              <div className="text-13 py-8 text-center" style={{ color: 'var(--text-secondary)' }}>
                {t('newChat.addRemoteProject.empty')}
              </div>
            ) : (
              <>
                {/* Target selector — optgroup 区分 SSH 主机 / 我的设备 */}
                <label className="flex flex-col gap-1">
                  <span
                    className="text-12 font-medium"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {t('newChat.addRemoteProject.host')}
                  </span>
                  <select
                    ref={targetSelectRef}
                    value={selectedKey ?? ''}
                    onChange={(e) => setSelectedKey(e.target.value || null)}
                    disabled={busy}
                    className="h-9 rounded-lg border bg-transparent px-2 text-13 outline-none"
                    style={{
                      borderColor: 'var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {/* 未选中时必须有一个 value="" 的项供受控 select 显示(Codex review P1)。
                        缺了它,浏览器会去显示第一个真实 option,而 selectedTarget 仍是 null ——
                        「添加」保持 disabled;若只有一个备选目标,点那个已显示的项也不产生 change
                        事件,弹窗就此卡死。disabled 让它只能被显示、不能被重新选回。
                        这个空态是上一轮「指名设备离线时不静默回落到别的目标」带来的,得配一个占位。 */}
                    {selectedKey === null && (
                      <option value="" disabled>
                        {t('newChat.addRemoteProject.selectTargetPlaceholder')}
                      </option>
                    )}
                    {sshTargets.length > 0 && (
                      <optgroup label={t('newChat.addRemoteProject.sourceGroupSsh')}>
                        {sshTargets.map((tg) => (
                          <option key={tg.key} value={tg.key}>
                            {tg.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {deviceTargets.length > 0 && (
                      <optgroup label={t('newChat.addRemoteProject.sourceGroupDevice')}>
                        {deviceTargets.map((tg) => (
                          <option key={tg.key} value={tg.key}>
                            {tg.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  {/* 指名的设备不在可选目标里(离线 / 撤销被控)→ 说明原因,否则用户只看到一个
                      未选中的下拉,不知道为什么要自己重选。 */}
                  {selectedKey === null && requestedDeviceUnavailable && (
                    <span className="text-12" style={{ color: 'var(--text-secondary)' }}>
                      {t('newChat.addRemoteProject.requestedDeviceUnavailable')}
                    </span>
                  )}
                </label>

                {/* Mode toggle — 默认「已有项目」,「浏览文件夹」为次要入口 */}
                <div
                  className="flex items-center gap-1 rounded-lg border p-0.5"
                  style={{ borderColor: 'var(--border-default)' }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setMode('existing');
                      setPath('');
                    }}
                    disabled={busy}
                    className={cn(
                      'flex-1 h-7 rounded-md text-12 font-medium transition-colors',
                      busy && 'cursor-not-allowed opacity-60',
                    )}
                    style={
                      mode === 'existing'
                        ? { backgroundColor: 'var(--settings-menu-bg-selected)', color: 'var(--text-primary)' }
                        : { color: 'var(--text-secondary)' }
                    }
                  >
                    {t('newChat.addRemoteProject.tabExisting')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('browse')}
                    disabled={busy}
                    className={cn(
                      'flex-1 h-7 rounded-md text-12 font-medium transition-colors',
                      busy && 'cursor-not-allowed opacity-60',
                    )}
                    style={
                      mode === 'browse'
                        ? { backgroundColor: 'var(--settings-menu-bg-selected)', color: 'var(--text-primary)' }
                        : { color: 'var(--text-secondary)' }
                    }
                  >
                    {t('newChat.addRemoteProject.tabBrowse')}
                  </button>
                </div>

                {mode === 'existing' ? (
                  /* 已有项目列表 — 单击选中、双击直接添加;空则给「浏览文件夹」兜底入口 */
                  <div
                    className="max-h-[340px] overflow-y-auto rounded-lg border"
                    style={{ borderColor: 'var(--border-default)' }}
                  >
                    {existingLoading ? (
                      <div className="text-12 py-8 text-center" style={{ color: 'var(--text-tertiary)' }}>
                        {t('newChat.addRemoteProject.existingLoading')}
                      </div>
                    ) : existingProjects.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 py-8">
                        <span className="text-12 text-center px-4" style={{ color: 'var(--text-tertiary)' }}>
                          {t('newChat.addRemoteProject.existingEmpty')}
                        </span>
                        <button
                          type="button"
                          onClick={() => setMode('browse')}
                          className="text-12 font-medium underline-offset-2 hover:underline"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {t('newChat.addRemoteProject.tabBrowse')}
                        </button>
                      </div>
                    ) : (
                      existingProjects.map((project) => {
                        const selected = path === project.path;
                        return (
                          <button
                            key={project.path}
                            type="button"
                            onClick={() => setPath(project.path)}
                            onDoubleClick={() => void handleAddProject(project.path)}
                            title={project.path}
                            disabled={busy}
                            className={cn(
                              'flex w-full items-center gap-2 px-3 py-2 text-left text-13 transition-colors',
                              !selected && 'hover:bg-[var(--surface-chip)]',
                              busy && 'cursor-not-allowed opacity-60',
                            )}
                            style={{
                              color: 'var(--text-primary)',
                              ...(selected ? { backgroundColor: 'var(--settings-menu-bg-selected)' } : {}),
                            }}
                          >
                            <Folder size={14} className="shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{project.name}</span>
                              <span
                                className="truncate text-11"
                                style={{
                                  color: 'var(--text-tertiary)',
                                  fontFamily: 'var(--app-font-code, var(--app-font-code-default))',
                                }}
                              >
                                {project.path}
                              </span>
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                ) : (
                  <>
                    {/* Path bar */}
                    <label className="flex flex-col gap-1">
                      <span
                        className="text-12 font-medium"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {t('newChat.addRemoteProject.path')}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={handleParent}
                          disabled={busy || loadingList || parent == null}
                          title={t('newChat.addRemoteProject.parent')}
                          className={cn(
                            'flex h-9 w-9 items-center justify-center rounded-lg border',
                            (busy || loadingList || parent == null) && 'cursor-not-allowed opacity-60',
                          )}
                          style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                        >
                          <ChevronLeft size={14} />
                        </button>
                        <input
                          type="text"
                          value={path}
                          onChange={(e) => setPath(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing && adapter) {
                              void refreshList(adapter, path);
                            }
                          }}
                          disabled={busy}
                          placeholder="~/projects/my-repo"
                          className="flex-1 h-9 rounded-lg border bg-transparent px-2 text-13 outline-none"
                          style={{
                            borderColor: 'var(--border-default)',
                            color: 'var(--text-primary)',
                            fontFamily: 'var(--app-font-code, var(--app-font-code-default))',
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => adapter && void refreshList(adapter, path)}
                          disabled={busy || loadingList}
                          title={t('newChat.addRemoteProject.refresh')}
                          className={cn(
                            'flex h-9 w-9 items-center justify-center rounded-lg border',
                            (busy || loadingList) && 'cursor-not-allowed opacity-60',
                          )}
                          style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                        >
                          {loadingList ? <Spinner size={14} /> : <RotateCw size={14} />}
                        </button>
                      </div>
                    </label>

                    {/* Entries list */}
                    <div
                      className="max-h-[296px] overflow-y-auto rounded-lg border"
                      style={{ borderColor: 'var(--border-default)' }}
                    >
                      {entries.length === 0 ? (
                        <div
                          className="text-12 py-8 text-center"
                          style={{ color: 'var(--text-tertiary)' }}
                        >
                          {loadingList
                            ? t('newChat.addRemoteProject.loading')
                            : t('newChat.addRemoteProject.noSubdirs')}
                        </div>
                      ) : (
                        entries.map((entry) => {
                          const selected = isEntrySelected(entry);
                          return (
                            <button
                              key={entry.childPath}
                              type="button"
                              onClick={() => handleEntryClick(entry)}
                              onDoubleClick={() => handleEntryDouble(entry)}
                              title={t('newChat.addRemoteProject.doubleClickHint')}
                              disabled={busy}
                              className={cn(
                                'flex w-full items-center gap-2 px-3 py-2 text-left text-13 transition-colors',
                                !selected && 'hover:bg-[var(--surface-chip)]',
                                busy && 'cursor-not-allowed opacity-60',
                              )}
                              style={{
                                color: 'var(--text-primary)',
                                ...(selected ? { backgroundColor: 'var(--settings-menu-bg-selected)' } : {}),
                              }}
                            >
                              {entry.kind === 'symlink' ? (
                                <FolderSymlink size={14} style={{ color: 'var(--text-tertiary)' }} />
                              ) : (
                                <Folder size={14} style={{ color: 'var(--text-tertiary)' }} />
                              )}
                              <span className="truncate">{entry.name}</span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {/* Footer — 按钮走通用弹窗标准(DESIGN §Dialog / confirm-dialog.tsx):
              主按钮实心 CTA(--confirm-btn-primary-*),取消描边(--confirm-btn-secondary-*),pill。 */}
          <div
            className="flex justify-end gap-2.5 px-5 py-3"
            style={{ borderTop: '1px solid var(--border-default)' }}
          >
            <Dialog.Close asChild disabled={busy}>
              <button
                type="button"
                disabled={busy}
                className={cn(
                  'inline-flex min-w-[96px] items-center justify-center rounded-full px-6 py-2.5 text-13 font-medium',
                  'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                  'active:scale-[0.98]',
                  'border bg-transparent',
                  'border-[var(--confirm-btn-secondary-border)] text-[var(--confirm-btn-secondary-text)]',
                  'hover:bg-[var(--confirm-btn-secondary-hover)] focus-visible:ring-[var(--confirm-btn-secondary-border)]',
                  'disabled:opacity-40',
                )}
              >
                {t('newChat.addRemoteProject.cancel')}
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={() => void handleAddProject()}
              disabled={busy || noTargets || !selectedTarget || !path.trim()}
              className={cn(
                'inline-flex min-w-[96px] items-center justify-center gap-1 rounded-full px-6 py-2.5 text-13 font-medium',
                'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                'active:scale-[0.98]',
                'bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)]',
                'hover:bg-[var(--confirm-btn-primary-hover)] focus-visible:ring-[var(--confirm-btn-primary-bg)]',
                (busy || noTargets || !selectedTarget || !path.trim()) &&
                  'cursor-not-allowed opacity-60 hover:bg-[var(--confirm-btn-primary-bg)] active:scale-100',
              )}
            >
              {busy && <Spinner size={12} />}
              {t('newChat.addRemoteProject.add')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
