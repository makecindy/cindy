/**
 * GlobalDropImportListener — 窗口级拖拽路由(capture 优先接管 + 冒泡兜底)+ 全窗拖入遮罩。
 *
 * .cindy / .cshare 拖入主窗口的语义是"整个窗口响应":无论落在空白处还是
 * composer / 文件浏览器等既有 drop 区上方,都走全局装入 / 导入链路。实现分两层:
 *
 * capture 层(window capture 阶段,先于一切内层 handler):
 *   - 悬停:MIME 命中 .cindy / .cshare(shared/fileTypes.ts)时 stopPropagation,
 *     内层 drop 区全程收不到 enter/over,全窗遮罩接管、局部遮罩不出现。
 *   - drop:按扩展名同步判定(零 IO,不依赖 MIME —— dev / 未注册机器 MIME 为空
 *     但文件名此时可读)。命中则 preventDefault + markGlobalDropIntercepted 后
 *     执行路由,但**不 stopPropagation**:事件继续传到内层,内层 handler 自查
 *     标记(lib/globalDropIntercept.ts)后清理自己的拖拽 UI 状态再 return,
 *     避免"悬停识别不到 → 内层遮罩已亮 → drop 被吞 → 计数不归零遮罩卡死"。
 *   - 路由:.cindy → inspect 验明正身 → 确认弹窗 → 装入 + 停靠,与设置页
 *     「注入意识…」同一编排(renderer/cindy-brain/installFlow.ts);
 *     .cshare(含旧 .xdtshare)→ 经 main 的 classify-path 验明后打开会话导入向导。
 *
 * 冒泡层(兜底,仅"落在空白处"且 capture 未接管的 drop 会到达——内层 drop 区
 * stopPropagation、capture 接管过的 defaultPrevented 直接跳过):
 *   - directory → 以该目录为 workingDir 进入新建会话(与「通过 Cindy 打开」
 *     深链同链路:patchDraft 预填 + 清 extraDirs,navigate /cc-agent/new)
 *   - other     → 静默忽略,不 toast 打扰
 *
 * 拖入遮罩:悬停阶段浏览器拿不到文件名/路径,只能读 DataTransferItem.type
 * (MIME)。MIME 已随打包注册进系统;识别不到(dev / 未注册机器,type 为空)
 * 不弹全窗遮罩、不拦悬停,内层局部遮罩照常,drop 时仍按扩展名全局接管。
 * dragenter/dragleave 计数在 capture 阶段完整配对(不受内层 stopPropagation
 * 影响)。window 级 dragover 必须 preventDefault,否则 drop 事件不触发且
 * Electron 会尝试导航到文件 URL。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { confirmAndInstallGhost } from '@/cindy-brain/installFlow';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  classifyGlobalDropPath,
  markGlobalDropIntercepted,
} from '@/lib/globalDropIntercept';
import { createLogger } from '@/lib/logger';
import { patchDraft } from '@/state/newMakerDraft';
import { CINDY_MIME_TYPE, SHARE_MIME_TYPE } from '../../../shared/fileTypes';

const log = createLogger('GlobalDropImportListener');

type DragHint = 'cindy' | 'share';

export interface GlobalDropImportListenerProps {
  onOpenShareImport: (filePath: string) => void;
  /**
   * 当前右侧栏会话 id 的 getter(MainLayout 的 rightSidebarSessionIdRef 读值,
   * prop 身份稳定)。装入 tab 型插件勾选「立即开启」时用来自动打开页签;
   * 无会话视图返回 null = 跳过自动打开。
   */
  getRightSidebarSessionId?: () => string | null;
}

export function GlobalDropImportListener({
  onOpenShareImport,
  getRightSidebarSessionId,
}: GlobalDropImportListenerProps) {
  const [dragHint, setDragHint] = useState<DragHint | null>(null);
  const dragDepthRef = useRef(0);
  // 当前拖拽序列是否已被 capture 层接管(MIME 悬停识别命中):置位后本序列的
  // enter/over/leave 全部 stopPropagation,内层 drop 区完全无感知。
  const interceptRef = useRef(false);
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { confirm, confirmWithCheckbox } = useConfirmDialog();

  // 双击 .cindy 的转交消费:挂载时取一次(冷启动双击,main 已缓存)+ 订阅
  // 信号(已运行时双击)。取到路径即走与按钮/拖入完全相同的确认装入编排。
  useEffect(() => {
    const consumePending = async () => {
      const { filePath } = await window.electronAPI.ghosts.takePendingInstall();
      if (filePath) {
        await confirmAndInstallGhost(filePath, {
          t,
          confirm,
          confirmWithCheckbox,
          getSidebarSessionId: getRightSidebarSessionId,
        });
      }
    };
    void consumePending().catch((err) => log.warn('consume pending cindy install failed', err));
    return window.electronAPI.ghosts.onInstallRequested(() => {
      void consumePending().catch((err) => log.warn('consume pending cindy install failed', err));
    });
  }, [confirm, confirmWithCheckbox, getRightSidebarSessionId, t]);

  useEffect(() => {
    // 悬停识别:单文件且 MIME 命中才给遮罩。
    const hintForDrag = (dt: DataTransfer | null): DragHint | null => {
      if (!dt || dt.items.length !== 1) return null;
      const item = dt.items[0];
      if (item.kind !== 'file') return null;
      if (item.type === CINDY_MIME_TYPE) return 'cindy';
      if (item.type === SHARE_MIME_TYPE) return 'share';
      return null;
    };
    const resetDragState = () => {
      dragDepthRef.current = 0;
      interceptRef.current = false;
      setDragHint(null);
    };
    // ---- capture 层:悬停接管 + drop 全局路由(先于一切内层 handler)----
    const onDragEnterCapture = (e: DragEvent) => {
      dragDepthRef.current += 1;
      const hint = hintForDrag(e.dataTransfer);
      if (hint) {
        interceptRef.current = true;
        setDragHint(hint);
      }
      if (interceptRef.current) e.stopPropagation();
    };
    const onDragLeaveCapture = (e: DragEvent) => {
      if (interceptRef.current) e.stopPropagation();
      if (dragDepthRef.current > 0) dragDepthRef.current -= 1;
      if (dragDepthRef.current === 0) {
        interceptRef.current = false;
        setDragHint(null);
      }
    };
    const onDragOverCapture = (e: DragEvent) => {
      if (!interceptRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDropCapture = (e: DragEvent) => {
      resetDragState();
      const files = e.dataTransfer?.files;
      if (!files || files.length !== 1) return;
      let path = '';
      try {
        path = window.electronAPI.getFilePath(files[0]);
      } catch {
        return;
      }
      if (!path) return;
      const kind = classifyGlobalDropPath(path);
      if (!kind) return;
      // 全局接管:preventDefault + 标记,但不 stopPropagation ——
      // 内层 drop 区自查标记后清理自己的拖拽 UI 状态(见文件头注释)。
      e.preventDefault();
      markGlobalDropIntercepted(e);
      if (kind === 'cindy') {
        // 验明正身 → 确认弹窗 → 装入的编排在 installFlow(与设置页装入按钮同契约)。
        void confirmAndInstallGhost(path, {
          t,
          confirm,
          confirmWithCheckbox,
          getSidebarSessionId: getRightSidebarSessionId,
        });
        return;
      }
      void window.electronAPI.localDb.sessionShare
        .classifyPath({ path })
        .then((res) => {
          if (res.kind === 'share') onOpenShareImport(path);
        })
        .catch((err) => log.warn('classify dropped share file failed', err));
    };
    // ---- 冒泡层:落空白处的兜底(内层 stopPropagation / capture 接管过的都到不了)----
    const onDragOver = (e: DragEvent) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (!files || files.length !== 1) return;
      let path = '';
      try {
        path = window.electronAPI.getFilePath(files[0]);
      } catch {
        return;
      }
      if (!path) return;
      // .cindy / .cshare 已被 capture 层接管,落到这里的 .cindy(理论上不会
      // 出现)静默忽略,不走 classify-path。
      if (path.toLowerCase().endsWith('.cindy')) return;
      void window.electronAPI.localDb.sessionShare
        .classifyPath({ path })
        .then((res) => {
          if (res.kind === 'share') {
            onOpenShareImport(path);
          } else if (res.kind === 'directory') {
            // 与 MainLayout 深链 'new-session' 分支同语义:旧目录的附加只读
            // 引用(extraDirs)对新目录无意义,一并清空。
            patchDraft({ workingDir: path, extraDirs: [] });
            navigate('/cc-agent/new');
          }
        })
        .catch((err) => log.warn('classify dropped path failed', err));
    };
    window.addEventListener('dragenter', onDragEnterCapture, true);
    window.addEventListener('dragleave', onDragLeaveCapture, true);
    window.addEventListener('dragover', onDragOverCapture, true);
    window.addEventListener('drop', onDropCapture, true);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnterCapture, true);
      window.removeEventListener('dragleave', onDragLeaveCapture, true);
      window.removeEventListener('dragover', onDragOverCapture, true);
      window.removeEventListener('drop', onDropCapture, true);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [confirm, confirmWithCheckbox, getRightSidebarSessionId, navigate, onOpenShareImport, t]);

  return (
    <>
      {/* 全窗拖入遮罩:与 composer 拖入文件同一套 token(--drop-overlay-*),
          pointer-events-none 保证 drop 仍落到底下元素、由上面的 window 监听兜住。 */}
      {dragHint && (
        <div
          className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center animate-fade-in"
          style={{
            backgroundColor: 'var(--drop-overlay-bg)',
            border: '2px dashed var(--drop-overlay-border)',
          }}
        >
          <div
            className="rounded-full border px-4 py-2 text-[13px]"
            style={{
              backgroundColor: 'var(--surface-elevated)',
              borderColor: 'var(--border-default)',
              color: 'var(--text-primary)',
            }}
          >
            {t(dragHint === 'cindy' ? 'globalDrop.cindyHint' : 'globalDrop.cshareHint')}
          </div>
        </div>
      )}
    </>
  );
}
