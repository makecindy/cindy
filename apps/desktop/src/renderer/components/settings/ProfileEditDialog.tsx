import { Button } from '@/components/ui/button';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

import { AvatarCropEditor } from './AvatarCropEditor';
import { initialAvatarCrop, type AvatarCrop } from './avatarCropGeometry';
import {
  exportAvatarCrop,
  loadAvatarSource,
  type AvatarExport,
  type AvatarSource,
} from './avatarCropImage';

/**
 * ProfileEditDialog — 设置页用户卡片的「编辑名字 / 头像」弹窗。
 *
 * 业务全在 main(profileEdit.ts):这里只收集输入并经 IPC 提交。2026-07 起
 * 资料**直写服务端**(auth-server PATCH /api/me/profile,头像先经 oss-server
 * 预签名直传),跨设备生效;保存成功后 main 重广播 auth:state-change,
 * 卡片 / 侧边栏经 AuthContext 自动刷新。
 *
 * 两个步骤共用同一个弹窗(不叠第二层遮罩):
 *   - 资料表单:名字 + 头像预览;
 *   - 调整头像:选图后进入,拖动 / 缩放取景(AvatarCropEditor)。「完成」把取景
 *     导出成最终字节回到表单;「取消」/ Esc 回到表单且不动草稿。
 * 只有表单的「保存资料」才会上传;关闭弹窗零副作用。
 *
 * 头像动作三态:keep(没动)/ set(已调整好的新头像,预览直接用将要上传的字节)/
 * reset(清除自定义头像,回落产品默认)。名字输入预填当前名字,留空 = 不改名
 * (服务端不允许清空名字)。保存失败时草稿原样保留,可直接重试或继续调整。
 */
interface ProfileEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type AvatarDraft =
  | { type: 'keep' }
  | {
      type: 'set';
      exported: AvatarExport;
      /** exported.blob 的 object URL:表单预览即上传内容本身。 */
      previewUrl: string;
      /** 保留取景源与位置,「调整」可接着上次的构图继续改。 */
      source: AvatarSource;
      crop: AvatarCrop;
    }
  | { type: 'reset' };

/** 调整头像步骤的进行中状态。source 可能来自新选的图,也可能复用草稿的源。 */
interface CropSession {
  source: AvatarSource;
  crop: AvatarCrop;
}

interface ProfileState {
  name: string;
  avatarUrl: string | null;
}

// Tooltip 默认 z-[60],会被 z-[10000] 的弹窗盖住(DESIGN §4 Dialog & Modal)。
const DIALOG_TIP_CLASS = 'z-[10001]';

export function ProfileEditDialog({ open, onOpenChange }: ProfileEditDialogProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<ProfileState | null>(null);
  const [name, setName] = useState('');
  const [avatarDraft, setAvatarDraftState] = useState<AvatarDraft>({ type: 'keep' });
  const [cropSession, setCropSessionState] = useState<CropSession | null>(null);
  const [saving, setSaving] = useState(false);
  // Radix AlertDialog.Action 在点击的同一事件里**同步**触发 onOpenChange(false),
  // 彼时 setSaving(true) 还没重渲染、闭包里的 saving 仍是 false——守卫必须走 ref
  // 才拦得住(同款踩坑与修法见 WindowControls.tsx 的 closingRef)。
  const savingRef = useRef(false);
  // 同理:「完成」导出是异步的,紧随其后的同步 onOpenChange(false) 不能被当成「取消调整」。
  const exportingRef = useRef(false);
  const choosingRef = useRef(false);
  // 选图请求的代次:关闭弹窗或卸载时 +1,让还在系统选择器 / 解码中的旧请求作废——
  // 否则关掉再重开时,旧请求返回会把已放弃的图片带回调整步骤。
  const chooseGenerationRef = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  // 位图 / object URL 的所有权跟踪:ref 始终是最新值,释放逻辑不依赖渲染时机。
  const draftRef = useRef<AvatarDraft>(avatarDraft);
  const sessionRef = useRef<CropSession | null>(cropSession);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const changeAvatarRef = useRef<HTMLButtonElement | null>(null);
  const focusAfterFormRef = useRef(false);
  // 只在两个步骤之间切换时淡入新内容;首次打开交给弹窗自己的入场动效,不叠加。
  const [stepSwitched, setStepSwitched] = useState(false);

  /** 替换头像草稿并释放旧草稿独占的资源(仍被调整会话或新草稿复用的源不释放)。 */
  const setAvatarDraft = useCallback((next: AvatarDraft) => {
    const prev = draftRef.current;
    if (prev.type === 'set') {
      if (next.type !== 'set' || next.previewUrl !== prev.previewUrl) {
        URL.revokeObjectURL(prev.previewUrl);
      }
      const reused =
        (next.type === 'set' && next.source === prev.source) ||
        sessionRef.current?.source === prev.source;
      if (!reused) prev.source.bitmap.close();
    }
    draftRef.current = next;
    setAvatarDraftState(next);
  }, []);

  /** 结束调整会话;源若既不属于草稿也不再被使用就释放。 */
  const endCropSession = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    setCropSessionState(null);
    const draft = draftRef.current;
    if (session && !(draft.type === 'set' && draft.source === session.source)) {
      session.source.bitmap.close();
    }
  }, []);

  const startCropSession = useCallback(
    (session: CropSession) => {
      // 正在调整中又选了新图(理论上不会,入口在表单里)时先收掉旧会话。
      if (sessionRef.current && sessionRef.current.source !== session.source) endCropSession();
      sessionRef.current = session;
      setCropSessionState(session);
      setStepSwitched(true);
    },
    [endCropSession],
  );

  const updateCrop = useCallback((crop: AvatarCrop) => {
    const session = sessionRef.current;
    if (!session) return;
    const next = { ...session, crop };
    sessionRef.current = next;
    setCropSessionState(next);
  }, []);

  /** 关闭 / 卸载时释放全部位图与 object URL。 */
  const releaseAll = useCallback(() => {
    endCropSession();
    setAvatarDraft({ type: 'keep' });
  }, [endCropSession, setAvatarDraft]);

  // 打开时拉预填数据并复位草稿(异步取数期间不渲染内容,避免半空帧;
  // 数据都在本地 main,毫秒级返回,无需 loading 态 —— 规则 7)。
  useEffect(() => {
    if (!open) {
      chooseGenerationRef.current += 1;
      choosingRef.current = false;
      releaseAll();
      return;
    }
    setStepSwitched(false);
    let stale = false;
    void window.electronAPI
      .profileGetState()
      .then((s) => {
        if (stale) return;
        setState(s);
        setName(s.name);
        releaseAll();
      })
      .catch(() => {
        if (!stale) onOpenChange(false);
      });
    return () => {
      stale = true;
    };
  }, [open, onOpenChange, releaseAll]);

  useEffect(
    () => () => {
      chooseGenerationRef.current += 1;
      releaseAll();
    },
    [releaseAll],
  );

  // 步骤切换后的焦点:进入调整 → 聚焦取景区(方向键即可微调);回到表单 → 回到触发按钮。
  const inCrop = cropSession !== null;
  useEffect(() => {
    if (inCrop) {
      stageRef.current?.focus({ preventScroll: true });
    } else if (focusAfterFormRef.current) {
      focusAfterFormRef.current = false;
      changeAvatarRef.current?.focus({ preventScroll: true });
    }
  }, [inCrop]);

  const handleChooseAvatar = useCallback(async () => {
    if (choosingRef.current) return;
    choosingRef.current = true;
    const generation = chooseGenerationRef.current;
    const isCurrent = () => generation === chooseGenerationRef.current && openRef.current;
    try {
      const result = await window.electronAPI.profileChooseAvatar();
      if (!isCurrent() || result.canceled || !result.previewDataUrl) return;
      // 先解码再切到调整步骤:编辑台第一帧就有图,解码失败则留在表单提示。
      const source = await loadAvatarSource(result.previewDataUrl);
      if (!isCurrent()) {
        source.bitmap.close();
        return;
      }
      startCropSession({ source, crop: initialAvatarCrop(source.size) });
    } catch {
      if (isCurrent()) toast.error(t('settings.userProfile.edit.avatarInvalid'));
    } finally {
      // 作废的请求不动守卫:关闭时已复位,新一轮打开可能已在选图。
      if (generation === chooseGenerationRef.current) choosingRef.current = false;
    }
  }, [startCropSession, t]);

  const handleAdjustAvatar = useCallback(() => {
    const draft = draftRef.current;
    if (draft.type !== 'set') return;
    startCropSession({ source: draft.source, crop: draft.crop });
  }, [startCropSession]);

  const leaveCrop = useCallback(() => {
    focusAfterFormRef.current = true;
    setStepSwitched(true);
    endCropSession();
  }, [endCropSession]);

  const handleCropDone = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || exportingRef.current) return;
    exportingRef.current = true; // await 之前同步置位,拦住 Radix Action 的同步关闭
    try {
      const exported = await exportAvatarCrop(session.source, session.crop);
      // 期间弹窗被关闭(会话已收掉、位图已释放)就丢弃结果;导出的是点「完成」那一刻的取景。
      if (sessionRef.current?.source !== session.source) return;
      setAvatarDraft({
        type: 'set',
        exported,
        previewUrl: URL.createObjectURL(exported.blob),
        source: session.source,
        crop: session.crop,
      });
      leaveCrop();
    } catch {
      toast.error(t('settings.userProfile.edit.crop.exportFailed'));
    } finally {
      exportingRef.current = false;
    }
  }, [leaveCrop, setAvatarDraft, t]);

  const handleSave = useCallback(async () => {
    if (!state || savingRef.current) return;
    savingRef.current = true; // await 之前同步置位,拦住 Radix Action 的同步关闭
    setSaving(true);
    try {
      const trimmed = name.trim();
      const draft = draftRef.current;
      await window.electronAPI.profileUpdate({
        name: trimmed === '' ? null : trimmed,
        avatar:
          draft.type === 'set'
            ? { type: 'set', data: draft.exported.bytes, mimeType: draft.exported.mimeType }
            : { type: draft.type },
      });
      savingRef.current = false;
      setSaving(false);
      onOpenChange(false);
    } catch {
      savingRef.current = false;
      setSaving(false);
      toast.error(t('settings.userProfile.edit.saveFailed'));
    }
  }, [state, name, onOpenChange, t]);

  if (!state) return null;

  const handleOpenChange = (next: boolean) => {
    if (next) {
      onOpenChange(true);
      return;
    }
    if (savingRef.current) return; // 保存中不允许关(ref 守卫,见 savingRef 注释)
    // 调整步骤里的「取消」/ Esc 只回到表单;「完成」由 handleCropDone 自己收尾。
    if (sessionRef.current) {
      if (!exportingRef.current) leaveCrop();
      return;
    }
    onOpenChange(false);
  };

  if (cropSession) {
    return (
      <ConfirmDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={t('settings.userProfile.edit.crop.title')}
        description={t('settings.userProfile.edit.crop.description')}
        confirmText={t('settings.userProfile.edit.crop.done')}
        cancelText={t('settings.userProfile.edit.cancel')}
        onConfirm={() => void handleCropDone()}
        content={
          <div className={cn(stepSwitched && 'animate-fade-in')}>
            <AvatarCropEditor
              ref={stageRef}
              source={cropSession.source}
              crop={cropSession.crop}
              onCropChange={updateCrop}
              tipClassName={DIALOG_TIP_CLASS}
            />
          </div>
        }
      />
    );
  }

  // 预览优先级:新调整好的图 > 现有头像(reset 时回首字母兜底)。
  const previewUrl =
    avatarDraft.type === 'set'
      ? avatarDraft.previewUrl
      : avatarDraft.type === 'reset'
        ? null
        : state.avatarUrl;
  const effectiveName =
    name.trim() !== '' ? name.trim() : state.name || t('settings.userProfile.fallbackName');
  const initial = effectiveName.charAt(0).toUpperCase();
  const canResetAvatar =
    avatarDraft.type === 'set' || (avatarDraft.type === 'keep' && state.avatarUrl !== null);
  const linkClass = cn(
    'px-1 text-12 text-[var(--text-tertiary)] transition-colors',
    'hover:text-[var(--text-primary)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
  );

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t('settings.userProfile.edit.title')}
      confirmText={t('settings.userProfile.edit.save')}
      cancelText={t('settings.userProfile.edit.cancel')}
      autoFocusConfirm
      loading={saving}
      onConfirm={() => void handleSave()}
      content={
        <div className={cn('flex flex-col gap-4', stepSwitched && 'animate-fade-in')}>
          {/* 头像行:预览 + 更换 / 调整(共享 Button)+ 清除自定义(沿用既有文字动作) */}
          <div className="flex items-center gap-4">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt={effectiveName}
                className={cn(
                  'h-[52px] w-[52px] shrink-0 rounded-full object-cover',
                  'border border-[var(--settings-profile-card-border)]',
                )}
              />
            ) : (
              <div
                className={cn(
                  'flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full',
                  'bg-[var(--settings-profile-avatar-bg)]',
                  'border border-[var(--settings-profile-card-border)]',
                  'text-18 font-medium text-[var(--settings-profile-avatar-text)]',
                )}
              >
                {initial}
              </div>
            )}
            <div className="flex flex-col items-start gap-1.5">
              <div className="flex items-center gap-2">
                <Button
                  ref={changeAvatarRef}
                  variant="secondary"
                  size="sm"
                  compact
                  type="button"
                  disabled={saving}
                  onClick={() => void handleChooseAvatar()}
                >
                  {t('settings.userProfile.edit.changeAvatar')}
                </Button>
                {avatarDraft.type === 'set' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    compact
                    type="button"
                    disabled={saving}
                    onClick={handleAdjustAvatar}
                  >
                    {t('settings.userProfile.edit.adjustAvatar')}
                  </Button>
                )}
              </div>
              {canResetAvatar && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setAvatarDraft({ type: 'reset' })}
                  className={linkClass}
                >
                  {t('settings.userProfile.edit.resetAvatar')}
                </button>
              )}
            </div>
          </div>

          {/* 名字行:预填当前名字,留空 = 不改名 */}
          <label className="flex flex-col gap-1.5">
            <span className="text-12 text-[var(--text-secondary)]">
              {t('settings.userProfile.edit.nameLabel')}
            </span>
            <input
              type="text"
              value={name}
              maxLength={40}
              placeholder={state.name}
              onChange={(e) => setName(e.target.value)}
              className={cn(
                'h-8 rounded-lg border border-[var(--settings-input-border)]',
                'bg-[var(--settings-input-bg)] px-3 text-13 text-[var(--settings-input-text)]',
                'outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
              )}
            />
            <span className="text-11 text-[var(--text-tertiary)]">
              {t('settings.userProfile.edit.nameHint')}
            </span>
          </label>

          {/* 资料跨设备同步的透明化说明 */}
          <p className="text-11 leading-relaxed text-[var(--text-tertiary)]">
            {t('settings.userProfile.edit.syncHint')}
          </p>
        </div>
      }
    />
  );
}
