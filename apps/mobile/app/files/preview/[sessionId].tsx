/**
 * 远程文件 Quick Look 预览。
 *
 * 同目录文件横滑翻页(iOS Quick Look 心智):进入时列一次父目录,把全部文件
 * (含不可预览的,显示占位页)按浏览页同款排序装进水平 pager。PDF 例外:
 * 预览期间禁用外层横滑,把缩放后的水平拖动完整留给 WKWebView,避免 pager
 * 抢手势后切换文件;PDF cell 离开渲染窗口时可能被回收,进而重置阅读位置
 * 或再次加载 URL。
 * 切换文件通过 Done 返回列表完成。
 * 文本 = readFile(acceptGzip,pako 解码)+ 行号列表;图片 = 缩略图立即显示,
 * OSS 导出原图就绪后无缝换源(不出 loading 态,规则 7);其它 = 占位 + 下载。
 *
 * absPath 单文件模式(route 参 absPath,与 relPath 互斥):聊天 chip 指向
 * workdir 外文件时进入。file-browser 的 relPath 通道(listDir / readFile /
 * thumbnail / exportFile*)对 workdir 外一律拒绝,该模式改走被控端绝对路径
 * 通道:文本 = text-file:read-preview,媒体/下载 = media:fetch
 * (fetchRemoteAbsFileToUrl);无同目录翻页、无缩略图(直接取原图)。
 */
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, Copy, Database, File as FileIcon, Info, MessageSquarePlus, Share as ShareIcon } from 'lucide-react-native';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Text } from '@/components/AppText';
import { goBackGuarded } from '@/utils/backGuard';
import { useAuth } from '@/auth/AuthContext';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useUnresponsiveDevices } from '@/device-link/unresponsiveDevicesStore';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { useMobileMakerTransport } from '@/device-link/useMobileMakerTransport';
import type { FileBrowserReadFileResult, MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { isAbsolutePathShape, pathDisplayName } from '@/session/chatPathCandidate';
import { adaptTextFilePreviewResult, fetchRemoteAbsFileToUrl } from '@/session/remoteAbsFileFetch';
import { formatByteSize } from '@/session/filePreview';
import { decodeGzipBase64Text, mergePathIntoComposerDraft, shareMimeForFileName } from '@/session/fileBrowserActions';
import { appendQuote, truncateQuoteText } from '@/session/chatQuoteStore';
import { getCachedPreviewText, storeCachedPreviewText } from '@/session/fileBrowserCache';
import { exportRemoteFileToUrl } from '@/session/fileBrowserExport';
import { MarkdownFileReader } from '@/session/MarkdownFileReader';
import { RemoteMediaPlayerWebView } from '@/session/mediaPlayerWebView';
import {
  buildFileBrowserGridItems,
  normalizeRemoteOpDirEntries,
  parentRelPath,
  type FileBrowserGridItem,
  type FileBrowserSortMode,
} from '@/session/fileBrowserGrid';
import { useFileThumbnail } from '@/session/fileThumbnails';
import { ImageLightbox } from '@/session/ImageLightbox';
import { buildMediaPayload } from '@/session/messagePayload';
import type { MobileMessageGalleryImage } from '@/session/messageGallery';
import type { MobileRemoteMediaPresignResult } from '@/session/remoteMedia';
import { downloadRemoteMediaShareTemp } from '@/session/remoteMediaDiskCacheExpo';
import { remoteSessionStore, useRemoteSessions } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';
import { fontWeight, lineHeight, monoFont, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { iconSize, iconStroke, radius, spacing, typeScale } from '@/theme/tokens';

const MAX_RENDERED_LINES = 5000;
const NOTICE_DISMISS_MS = 2500;

type TextPreviewState =
  | { status: 'loading' }
  | { status: 'ready'; lines: string[]; truncated: boolean; totalLines: number; content?: string }
  | { status: 'unavailable'; reason: string; oversize?: boolean };

function isMarkdownFile(name: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(name);
}

/** 音视频类型(复用消息里的 RemoteMediaPlayerWebView 播放器)。 */
function avKindFor(name: string): 'video' | 'audio' | null {
  if (/\.(mp4|mov|m4v|webm)$/i.test(name)) return 'video';
  if (/\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(name)) return 'audio';
  return null;
}

export default function RemoteFilePreviewScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{
    sessionId: string;
    deviceId?: string;
    deviceName?: string;
    relPath?: string;
    absPath?: string;
    sort?: string;
    line?: string;
  }>();
  const sessionId = String(params.sessionId ?? '');
  const routeDeviceId = readRouteString(params.deviceId);
  const deviceId = routeDeviceId ?? remoteSessionStore.getSessionDeviceId(sessionId) ?? '';
  const initialRelPath = readRouteString(params.relPath) ?? '';
  // absPath 单文件模式:workdir 外文件,relPath 通道不可用(详见文件头注释)。
  const singleAbsPath = initialRelPath ? null : readRouteString(params.absPath);
  const sortParam = readRouteString(params.sort);
  const sortMode: FileBrowserSortMode = sortParam === 'mtime' || sortParam === 'size' ? sortParam : 'name';
  // 内容搜索进入时的命中行(只作用于最初打开的那个文件)。
  const targetLineRaw = Number(readRouteString(params.line) ?? '');
  const targetLine = Number.isInteger(targetLineRaw) && targetLineRaw > 0 ? targetLineRaw : null;
  const router = useRouter();
  const { width: pageWidth } = useWindowDimensions();
  const { openLink } = useDeviceLink();
  const auth = useAuth();
  const maker = useMobileMakerTransport(deviceId);
  const sessions = useRemoteSessions();
  const knownSession = useMemo(
    () => sessions.find((item) => item.id === sessionId) ?? null,
    [sessionId, sessions],
  );
  const [session, setSession] = useState<RemoteSession | null>(knownSession);
  const workdir = session?.workingDir ?? '';

  const [siblings, setSiblings] = useState<FileBrowserGridItem[] | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), NOTICE_DISMISS_MS);
  }, []);

  useEffect(() => () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
  }, []);

  // 卸载标记:导出轮询最长 2 分钟,用户中途离开页面时必须中止循环,
  // 不能靠 busyLabel(只防并发)兜底。
  const unmountedRef = useRef(false);
  useEffect(() => () => {
    unmountedRef.current = true;
  }, []);

  // deviceUnresponsive 进依赖(review P1):深链进入且无缓存会话时,首次
  // getSession 若撞上熔断 open 会拿到 DEVICE_UNRESPONSIVE 快速失败;本页只
  // track openLink、不持有 topic,恢复 rehydrate 的 reseed 也覆盖不到——不随
  // 熔断状态翻转重跑的话,探测成功后预览页仍永久空白。翻转重跑最多多发一次
  // 轻量请求(open 期间是本地快速失败,零管道流量)。
  const unresponsiveDevices = useUnresponsiveDevices();
  const deviceUnresponsive = !!deviceId && unresponsiveDevices.has(deviceId);
  // 熔断恢复代数(review P1):open→closed 翻转沿 +1。仅重试 getSession 不够——
  // 会话已缓存时,同目录 pager 可能已退化成单文件、文本/PDF/音视频子页已落进
  // 失败态,而子页用 requestedRef/loadedRef 防重复请求,失败后绝不自行重试。
  // 代数驱动两件事:pager effect 重列目录;非 PDF 子页通过 FlatList key 整体
  // 重挂载(refs 归零、重新拉取)。PDF 保持已加载 WebView 的稳定 key,仅在
  // 上次导出失败且代数前进时由 PdfPreviewPage 原地重试,避免恢复沿重置阅读位置。
  const [recoveryEpoch, setRecoveryEpoch] = useState(0);
  const prevBreakerStateRef = useRef({ deviceId, unresponsive: deviceUnresponsive });
  useEffect(() => {
    const prev = prevBreakerStateRef.current;
    prevBreakerStateRef.current = { deviceId, unresponsive: deviceUnresponsive };
    // 换设备不是恢复沿(review):页面保持挂载但路由参数换了设备时,「上一台
    // 未响应、这一台正常」不该触发整个 pager 重挂载——新设备的加载由各 effect
    // 的 deviceId 依赖自然驱动。
    if (prev.deviceId !== deviceId) return;
    if (prev.unresponsive && !deviceUnresponsive) setRecoveryEpoch((epoch) => epoch + 1);
  }, [deviceId, deviceUnresponsive]);
  useEffect(() => {
    if (knownSession) {
      setSession(knownSession);
      return;
    }
    if (!deviceId || !sessionId) return;
    void withTransientRemoteRetry(async () => {
      await openLink(deviceId);
      return maker.getSession(sessionId);
    })
      .then((loaded) => {
        setSession(loaded);
        // 清掉熔断 open 期间留下的错误快照,恢复后不再残留降级横幅。
        setError(null);
      })
      .catch((err) => setError(formatRemoteError(err)));
  }, [deviceId, deviceUnresponsive, knownSession, maker, openLink, sessionId]);

  // absPath 单文件模式:不列目录,直接以合成 item 装单页 pager。
  useEffect(() => {
    if (!singleAbsPath) return;
    setSiblings([absPathItem(singleAbsPath)]);
    setPageIndex(0);
  }, [singleAbsPath]);

  // 同目录 pager:列父目录 → 文件项按浏览页同款排序;失败时退化为单文件。
  // 重建列表时锚定「当前可见文件」而非固定 initialRelPath(review P1):恢复
  // 重列 / 排序切换发生在用户已翻页之后时,重置回初始文件会让 FlatList 的
  // 原生滚动位置与 pageIndex(标题 / 分享 / 下载的目标)指向两个不同文件。
  // setPageIndex 后再显式 scrollToOffset 重锚一次(initialScrollIndex 只在
  // 首挂载生效,items key 变化不会重置 contentOffset)。
  useEffect(() => {
    if (!deviceId || !workdir || !initialRelPath) return undefined;
    let cancelled = false;
    const dirRel = parentRelPath(initialRelPath) ?? '';
    const anchorRelPath = currentRelPathRef.current ?? initialRelPath;
    const anchorTo = (index: number): void => {
      setPageIndex(index);
      requestAnimationFrame(() => {
        if (!cancelled) {
          pagerRef.current?.scrollToOffset({ animated: false, offset: index * pageWidthRef.current });
        }
      });
    };
    void withTransientRemoteRetry(async () => {
      await openLink(deviceId);
      return maker.fileBrowser.listDir(workdir, dirRel);
    })
      .then((raw) => {
        if (cancelled) return;
        // 图片已统一走浏览页的 ImageLightbox,翻页器只装非图片文件;
        // 仅当直接以图片路径进入(旧链路兜底)时保留该图片单页。
        const files = buildFileBrowserGridItems(normalizeRemoteOpDirEntries(raw), sortMode, Date.now())
          .filter((item) => item.kind === 'file')
          .filter((item) => item.thumb !== 'image' || item.relPath === initialRelPath);
        let index = files.findIndex((item) => item.relPath === anchorRelPath);
        if (index < 0) index = files.findIndex((item) => item.relPath === initialRelPath);
        if (files.length === 0 || index < 0) {
          setSiblings([fallbackItem(initialRelPath)]);
          anchorTo(0);
          return;
        }
        setSiblings(files);
        anchorTo(index);
      })
      .catch(() => {
        if (cancelled) return;
        setSiblings([fallbackItem(initialRelPath)]);
        anchorTo(0);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId, initialRelPath, maker, openLink, recoveryEpoch, sortMode, workdir]);

  const current = siblings?.[pageIndex] ?? null;
  const pagerRef = useRef<FlatList<FileBrowserGridItem>>(null);
  // 当前可见文件路径镜像(pager 重建锚定用;不能进上面 effect 的依赖,否则
  // 每次翻页都会重列目录)。
  const currentRelPathRef = useRef<string | null>(null);
  useEffect(() => {
    currentRelPathRef.current = current?.relPath ?? null;
  }, [current]);
  // pageWidth 镜像:重锚回调里读现值,不把 pageWidth 拉进列表 effect 依赖
  // (旋转已有专门的重锚 effect)。
  const pageWidthRef = useRef(pageWidth);
  useEffect(() => {
    pageWidthRef.current = pageWidth;
  }, [pageWidth]);

  // 旋转(宽度变化)时按当前页重锚:FlatList 保留的是旧宽度下的像素 contentOffset,
  // 不重锚会停在两页中间(处理方式对齐 ImageLightbox)。
  useEffect(() => {
    pagerRef.current?.scrollToOffset({ animated: false, offset: pageIndex * pageWidth });
    // pageIndex 不进依赖:翻页由手势驱动,这里只响应宽度突变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageWidth]);

  const absolutePathOf = useCallback((itemRelPath: string) => {
    // absPath 单文件模式的 item.relPath 本身就是被控端绝对路径,原样返回。
    if (isAbsolutePathShape(itemRelPath)) return itemRelPath;
    if (!workdir) return itemRelPath;
    const sep = workdir.includes('\\') ? '\\' : '/';
    const tail = sep === '\\' ? itemRelPath.replace(/\//g, '\\') : itemRelPath;
    return `${workdir}${workdir.endsWith(sep) ? '' : sep}${tail}`;
  }, [workdir]);

  const presignGet = useCallback(async (ossKey: string) => {
    return auth.apiFetch<MobileRemoteMediaPresignResult>('/api/device-link/media/presign-get', {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      method: 'POST',
      body: { key: ossKey },
    });
  }, [auth]);

  /**
   * 两段式导出 → presign 下载地址(图片/PDF/音视频原件与「下载原文件」共用)。
   * 实现在 fileBrowserExport(与浏览页长按分享共用):path+mtime 缓存、
   * 轮询瞬断重试、卸载中止。
   * absPath 单文件模式改走 media:fetch 绝对路径取件(exportFile* 对 workdir
   * 外路径一律拒绝),relPath/mtime 参数此时被忽略。
   */
  const exportToUrl = useCallback(
    (relPath: string, mtimeMs: number): Promise<string> => {
      if (singleAbsPath) {
        return fetchRemoteAbsFileToUrl({ maker, deviceId, openLink, presignGet }, singleAbsPath);
      }
      return exportRemoteFileToUrl(
        { maker, deviceId, openLink, presignGet, isCancelled: () => unmountedRef.current },
        workdir,
        relPath,
        mtimeMs,
      );
    },
    [deviceId, maker, openLink, presignGet, singleAbsPath, workdir],
  );

  // 文本预览读文件也走瞬断重试 + openLink(与列表/搜索/导出同一路径),
  // relay 短暂重连不再把预览页打成「读取失败」。
  // absPath 单文件模式走 text-file:read-preview(被控端绝对路径文本通道),
  // 回包适配成 readFile 同构结果,文本页零分支。
  const readTextFile = useCallback(
    (relPath: string): Promise<FileBrowserReadFileResult> =>
      withTransientRemoteRetry(async () => {
        await openLink(deviceId);
        if (singleAbsPath) {
          const res = await maker.fs.readTextFilePreview(singleAbsPath);
          return adaptTextFilePreviewResult(singleAbsPath, res);
        }
        return maker.fileBrowser.readFile(workdir, relPath, { acceptGzip: true });
      }),
    [deviceId, maker, openLink, singleAbsPath, workdir],
  );

  const downloadAndShare = useCallback(async (item: FileBrowserGridItem) => {
    if (busyLabel) return;
    setBusyLabel(t('files.preview.exporting'));
    try {
      const url = await exportToUrl(item.relPath, item.mtimeMs);
      // 传原始文件名:分享单按真实扩展名识别类型(PDF/视频等非图片 mime 不在
      // extOfMime 映射里,不带名字会落成 .img 让接收方无法预览)。
      const mime = shareMimeForFileName(item.name);
      const localUri = await downloadRemoteMediaShareTemp(url, mime, item.name);
      if (!localUri) throw new Error(t('files.preview.downloadFailed'));
      const sharing = await import('expo-sharing');
      await sharing.shareAsync(localUri, { mimeType: mime });
    } catch (err) {
      showNotice(formatRemoteError(err));
    } finally {
      setBusyLabel(null);
    }
  }, [busyLabel, exportToUrl, showNotice, t]);

  const copyPath = useCallback(async (item: FileBrowserGridItem) => {
    await Clipboard.setStringAsync(absolutePathOf(item.relPath));
    showNotice(t('files.preview.copiedPath'));
  }, [absolutePathOf, showNotice, t]);

  const sendToSession = useCallback((item: FileBrowserGridItem) => {
    const merged = mergePathIntoComposerDraft(sessionId, item.relPath);
    router.navigate({
      pathname: '/sessions/[sessionId]',
      params: {
        sessionId,
        deviceId,
        draft: merged,
        focusComposerRequestKey: String(Date.now()),
      },
    });
  }, [deviceId, router, sessionId]);

  const lightboxImages = useMemo((): readonly MobileMessageGalleryImage[] => {
    if (!lightboxUrl || !current) return [];
    const payload = buildMediaPayload({ kind: 'image', url: lightboxUrl, previewable: true }, current.name);
    if (payload.kind !== 'media') return [];
    return [{
      key: `file:${current.relPath}`,
      title: current.name,
      url: lightboxUrl,
      payload,
    }];
  }, [current, lightboxUrl]);

  if (!current || !siblings) {
    return (
      <SafeAreaView style={styles.safeArea} testID="filePreview.screen">
        <PreviewNav
          meta={error ?? ''}
          onDone={() => goBackGuarded(router)}
          onShare={null}
          title={pathDisplayName(singleAbsPath ?? initialRelPath)}
        />
        <View style={styles.centerFill}>
          {error ? <Text style={styles.hintText}>{error}</Text> : <ActivityIndicator color={colors.textTertiary} />}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} testID="filePreview.screen">
      <PreviewNav
        meta={[
          `${pageIndex + 1} / ${siblings.length}`,
          // absPath 单文件模式没有目录列举,size 未知(0)不显示,避免「0 B」。
          ...(current.sizeBytes > 0 ? [formatByteSize(current.sizeBytes)] : []),
        ].join(' · ')}
        onDone={() => goBackGuarded(router)}
        onShare={() => void downloadAndShare(current)}
        title={current.name}
      />
      <View style={styles.navHairline} />

      <FlatList
        data={siblings}
        getItemLayout={(_, index) => ({ index, length: pageWidth, offset: pageWidth * index })}
        ref={pagerRef}
        horizontal
        initialScrollIndex={pageIndex}
        keyExtractor={(item) => (
          item.previewKind === 'pdf' ? item.key : `${item.key}:${recoveryEpoch}`
        )}
        onMomentumScrollEnd={(event) => {
          const next = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
          if (next !== pageIndex && next >= 0 && next < siblings.length) setPageIndex(next);
        }}
        pagingEnabled
        renderItem={({ item, index }) => (
          <View style={{ width: pageWidth }}>
            <FilePreviewPage
              active={Math.abs(index - pageIndex) <= 1}
              exportToUrl={exportToUrl}
              item={item}
              maker={maker}
              onDownload={() => void downloadAndShare(item)}
              // chat-text-quote:markdown 渲染态选中文字 → 引用进会话草稿
              // (携带当前文件路径,— source: 行),随即切回对话界面——与
              // 「发送到会话」(sendToSession)的图片/路径处理一致(产品决策);
              // 引用在全局 store,导航后 composer 胶囊即时可见。
              onQuoteSelection={(text) => {
                appendQuote(sessionId, {
                  text: truncateQuoteText(text),
                  sourcePath: item.relPath,
                });
                router.navigate({
                  pathname: '/sessions/[sessionId]',
                  params: {
                    sessionId,
                    deviceId,
                    focusComposerRequestKey: String(Date.now()),
                  },
                });
              }}
              readTextFile={readTextFile}
              onOpenLightbox={setLightboxUrl}
              recoveryEpoch={recoveryEpoch}
              targetLine={item.relPath === (singleAbsPath ?? initialRelPath) ? targetLine : null}
              workdir={workdir}
            />
          </View>
        )}
        scrollEnabled={current.previewKind !== 'pdf'}
        showsHorizontalScrollIndicator={false}
        windowSize={3}
      />

      <View style={styles.toolbarHairline} />
      <View style={styles.toolbar}>
        <ToolbarButton
          disabled={!!busyLabel}
          Icon={Copy}
          label={t('files.preview.copyPath')}
          onPress={() => void copyPath(current)}
          testID="filePreview.copyPath"
        />
        <ToolbarButton
          disabled={!!busyLabel}
          Icon={MessageSquarePlus}
          label={t('files.preview.sendToSession')}
          onPress={() => sendToSession(current)}
          testID="filePreview.sendToSession"
        />
      </View>
      {busyLabel || notice ? (
        <Text style={styles.noticeText} testID="filePreview.notice">{busyLabel ?? notice}</Text>
      ) : null}

      {lightboxImages.length > 0 ? (
        <ImageLightbox
          images={lightboxImages}
          initialUrl={lightboxImages[0].url}
          onClose={() => setLightboxUrl(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

/* ------------------------------ 页面组件 ------------------------------ */

function PreviewNav({
  meta,
  onDone,
  onShare,
  title,
}: {
  meta: string;
  onDone(): void;
  onShare: (() => void) | null;
  title: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <View style={styles.navRow}>
      <Pressable accessibilityLabel={t('files.preview.done')} hitSlop={10} onPress={onDone} testID="filePreview.done">
        <Text style={styles.doneText}>{t('files.preview.done')}</Text>
      </Pressable>
      <View style={styles.navTitleCol}>
        <Text numberOfLines={1} style={styles.navTitle} testID="filePreview.title">{title}</Text>
        {meta ? <Text numberOfLines={1} style={styles.navMeta}>{meta}</Text> : null}
      </View>
      {onShare ? (
        <Pressable accessibilityLabel={t('files.preview.a11yShare')} hitSlop={10} onPress={onShare} testID="filePreview.share">
          <ShareIcon color={colors.textPrimary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
        </Pressable>
      ) : (
        <View style={{ width: iconSize.xl }} />
      )}
    </View>
  );
}

function FilePreviewPage({
  active,
  exportToUrl,
  item,
  maker,
  onDownload,
  onOpenLightbox,
  onQuoteSelection,
  readTextFile,
  recoveryEpoch,
  targetLine,
  workdir,
}: {
  active: boolean;
  exportToUrl(relPath: string, mtimeMs: number): Promise<string>;
  item: FileBrowserGridItem;
  maker: Pick<MobileMakerTransport, 'fileBrowser'>;
  onDownload(): void;
  onOpenLightbox(url: string): void;
  /** chat-text-quote:markdown 渲染态的选中引用回调(仅文本页消费)。 */
  onQuoteSelection?: (text: string) => void;
  readTextFile(relPath: string): Promise<FileBrowserReadFileResult>;
  recoveryEpoch: number;
  targetLine: number | null;
  workdir: string;
}) {
  const { t } = useTranslation();
  if (item.thumb === 'image') {
    return (
      <ImagePreviewPage
        active={active}
        exportToUrl={exportToUrl}
        item={item}
        maker={maker}
        onOpenLightbox={onOpenLightbox}
        workdir={workdir}
      />
    );
  }
  if (item.previewKind === 'pdf') {
    return <PdfPreviewPage active={active} exportToUrl={exportToUrl} item={item} onDownload={onDownload} recoveryEpoch={recoveryEpoch} workdir={workdir} />;
  }
  const avKind = avKindFor(item.name);
  if (avKind) {
    return <AvPreviewPage active={active} exportToUrl={exportToUrl} item={item} kind={avKind} onDownload={onDownload} workdir={workdir} />;
  }
  if (item.thumb === 'doc') {
    return <TextPreviewPage active={active} item={item} onDownload={onDownload} onQuoteSelection={onQuoteSelection} readTextFile={readTextFile} targetLine={targetLine} workdir={workdir} />;
  }
  return <UnsupportedPage item={item} onDownload={onDownload} reason={t('files.preview.unsupportedType')} />;
}

/** 音视频页:导出→presign→复用消息同款播放器(切后台/换页自动暂停)。 */
function AvPreviewPage({
  active,
  exportToUrl,
  item,
  kind,
  onDownload,
  workdir,
}: {
  active: boolean;
  exportToUrl(relPath: string, mtimeMs: number): Promise<string>;
  item: FileBrowserGridItem;
  kind: 'video' | 'audio';
  onDownload(): void;
  workdir: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (!active || requestedRef.current || !workdir) return undefined;
    requestedRef.current = true;
    let cancelled = false;
    setFailure(null);
    void exportToUrl(item.relPath, item.mtimeMs)
      .then((next) => {
        if (!cancelled) setUrl(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setFailure(formatRemoteError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [active, exportToUrl, item.mtimeMs, item.relPath, workdir]);

  if (failure) {
    return <UnsupportedPage item={item} onDownload={onDownload} reason={t('files.preview.fetchAvFailed', { detail: failure })} />;
  }
  if (!url) {
    return (
      <View style={styles.centerFill} testID="filePreview.avLoading">
        <ActivityIndicator color={colors.textTertiary} />
        <Text style={styles.hintText}>{kind === 'video' ? t('files.preview.fetchingVideo') : t('files.preview.fetchingAudio')}</Text>
      </View>
    );
  }
  return (
    <View style={styles.avPage}>
      <RemoteMediaPlayerWebView
        kind={kind}
        style={styles.avPlayer}
        testID="filePreview.avPlayer"
        title={item.name}
        url={url}
      />
    </View>
  );
}

/** PDF 页:导出到 OSS → presign → WebView(iOS WKWebView 原生渲 PDF)。 */
function PdfPreviewPage({
  active,
  exportToUrl,
  item,
  onDownload,
  recoveryEpoch,
  workdir,
}: {
  active: boolean;
  exportToUrl(relPath: string, mtimeMs: number): Promise<string>;
  item: FileBrowserGridItem;
  onDownload(): void;
  recoveryEpoch: number;
  workdir: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [requestEpoch, setRequestEpoch] = useState(0);
  const requestedRef = useRef(false);
  const latestRecoveryEpochRef = useRef(recoveryEpoch);
  const requestedAtRecoveryEpochRef = useRef(recoveryEpoch);

  useEffect(() => {
    latestRecoveryEpochRef.current = recoveryEpoch;
  }, [recoveryEpoch]);

  // 已成功加载的 PDF 不随设备恢复沿重挂载或重新取 URL;只有上次导出失败,
  // 且失败尝试发生在更早的恢复代数时,才清掉一次性请求门闩原地重试。
  useEffect(() => {
    if (!failure || requestedAtRecoveryEpochRef.current >= recoveryEpoch) return;
    requestedRef.current = false;
    setFailure(null);
    setRequestEpoch((epoch) => epoch + 1);
  }, [failure, recoveryEpoch]);

  useEffect(() => {
    if (!active || requestedRef.current || !workdir) return undefined;
    requestedRef.current = true;
    requestedAtRecoveryEpochRef.current = latestRecoveryEpochRef.current;
    let cancelled = false;
    setFailure(null);
    void exportToUrl(item.relPath, item.mtimeMs)
      .then((next) => {
        if (!cancelled) setUrl(next);
      })
      .catch((err) => {
        if (cancelled) return;
        // 保持 requestedRef=true:失败态由 UnsupportedPage 呈现,不在当前
        // 恢复代数里自动循环;下一次设备恢复沿重试,或离开后重新打开。
        setFailure(formatRemoteError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [active, exportToUrl, item.mtimeMs, item.relPath, requestEpoch, workdir]);
  const pdfSource = useMemo(() => (url ? { uri: url } : null), [url]);

  if (failure) {
    return <UnsupportedPage item={item} onDownload={onDownload} reason={t('files.preview.fetchPdfFailed', { detail: failure })} />;
  }
  if (!pdfSource) {
    return (
      <View style={styles.centerFill} testID="filePreview.pdfLoading">
        <ActivityIndicator color={colors.textTertiary} />
        <Text style={styles.hintText}>{t('files.preview.fetchingPdf')}</Text>
      </View>
    );
  }
  return <WebView source={pdfSource} style={styles.pdfView} testID="filePreview.pdfView" />;
}

/** 文本/代码页:readFile(acceptGzip)→ 行号列表;OVERSIZE/BINARY 退占位。 */
function TextPreviewPage({
  active,
  item,
  onDownload,
  onQuoteSelection,
  readTextFile,
  targetLine,
  workdir,
}: {
  active: boolean;
  item: FileBrowserGridItem;
  onDownload(): void;
  /** chat-text-quote:markdown 渲染态的选中引用回调(源码态暂不支持,见 PR 说明)。 */
  onQuoteSelection?: (text: string) => void;
  /** 屏级注入:readFile 带瞬断重试 + openLink(与列表/搜索/导出同路径)。 */
  readTextFile(relPath: string): Promise<FileBrowserReadFileResult>;
  targetLine: number | null;
  workdir: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const markdown = isMarkdownFile(item.name);
  // absPath 单文件模式(item.relPath 为绝对路径)没有可靠 mtime(恒 0),
  // 缓存键无法随文件覆写失效,读写一律跳过缓存。
  const cacheable = !!workdir && !isAbsolutePathShape(item.relPath);
  const [state, setState] = useState<TextPreviewState>(() => {
    // 内存缓存命中(mtime keyed)直接就绪:翻页/重进零等待、零重复拉取。
    const cached = cacheable ? getCachedPreviewText(workdir, item.relPath, item.mtimeMs) : null;
    return cached
      ? {
          status: 'ready',
          lines: cached.lines,
          totalLines: cached.totalLines,
          truncated: cached.truncated,
          content: cached.content,
        }
      : { status: 'loading' };
  });
  // markdown 默认渲染态(带命中行也进渲染态——渲染层按块级 data-src-line 定位到
  // 覆盖目标行的块并闪高亮;切到源码态仍走精确行号跳转),可切源码;非 md 恒为源码态。
  const [mdView, setMdView] = useState<'rendered' | 'source'>(markdown ? 'rendered' : 'source');
  const loadedRef = useRef(state.status === 'ready');
  const codeListRef = useRef<FlatList<string>>(null);
  const scrolledToTargetRef = useRef(false);

  useEffect(() => {
    if (!active || loadedRef.current || !workdir) return;
    loadedRef.current = true;
    let cancelled = false;
    void readTextFile(item.relPath)
      .then((res: FileBrowserReadFileResult) => {
        if (cancelled) return;
        if (!res.ok) {
          if (res.code === 'OVERSIZE') {
            setState({
              status: 'unavailable',
              oversize: true,
              reason: t('files.preview.oversize', {
                size: res.stat ? formatByteSize(res.stat.size) : t('files.preview.oversizeUnknown'),
              }),
            });
          } else if (res.code === 'BINARY_FILE') {
            setState({ status: 'unavailable', reason: t('files.preview.binaryFile') });
          } else {
            setState({ status: 'unavailable', reason: res.message ?? t('files.preview.readFailed') });
          }
          return;
        }
        const content = res.data.contentEncoding === 'gzip'
          ? decodeGzipBase64Text(res.data.content)
          : res.data.content;
        const allLines = content.split('\n');
        const ready = {
          lines: allLines.slice(0, MAX_RENDERED_LINES),
          totalLines: allLines.length,
          truncated: res.data.truncated === true,
          // 原文只为 markdown 渲染态保留,普通代码文件不留大字符串。
          content: markdown ? content : undefined,
        };
        if (cacheable) storeCachedPreviewText(workdir, item.relPath, res.data.mtimeMs, ready);
        setState({ status: 'ready', ...ready });
      })
      .catch((err) => {
        if (cancelled) return;
        loadedRef.current = false; // 传输层瞬断允许重进重试
        setState({ status: 'unavailable', reason: formatRemoteError(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [active, cacheable, item.relPath, markdown, readTextFile, t, workdir]);

  if (state.status === 'loading') {
    return (
      <View style={styles.centerFill}>
        <ActivityIndicator color={colors.textTertiary} />
      </View>
    );
  }
  if (state.status === 'unavailable') {
    return <UnsupportedPage item={item} onDownload={onDownload} reason={state.reason} />;
  }

  const targetIndex = targetLine !== null && targetLine <= state.lines.length ? targetLine - 1 : null;
  const lineNumWidth = String(state.lines.length).length;
  const clipped = state.truncated || state.totalLines > state.lines.length;
  const canRenderMarkdown = markdown && typeof state.content === 'string';
  const showRendered = canRenderMarkdown && mdView === 'rendered';
  return (
    <View style={styles.textPage}>
      {clipped ? (
        <View style={styles.truncBar} testID="filePreview.truncBanner">
          <Info color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          <Text style={styles.truncText}>
            {state.truncated ? t('files.preview.truncated2mb') : t('files.preview.truncatedLines', { lines: MAX_RENDERED_LINES })}
          </Text>
        </View>
      ) : null}
      {canRenderMarkdown ? (
        <View style={styles.mdToggleRow}>
          {([['rendered', t('files.preview.mdRendered')], ['source', t('files.preview.mdSource')]] as const).map(([value, label]) => (
            <Pressable
              accessibilityLabel={t('files.preview.mdViewA11y', { view: label })}
              key={value}
              onPress={() => setMdView(value)}
              style={[styles.mdTogglePill, mdView === value && styles.mdTogglePillActive]}
              testID={`filePreview.mdView.${value}`}
            >
              <Text style={[styles.mdToggleLabel, mdView === value && styles.mdToggleLabelActive]}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {showRendered ? (
        <MarkdownFileReader markdown={state.content ?? ''} onQuoteSelection={onQuoteSelection} targetLine={targetLine} testID="filePreview.markdownRendered" />
      ) : (
      <FlatList
        contentContainerStyle={styles.codeContent}
        data={state.lines}
        initialNumToRender={40}
        keyExtractor={(_, index) => String(index)}
        onLayout={() => {
          // 内容搜索进入:列表就绪后跳到命中行(行高不定,先 scrollToIndex,
          // 超出渲染窗时由 onScrollToIndexFailed 按估算行高兜底再补跳)。
          if (targetIndex === null || scrolledToTargetRef.current) return;
          scrolledToTargetRef.current = true;
          setTimeout(() => {
            codeListRef.current?.scrollToIndex({ animated: false, index: targetIndex, viewPosition: 0.3 });
          }, 60);
        }}
        onScrollToIndexFailed={(info) => {
          codeListRef.current?.scrollToOffset({ animated: false, offset: info.averageItemLength * info.index });
          setTimeout(() => {
            codeListRef.current?.scrollToIndex({ animated: false, index: info.index, viewPosition: 0.3 });
          }, 220);
        }}
        ref={codeListRef}
        renderItem={({ item: line, index }) => (
          <View style={[styles.codeLine, index === targetIndex && styles.codeLineHit]}>
            <Text style={styles.codeLineNum}>{String(index + 1).padStart(lineNumWidth, ' ')}</Text>
            <Text selectable style={styles.codeText}>{line.length > 0 ? line : ' '}</Text>
          </View>
        )}
        style={styles.codeList}
      />
      )}
    </View>
  );
}

/** 图片页:缩略图立即显示,原图导出就绪后无缝换源;点按进 lightbox 缩放。 */
function ImagePreviewPage({
  active,
  exportToUrl,
  item,
  maker,
  onOpenLightbox,
  workdir,
}: {
  active: boolean;
  exportToUrl(relPath: string, mtimeMs: number): Promise<string>;
  item: FileBrowserGridItem;
  maker: Pick<MobileMakerTransport, 'fileBrowser'>;
  onOpenLightbox(url: string): void;
  workdir: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  // absPath 单文件模式(item.relPath 为绝对路径):thumbnail op 只认 workdir
  // 内 relPath,禁用缩略图,直接等原图(media:fetch 通道)。
  const thumbUri = useFileThumbnail(
    maker,
    workdir,
    item.relPath,
    item.mtimeMs,
    active && !isAbsolutePathShape(item.relPath),
  );
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (!active || requestedRef.current || !workdir) return undefined;
    requestedRef.current = true;
    let cancelled = false;
    setFailure(null);
    void exportToUrl(item.relPath, item.mtimeMs)
      .then((url) => {
        if (!cancelled) setFullUrl(url);
      })
      .catch((err) => {
        if (cancelled) return;
        requestedRef.current = false; // 允许「重试」按钮/重进再次发起
        setFailure(formatRemoteError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [active, attempt, exportToUrl, item.mtimeMs, item.relPath, workdir]);

  const displayUri = fullUrl ?? thumbUri;
  return (
    <Pressable
      accessibilityLabel={t('files.preview.a11yViewImage', { name: item.name })}
      disabled={!displayUri}
      onPress={() => displayUri && onOpenLightbox(fullUrl ?? displayUri)}
      style={styles.imagePage}
      testID="filePreview.imagePage"
    >
      {displayUri ? (
        <Image resizeMode="contain" source={{ uri: displayUri }} style={styles.imageFull} />
      ) : failure ? (
        <View style={styles.imageStateWrap} testID="filePreview.imageError">
          <GenericGlyph name={item.name} />
          <Text style={styles.hintText}>{t('files.preview.fetchOriginalFailed', { detail: failure })}</Text>
          <Pressable
            accessibilityLabel={t('files.preview.a11yRetryOriginal')}
            onPress={() => setAttempt((n) => n + 1)}
            style={({ pressed }) => [styles.retryBtn, pressed && styles.pressed]}
            testID="filePreview.imageRetry"
          >
            <Text style={styles.retryLabel}>{t('files.preview.retry')}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.imageStateWrap} testID="filePreview.imageLoading">
          <ActivityIndicator color={colors.textTertiary} />
          <Text style={styles.hintText}>{t('files.preview.fetchingOriginal')}</Text>
        </View>
      )}
      {displayUri && !fullUrl ? (
        <Text style={styles.imageUpgradeHint}>
          {failure ? t('files.preview.originalFailedThumb') : t('files.preview.fetchingOriginalHint')}
        </Text>
      ) : null}
    </Pressable>
  );
}

function UnsupportedPage({
  item,
  onDownload,
  reason,
}: {
  item: FileBrowserGridItem;
  onDownload(): void;
  reason: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <View style={styles.centerFill} testID="filePreview.unsupported">
      <View style={styles.bigPage}>
        <GenericGlyph name={item.name} />
      </View>
      <Text style={styles.bigName}>{item.name}</Text>
      <Text style={styles.bigMeta}>{item.metaLabel}</Text>
      <Text style={styles.hintText}>{reason}</Text>
      <Pressable
        accessibilityLabel={t('files.preview.a11yExportShareFile')}
        onPress={onDownload}
        style={({ pressed }) => [styles.ctaBtn, pressed && styles.pressed]}
        testID="filePreview.unsupportedDownload"
      >
        <ArrowDownToLine color={colors.ctaText} size={iconSize.md} strokeWidth={iconStroke.regular} />
        <Text style={styles.ctaLabel}>{t('files.preview.exportShare')}</Text>
      </Pressable>
    </View>
  );
}

function GenericGlyph({ name }: { name: string }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const Icon = /\.(db|sqlite3?|realm)$/i.test(name) ? Database : FileIcon;
  return (
    <View style={styles.genericGlyphCard}>
      <Icon color={colors.borderStrong} size={iconSize.hero} strokeWidth={iconStroke.regular} />
    </View>
  );
}

function ToolbarButton({
  disabled,
  Icon,
  label,
  onPress,
  testID,
}: {
  disabled?: boolean;
  Icon: React.ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;
  label: string;
  onPress(): void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.toolItem, (pressed || disabled) && styles.pressed]}
      testID={testID}
    >
      <Icon color={colors.textPrimary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
      <Text style={styles.toolLabel}>{label}</Text>
    </Pressable>
  );
}

/* ------------------------------ 工具 ------------------------------ */

function fallbackItem(relPath: string): FileBrowserGridItem {
  const name = basename(relPath);
  return buildFileBrowserGridItems(
    [{ name, relPath, type: 'file', size: 0, mtimeMs: 0 }],
    'name',
    Date.now(),
  )[0];
}

/**
 * absPath 单文件模式的合成 item:relPath 字段直接装被控端绝对路径(仅作
 * 页面键/展示/分派用,凡消费 relPath 的取件路径都已按 isAbsolutePathShape
 * 分流),size/mtime 未知置 0(顶栏不显示 size、文本缓存跳过)。
 */
function absPathItem(absPath: string): FileBrowserGridItem {
  return buildFileBrowserGridItems(
    [{ name: pathDisplayName(absPath), relPath: absPath, type: 'file', size: 0, mtimeMs: 0 }],
    'name',
    Date.now(),
  )[0];
}

function basename(relPath: string): string {
  return relPath.split('/').filter(Boolean).pop() ?? relPath;
}

function readRouteString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  return null;
}

const makeStyles = (colors: ThemeColors) => {
  return StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: colors.surfaceElevated },
    pressed: { opacity: 0.72 },
    centerFill: {
      alignItems: 'center',
      flex: 1,
      gap: spacing.md,
      justifyContent: 'center',
      paddingHorizontal: spacing.xl,
    },
    navRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    doneText: { color: colors.textPrimary, fontSize: typeScale.bodyLarge, fontWeight: fontWeight.semibold },
    navTitleCol: { alignItems: 'center', flex: 1, gap: 2, minWidth: 0 },
    navTitle: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.semibold },
    navMeta: { color: colors.textTertiary, fontSize: typeScale.caption },
    navHairline: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth },
    truncBar: {
      alignItems: 'center',
      backgroundColor: colors.surfaceChip,
      flexDirection: 'row',
      gap: spacing.sm - 2,
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm - 1,
    },
    truncText: { color: colors.textSecondary, fontSize: typeScale.caption },
    textPage: { flex: 1 },
    mdToggleRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    mdTogglePill: {
      alignItems: 'center',
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      justifyContent: 'center',
      minHeight: 28,
      paddingHorizontal: spacing.md,
    },
    mdTogglePillActive: { backgroundColor: colors.surfaceChip, borderColor: colors.borderStrong },
    mdToggleLabel: { color: colors.textSecondary, fontSize: typeScale.caption },
    mdToggleLabelActive: { color: colors.textPrimary, fontWeight: fontWeight.medium },
    codeList: { flex: 1 },
    codeContent: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    codeLine: { flexDirection: 'row', gap: spacing.sm + 2 },
    codeLineHit: { backgroundColor: colors.surfaceChip, borderRadius: radius.micro },
    codeLineNum: {
      color: colors.textTertiary,
      fontFamily: monoFont,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
    },
    codeText: {
      color: colors.textPrimary,
      flex: 1,
      fontFamily: monoFont,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
    },
    imagePage: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      flex: 1,
      justifyContent: 'center',
    },
    imageFull: { height: '100%', width: '100%' },
    imageStateWrap: { alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.xl },
    avPage: { flex: 1, justifyContent: 'center', padding: spacing.lg },
    avPlayer: { width: '100%' },
    imageUpgradeHint: {
      bottom: spacing.md,
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      position: 'absolute',
      textAlign: 'center',
      width: '100%',
    },
    retryBtn: {
      alignItems: 'center',
      borderColor: colors.borderStrong,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      justifyContent: 'center',
      minHeight: 40,
      paddingHorizontal: spacing.xl,
    },
    retryLabel: { color: colors.textPrimary, fontSize: typeScale.code, fontWeight: fontWeight.medium },
    pdfView: { flex: 1 },
    bigPage: {
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.xs,
    },
    genericGlyphCard: {
      alignItems: 'center',
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.micro,
      borderWidth: StyleSheet.hairlineWidth,
      height: 156,
      justifyContent: 'center',
      width: 122,
    },
    bigName: { color: colors.textPrimary, fontSize: typeScale.subtitle, fontWeight: fontWeight.semibold },
    bigMeta: { color: colors.textSecondary, fontSize: typeScale.footnote },
    hintText: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.code,
      textAlign: 'center',
    },
    ctaBtn: {
      alignItems: 'center',
      backgroundColor: colors.cta,
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: spacing.sm,
      justifyContent: 'center',
      marginTop: spacing.sm,
      minHeight: 44,
      paddingHorizontal: spacing.xl,
    },
    ctaLabel: { color: colors.ctaText, fontSize: typeScale.code, fontWeight: fontWeight.medium },
    toolbarHairline: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth },
    toolbar: {
      backgroundColor: colors.surface,
      flexDirection: 'row',
      justifyContent: 'space-around',
      paddingBottom: spacing.sm,
      paddingTop: spacing.md,
    },
    toolItem: { alignItems: 'center', gap: spacing.xs, minWidth: 64 },
    toolLabel: { color: colors.textSecondary, fontSize: typeScale.micro },
    noticeText: {
      color: colors.textSecondary,
      fontSize: typeScale.caption,
      paddingBottom: spacing.sm,
      textAlign: 'center',
    },
  });
};
