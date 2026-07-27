/**
 * 远程文件浏览(网格为主视图,对标 iOS Files)。
 *
 * 数据链路:被控端 `file-browser:remote-op` 聚合通道(与桌面 workdir-browse 同源),
 * workdir 相对路径语义,浏览范围收敛在会话工作目录内(被控端 workdir guard 决定)。
 * 目录下钻 = push 本路由新实例(relPath 参数),换取原生返回手势;文件点按 = push
 * Quick Look 预览路由。缩略图经 thumbnail op 懒加载(fileThumbnails 内存缓存)。
 */
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { fsWatchTopic } from '@cindy/device-link';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownAZ,
  ArrowDownWideNarrow,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  Ellipsis,
  Eye,
  File as FileIcon,
  FileCode,
  FileText,
  Folder,
  History,
  Image as ImageIcon,
  LayoutGrid,
  List as ListIcon,
  MessageSquarePlus,
  Search,
  Share as ShareIcon,
  X,
} from 'lucide-react-native';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text, TextInput } from '@/components/AppText';
import { ScreenBackButton } from '@/components/MobilePrimitives';
import { ConnectionBanner, useShowConnectionBanner } from '@/components/ConnectionBanner';
import { useUnresponsiveDevices } from '@/device-link/unresponsiveDevicesStore';
import { goBackGuarded } from '@/utils/backGuard';
import { useAuth } from '@/auth/AuthContext';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { onFileBrowserWatchEvent } from '@/device-link/fileBrowserWatch';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { useMobileMakerTransport } from '@/device-link/useMobileMakerTransport';
import { buildMobileRemoteFileAttachment } from '@/session/attachments';
import {
  queueComposerAnnotationSubmission,
  queueComposerAttachment,
} from '@/session/composerAttachmentInbox';
import { mergePathIntoComposerDraft, shareMimeForFileName } from '@/session/fileBrowserActions';
import { exportRemoteFileToUrl } from '@/session/fileBrowserExport';
import {
  getCachedListingSync,
  loadAllFilesIndex,
  readCachedListing,
  storeCachedListing,
  useDocSnippet,
} from '@/session/fileBrowserCache';
import {
  buildFileBrowserGridItems,
  buildWorkdirPathLevels,
  fileThumbKind,
  filterFileNameMatches,
  normalizeRemoteOpDirEntries,
  parentRelPath,
  summarizeFileBrowserGrid,
  type FileBrowserGridItem,
  type FileBrowserNameMatch,
  type FileBrowserSortMode,
  type FileBrowserViewMode,
} from '@/session/fileBrowserGrid';
import {
  readFileBrowserPrefs,
  readFileBrowserPrefsSync,
  saveFileBrowserPrefs,
} from '@/session/fileBrowserPrefs';
import {
  buildFileBrowserGalleryImages,
  createFileBrowserMediaResolver,
  remoteFileMediaUrl,
} from '@/session/fileBrowserGallery';
import { useFileThumbnail } from '@/session/fileThumbnails';
import {
  ImageLightbox,
  type ImageLightboxAction,
  type ImageLightboxAnnotationConfig,
} from '@/session/ImageLightbox';
import type { MobileMessageGalleryImage } from '@/session/messageGallery';
import type { MobileRemoteMediaPresignResult } from '@/session/remoteMedia';
import { imageMimeFromUrl } from '@/session/remoteMediaDiskCache';
import { downloadRemoteMediaShareTemp } from '@/session/remoteMediaDiskCacheExpo';
import type { FileBrowserSearchMatch, MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { remoteSessionStore, useRemoteSessions } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';
import { fontWeight, lineHeight, monoFont, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { docThumbSnippetType, iconSize, iconStroke, radius, spacing, typeScale } from '@/theme/tokens';

const GRID_COLUMNS = 3;
const NOTICE_DISMISS_MS = 2500;
const SEARCH_FILES_CAP = 20000;

export default function RemoteFileBrowserScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{
    sessionId: string;
    deviceId?: string;
    deviceName?: string;
    relPath?: string;
  }>();
  const sessionId = String(params.sessionId ?? '');
  const routeDeviceId = readRouteString(params.deviceId);
  const deviceId = routeDeviceId ?? remoteSessionStore.getSessionDeviceId(sessionId) ?? '';
  const deviceName = readRouteString(params.deviceName) ?? deviceId;
  const relPath = readRouteString(params.relPath) ?? '';
  const router = useRouter();
  const { width: screenWidth } = useWindowDimensions();
  const auth = useAuth();
  const { connectionIssue, openLink, status, subscribe, unsubscribe } = useDeviceLink();
  const maker = useMobileMakerTransport(deviceId);
  const sessions = useRemoteSessions();
  const knownSession = useMemo(
    () => sessions.find((item) => item.id === sessionId) ?? null,
    [sessionId, sessions],
  );
  const [session, setSession] = useState<RemoteSession | null>(knownSession);
  const workdir = session?.workingDir ?? '';

  const [items, setItems] = useState<FileBrowserGridItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unresponsiveDevices = useUnresponsiveDevices();
  const deviceUnresponsive = !!deviceId && unresponsiveDevices.has(deviceId);
  const showConnectionBanner = useShowConnectionBanner(status, error, connectionIssue, deviceUnresponsive);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<FileBrowserViewMode>(() => readFileBrowserPrefsSync(workdir).view);
  const [sortMode, setSortMode] = useState<FileBrowserSortMode>(() => readFileBrowserPrefsSync(workdir).sort);
  const [titleMenuOpen, setTitleMenuOpen] = useState(false);
  const [contextItem, setContextItem] = useState<FileBrowserGridItem | null>(null);

  const [lightbox, setLightbox] = useState<{
    images: readonly MobileMessageGalleryImage[];
    initialUrl: string;
  } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<'name' | 'content'>('name');
  const [query, setQuery] = useState('');
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [contentMatches, setContentMatches] = useState<FileBrowserSearchMatch[]>([]);
  const [contentSummary, setContentSummary] = useState<string | null>(null);
  const contentSeqRef = useRef(0);

  const loadSeqRef = useRef(0);
  const rawEntriesRef = useRef<ReturnType<typeof normalizeRemoteOpDirEntries>>([]);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sortModeRef = useRef(sortMode);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), NOTICE_DISMISS_MS);
  }, []);

  useEffect(() => () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
  }, []);

  // 卸载标记:长按「导出/分享」的导出轮询最长 2 分钟,退出本屏后必须中止。
  const unmountedRef = useRef(false);
  useEffect(() => () => {
    unmountedRef.current = true;
  }, []);

  // 会话兜底拉取(直接经 deep link 进入时 store 里可能还没有)。
  // deviceUnresponsive 进依赖(review P1,同 preview 页):深链进入且无缓存
  // 会话时,首次 getSession 撞上熔断 open 会永久失败——本页不注册 reseed
  // handler,fs-watch 重订阅也不会主动发事件,恢复后必须自动重跑。
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
        setError(null);
      })
      .catch((err) => setError(formatRemoteError(err)));
  }, [deviceId, deviceUnresponsive, knownSession, maker, openLink, sessionId]);

  // workdir 就绪后加载偏好(异步存储可能比同步内存新)。
  useEffect(() => {
    if (!workdir) return undefined;
    let cancelled = false;
    void readFileBrowserPrefs(workdir).then((prefs) => {
      if (cancelled) return;
      setViewMode(prefs.view);
      setSortMode(prefs.sort);
    });
    return () => {
      cancelled = true;
    };
  }, [workdir]);

  const loadDirectory = useCallback(async (opts?: { refreshing?: boolean }) => {
    if (!deviceId || !workdir) return;
    const seq = ++loadSeqRef.current;
    // 缓存命中时静默刷新(不出 spinner,不清列表),远端结果回来原位更新——
    // 规则 7:获取期间界面不变化,避免"每次进目录都白屏重读"。
    const hasCached = rawEntriesRef.current.length > 0;
    if (opts?.refreshing) setRefreshing(true);
    else if (!hasCached) setLoading(true);
    setError(null);
    try {
      const raw = await withTransientRemoteRetry(async () => {
        await openLink(deviceId);
        return maker.fileBrowser.listDir(workdir, relPath);
      });
      if (seq !== loadSeqRef.current) return;
      rawEntriesRef.current = normalizeRemoteOpDirEntries(raw);
      storeCachedListing(workdir, relPath, rawEntriesRef.current);
      setItems(buildFileBrowserGridItems(rawEntriesRef.current, sortModeRef.current, Date.now()));
      setLastSyncedAt(Date.now());
    } catch (err) {
      if (seq === loadSeqRef.current) setError(formatRemoteError(err));
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [deviceId, maker, openLink, relPath, workdir]);

  // 排序切换只做本地重排,不重新拉取;ref 让 loadDirectory 不依赖 sortMode。
  useEffect(() => {
    sortModeRef.current = sortMode;
    setItems(buildFileBrowserGridItems(rawEntriesRef.current, sortMode, Date.now()));
  }, [sortMode]);

  // 熔断恢复:目录静默刷新(缓存保留不清列表,规则 7)。首次 listDir 撞上
  // 熔断快速失败、或 open 期间目录停更时,恢复不会有任何文件事件来救——
  // 只在 open→closed 翻转沿触发一次;workdir 尚未就绪时 loadDirectory 自身
  // no-op(session bootstrap 的恢复重跑会先把 workdir 补回来)。
  const prevDeviceUnresponsiveRef = useRef(deviceUnresponsive);
  useEffect(() => {
    const was = prevDeviceUnresponsiveRef.current;
    prevDeviceUnresponsiveRef.current = deviceUnresponsive;
    if (!was || deviceUnresponsive) return;
    void loadDirectory({ refreshing: true });
  }, [deviceUnresponsive, loadDirectory]);

  // 缓存优先:内存同步命中立即上屏;miss 再试 AsyncStorage 快照(跨启动);
  // 无论命中与否都发一次静默刷新拿最新。
  useEffect(() => {
    if (!workdir) return undefined;
    let cancelled = false;
    const memoryCached = getCachedListingSync(workdir, relPath);
    if (memoryCached) {
      rawEntriesRef.current = memoryCached;
      setItems(buildFileBrowserGridItems(memoryCached, sortModeRef.current, Date.now()));
    } else {
      void readCachedListing(workdir, relPath).then((persisted) => {
        if (cancelled || !persisted || rawEntriesRef.current.length > 0) return;
        rawEntriesRef.current = persisted;
        setItems(buildFileBrowserGridItems(persisted, sortModeRef.current, Date.now()));
      });
    }
    void loadDirectory();
    return () => {
      cancelled = true;
    };
  }, [loadDirectory, relPath, workdir]);

  const absolutePathOf = useCallback((itemRelPath: string) => {
    if (!workdir) return itemRelPath;
    const sep = workdir.includes('\\') ? '\\' : '/';
    if (!itemRelPath) return workdir;
    const tail = sep === '\\' ? itemRelPath.replace(/\//g, '\\') : itemRelPath;
    return `${workdir}${workdir.endsWith(sep) ? '' : sep}${tail}`;
  }, [workdir]);

  const openDirectory = useCallback((target: string) => {
    router.push({
      pathname: '/files/[sessionId]',
      params: { sessionId, deviceId, deviceName, relPath: target },
    });
  }, [deviceId, deviceName, router, sessionId]);

  const openPreview = useCallback((target: string, line?: number) => {
    router.push({
      pathname: '/files/preview/[sessionId]',
      params: {
        sessionId,
        deviceId,
        deviceName,
        relPath: target,
        sort: sortMode,
        ...(line ? { line: String(line) } : {}),
      },
    });
  }, [deviceId, deviceName, router, sessionId, sortMode]);

  // —— 图片统一走聊天同款 ImageLightbox(目录内全部图片为一个图集)——
  const presignGet = useCallback(async (ossKey: string) => {
    return auth.apiFetch<MobileRemoteMediaPresignResult>('/api/device-link/media/presign-get', {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      method: 'POST',
      body: { key: ossKey },
    });
  }, [auth]);

  const resolveFileMedia = useMemo(
    () => createFileBrowserMediaResolver({ fetchRemoteMedia: maker.fetchRemoteMedia, presignGet }),
    [maker, presignGet],
  );

  const galleryImages = useMemo(
    () => buildFileBrowserGalleryImages(items, absolutePathOf),
    [absolutePathOf, items],
  );

  const openImageLightbox = useCallback((item: FileBrowserGridItem) => {
    const url = remoteFileMediaUrl(absolutePathOf(item.relPath), item.mtimeMs);
    const images = galleryImages.some((image) => image.url === url)
      ? galleryImages
      : buildFileBrowserGalleryImages([item], absolutePathOf);
    if (images.length === 0) return;
    setLightbox({ images, initialUrl: url });
  }, [absolutePathOf, galleryImages]);

  const shareLightboxImage = useCallback(async (
    _media: unknown,
    displayUri: string,
    mimeType?: string,
  ) => {
    try {
      const mime = mimeType ?? imageMimeFromUrl(displayUri) ?? 'image/jpeg';
      const localUri = displayUri.startsWith('file://')
        ? displayUri
        : await downloadRemoteMediaShareTemp(displayUri, mime);
      if (!localUri) throw new Error('failed to obtain local image file');
      const sharing = await import('expo-sharing');
      await sharing.shareAsync(localUri, { mimeType: mime });
    } catch {
      showNotice(t('files.browser.shareFailed'));
    }
  }, [showNotice, t]);

  const openItem = useCallback((item: FileBrowserGridItem) => {
    if (item.kind === 'dir') {
      openDirectory(item.relPath);
      return;
    }
    if (item.thumb === 'image') {
      openImageLightbox(item);
      return;
    }
    openPreview(item.relPath);
  }, [openDirectory, openImageLightbox, openPreview]);


  /** 文件名搜索命中:图片直开 lightbox(单图,无目录上下文),其余进预览。 */
  const openSearchResult = useCallback((match: FileBrowserNameMatch) => {
    if (fileThumbKind(match.name) !== 'image') {
      openPreview(match.relPath);
      return;
    }
    // 搜索结果没有 stat 信息,先列一拍父目录拿真实 mtime——媒体 URL 的
    // v=<mtime> 版本参数依赖它(全版本被控端兼容);拿不到时用当前时间兜底,
    // 宁可多导出一次也不复用同路径被覆写前的旧图。
    void (async () => {
      let mtimeMs = Date.now();
      let sizeBytes = 0;
      try {
        const raw = await withTransientRemoteRetry(async () => {
          await openLink(deviceId);
          return maker.fileBrowser.listDir(workdir, parentRelPath(match.relPath) ?? '');
        });
        const entry = normalizeRemoteOpDirEntries(raw).find((item) => item.relPath === match.relPath);
        if (entry) {
          mtimeMs = entry.mtimeMs;
          sizeBytes = entry.size;
        }
      } catch {
        // 兜底见上:Date.now() 版本参数强制走新鲜导出
      }
      openImageLightbox({
        key: `file:${match.relPath}`,
        name: match.name,
        relPath: match.relPath,
        kind: 'file',
        thumb: 'image',
        metaLabel: '',
        sizeBytes,
        mtimeMs,
      });
    })();
  }, [deviceId, maker, openImageLightbox, openLink, openPreview, workdir]);

  const copyItemPath = useCallback(async (item: FileBrowserGridItem) => {
    await Clipboard.setStringAsync(absolutePathOf(item.relPath));
    setContextItem(null);
    showNotice(t('files.browser.copiedPath'));
  }, [absolutePathOf, showNotice, t]);

  const sendItemToSession = useCallback((item: FileBrowserGridItem) => {
    setContextItem(null);
    // 图片以图片附件形式进 composer(agent 直接收图);其余文件仍以 @路径
    // 引用进草稿(agent 自己读文件,对代码/文档更合适)。
    if (item.kind === 'file' && item.thumb === 'image') {
      const attachment = buildMobileRemoteFileAttachment(absolutePathOf(item.relPath), {
        size: item.sizeBytes,
      });
      if (attachment) {
        queueComposerAttachment(sessionId, attachment);
        router.navigate({
          pathname: '/sessions/[sessionId]',
          params: {
            sessionId,
            deviceId,
            focusComposerRequestKey: String(Date.now()),
          },
        });
        return;
      }
    }
    const merged = mergePathIntoComposerDraft(sessionId, item.relPath, item.kind);
    router.navigate({
      pathname: '/sessions/[sessionId]',
      params: {
        sessionId,
        deviceId,
        draft: merged,
        focusComposerRequestKey: String(Date.now()),
      },
    });
  }, [absolutePathOf, deviceId, router, sessionId]);

  const shareItem = useCallback((item: FileBrowserGridItem) => {
    // 导出/分享 = 系统分享单一步到位(iOS 分享单自带「存储图像」,不再单设保存)。
    setContextItem(null);
    if (item.kind !== 'file') return;
    showNotice(t('files.browser.exporting'));
    void (async () => {
      try {
        let url: string;
        let mime: string;
        if (item.thumb === 'image') {
          // 图片走媒体取件管线(与 lightbox 同源,命中它的解析缓存)。
          const resolved = await resolveFileMedia({
            kind: 'image',
            url: remoteFileMediaUrl(absolutePathOf(item.relPath), item.mtimeMs),
            previewable: false,
          });
          url = resolved.url;
          mime = resolved.mimeType;
        } else {
          // 非图片同样一步到系统分享单(两段式导出,与预览页分享同链路),
          // 不再折跳预览页多一步操作。
          url = await exportRemoteFileToUrl(
            { maker, deviceId, openLink, presignGet, isCancelled: () => unmountedRef.current },
            workdir,
            item.relPath,
            item.mtimeMs,
          );
          mime = shareMimeForFileName(item.name);
        }
        const localUri = await downloadRemoteMediaShareTemp(url, mime, item.name);
        if (!localUri) throw new Error(t('files.browser.downloadFailed'));
        const sharing = await import('expo-sharing');
        await sharing.shareAsync(localUri, { mimeType: mime });
        setNotice(null);
      } catch (err) {
        showNotice(formatRemoteError(err));
      }
    })();
  }, [absolutePathOf, deviceId, maker, openLink, presignGet, resolveFileMedia, showNotice, t, workdir]);

  /** lightbox 底部显式操作(与预览页底栏同构):复制路径 / 发送到会话。 */
  const lightboxActions = useMemo((): readonly ImageLightboxAction[] => [
    {
      key: 'copyPath',
      label: t('files.browser.copyPath'),
      icon: Copy,
      onPress: (image) => {
        const rel = relPathFromGalleryKey(image.key);
        if (rel) void Clipboard.setStringAsync(absolutePathOf(rel));
      },
    },
    {
      key: 'sendToSession',
      label: t('files.browser.sendToSession'),
      icon: MessageSquarePlus,
      onPress: (image) => {
        const rel = relPathFromGalleryKey(image.key);
        if (!rel) return;
        setLightbox(null);
        sendItemToSession({
          key: image.key,
          name: image.title,
          relPath: rel,
          kind: 'file',
          thumb: 'image',
          metaLabel: '',
          sizeBytes: 0,
          mtimeMs: 0,
        });
      },
    },
  ], [absolutePathOf, sendItemToSession, t]);

  /**
   * lightbox 圈点标注(与聊天/托盘同一套画笔):提交只投递「图源 + 矢量笔迹」
   * 进会话信箱并导航回会话页,烧录 / 上传 / annotated 标由会话页的标注管线
   * 统一执行——文件浏览器页没有附件托盘,不在本页做任何重活。
   */
  const lightboxAnnotation = useMemo((): ImageLightboxAnnotationConfig => ({
    submitLabel: t('files.browser.sendToSession'),
    onSubmit: (_image, displayUri, strokes, context) => {
      queueComposerAnnotationSubmission(sessionId, {
        displayUri,
        strokes,
        mimeType: context.mimeType,
      });
      setLightbox(null);
      router.navigate({
        pathname: '/sessions/[sessionId]',
        params: {
          sessionId,
          deviceId,
          focusComposerRequestKey: String(Date.now()),
        },
      });
    },
  }), [deviceId, router, sessionId, t]);

  /** 标题菜单里的当前目录操作(显式入口,不依赖长按)。 */
  const copyCurrentDirPath = useCallback(() => {
    setTitleMenuOpen(false);
    void Clipboard.setStringAsync(absolutePathOf(relPath));
    showNotice(t('files.browser.copiedPath'));
  }, [absolutePathOf, relPath, showNotice, t]);

  const sendCurrentDirToSession = useCallback(() => {
    setTitleMenuOpen(false);
    const merged = mergePathIntoComposerDraft(sessionId, relPath, 'dir');
    router.navigate({
      pathname: '/sessions/[sessionId]',
      params: {
        sessionId,
        deviceId,
        draft: merged,
        focusComposerRequestKey: String(Date.now()),
      },
    });
  }, [deviceId, relPath, router, sessionId]);

  const setViewModePersist = useCallback((view: FileBrowserViewMode) => {
    setViewMode(view);
    setTitleMenuOpen(false);
    if (workdir) saveFileBrowserPrefs(workdir, { view, sort: sortModeRef.current });
  }, [workdir]);

  const setSortModePersist = useCallback((sort: FileBrowserSortMode) => {
    setSortMode(sort);
    setTitleMenuOpen(false);
    if (workdir) saveFileBrowserPrefs(workdir, { view: viewMode, sort });
  }, [viewMode, workdir]);

  // —— 搜索(listAllFiles 全量文件名:模块级按 workdir 缓存 + 本地过滤)——
  // 组件 state 只是过滤用的工作副本,不做长期缓存:新鲜度完全交给模块层
  // (60s TTL + storeCachedListing 时失效),否则首次装载后 fs-watch 刷新
  // 对文件名搜索永远无效——agent 刚建的文件搜不到、已删的还在结果里。
  const ensureAllFiles = useCallback(async (opts?: { silent?: boolean }) => {
    if (!deviceId || !workdir) return;
    if (!opts?.silent) setSearchLoading(true);
    try {
      const files = await withTransientRemoteRetry(async () => {
        await openLink(deviceId);
        return loadAllFilesIndex(maker, workdir, SEARCH_FILES_CAP);
      });
      setAllFiles(files);
    } catch (err) {
      if (!opts?.silent) setError(formatRemoteError(err));
    } finally {
      if (!opts?.silent) setSearchLoading(false);
    }
  }, [deviceId, maker, openLink, workdir]);

  // 打开搜索:无索引时带 loading 拉取;已有索引改静默复核(TTL 命中零网络
  // 开销,规则 7:界面不闪 loading,结果原位更新)。目录刷新(lastSyncedAt
  // 变化,含 fs-watch 驱动)同样静默复核,文件名搜索与网格始终同一份文件树。
  useEffect(() => {
    if (!searchOpen || searchMode !== 'name') return;
    void ensureAllFiles(allFiles ? { silent: true } : undefined);
    // allFiles 不进依赖:它只决定是否出首屏 loading,索引更新本身不应再触发重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureAllFiles, lastSyncedAt, searchMode, searchOpen]);

  const searchMatches = useMemo(
    () => (searchOpen && searchMode === 'name' && allFiles ? filterFileNameMatches(allFiles, query) : []),
    [allFiles, query, searchMode, searchOpen],
  );

  // 内容搜索(被控端 ripgrep searchCollect):450ms 去抖,seq 防乱序回包。
  useEffect(() => {
    // 每次条件变化(关搜索/切模式/清词)都先推进 seq:仍在途的旧请求回来时
    // 过不了 seq 校验,不会把已清空的结果又填回去。seq 推进后在途请求的
    // finally 不会执行(被 seq 门挡住),loading 必须在早退分支同步清掉,
    // 否则「搜索中…」会永远挂着。
    contentSeqRef.current += 1;
    if (!searchOpen || searchMode !== 'content' || !deviceId || !workdir) {
      setSearchLoading(false);
      return undefined;
    }
    const q = query.trim();
    if (q.length < 2) {
      setContentMatches([]);
      setContentSummary(null);
      setSearchLoading(false);
      return undefined;
    }
    const seq = contentSeqRef.current;
    const timer = setTimeout(() => {
      setSearchLoading(true);
      void withTransientRemoteRetry(async () => {
        await openLink(deviceId);
        return maker.fileBrowser.searchCollect(workdir, q, { maxMatches: 200 });
      })
        .then((res) => {
          if (seq !== contentSeqRef.current) return;
          setContentMatches(res.matches ?? []);
          setContentSummary(
            t('files.browser.contentSummary', { matches: res.totalMatches, files: res.totalFiles })
              + (res.truncated ? t('files.browser.contentSummaryTruncated') : ''),
          );
        })
        .catch((err) => {
          if (seq === contentSeqRef.current) setError(formatRemoteError(err));
        })
        .finally(() => {
          if (seq === contentSeqRef.current) setSearchLoading(false);
        });
    }, 450);
    return () => clearTimeout(timer);
  }, [deviceId, maker, openLink, query, searchMode, searchOpen, t, workdir]);

  // fs-watch:聚焦时订阅当前 workdir 的文件树变更,变更去抖后静默刷新;
  // 失焦/退出释放订阅(被控端 watch 引擎由订阅计数驱动启停)。
  const watchReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!deviceId || !workdir) return undefined;
      const owner = `files-watch:${sessionId}:${relPath}`;
      // session topic 一并挂在本屏 owner 下:随聚焦/失焦成对订阅与释放,
      // 不再有终身不释放的全局 owner(topic 按 owner 引用计数,同会话的
      // 上层目录屏 / 会话页各自持有,互不影响)。
      const topics = [fsWatchTopic(workdir), `session:${sessionId}`];
      void subscribe(owner, deviceId, topics).catch(() => undefined);
      const off = onFileBrowserWatchEvent((event) => {
        if (event.workdir !== workdir) return;
        if (watchReloadTimerRef.current) clearTimeout(watchReloadTimerRef.current);
        watchReloadTimerRef.current = setTimeout(() => {
          void loadDirectory();
        }, 600);
      });
      return () => {
        off();
        if (watchReloadTimerRef.current) clearTimeout(watchReloadTimerRef.current);
        void unsubscribe(owner, deviceId, topics).catch(() => undefined);
      };
    }, [deviceId, loadDirectory, relPath, sessionId, subscribe, unsubscribe, workdir]),
  );

  const pathLevels = useMemo(
    () => (workdir ? buildWorkdirPathLevels(workdir, relPath) : []),
    [relPath, workdir],
  );
  const title = pathLevels.find((level) => level.current)?.label ?? t('files.browser.titleFallback');
  const summary = summarizeFileBrowserGrid(items);
  const isRoot = relPath === '';
  const noWorkdir = !!session && !workdir;
  // iPad / 横屏按宽度自适应列数(手机竖屏 3 列,iPad 最多 6 列)。
  const gridColumns = Math.min(6, Math.max(GRID_COLUMNS, Math.floor(screenWidth / 130)));
  const cellWidth = Math.floor((screenWidth - spacing.lg * 2 - spacing.md * (gridColumns - 1)) / gridColumns);

  // 网格 renderItem 用 useCallback 固定身份,配合 GridCell 的 memo + 稳定回调
  // (openItem 已是 useCallback,setContextItem 是 React 保证稳定的 setter):
  // 父级高频 state 变化(notice / 搜索 / 连接态)re-render 时不再全网格重渲
  // (文件夹/文件 SVG glyph 单价高)。
  const renderGridItem = useCallback(({ item }: { item: FileBrowserGridItem }) => (
    <GridCell
      item={item}
      maker={maker}
      onContext={setContextItem}
      onOpen={openItem}
      width={cellWidth}
      workdir={workdir}
    />
  ), [cellWidth, maker, openItem, workdir]);

  return (
    <SafeAreaView style={styles.safeArea} testID="files.screen">
      {searchOpen ? (
        <SearchHeader
          loading={searchLoading}
          mode={searchMode}
          onCancel={() => {
            setSearchOpen(false);
            setQuery('');
            setContentMatches([]);
            setContentSummary(null);
            setSearchLoading(false);
          }}
          onChangeMode={setSearchMode}
          onChangeQuery={setQuery}
          query={query}
          workdirLabel={pathLevels[pathLevels.length - 1]?.label ?? ''}
        />
      ) : (
        <View style={styles.navRow} testID="files.navRow">
          <ScreenBackButton
            hitSlop={8}
            onPress={() => goBackGuarded(router)}
            testID="files.backButton"
          />
          <Pressable
            accessibilityLabel={t('files.browser.a11yTitleMenu')}
            onPress={() => setTitleMenuOpen(true)}
            style={styles.titleGroup}
            testID="files.titleMenuButton"
          >
            <Text numberOfLines={1} style={styles.title} testID="files.title">{title}</Text>
            <View style={styles.titleChevronChip}>
              <ChevronDown color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
            </View>
          </Pressable>
          <Pressable
            accessibilityLabel={t('files.browser.a11ySearch')}
            hitSlop={8}
            onPress={() => setSearchOpen(true)}
            style={({ pressed }) => [styles.navActionBtn, pressed && styles.pressed]}
            testID="files.searchButton"
          >
            <Search color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
          </Pressable>
          <Pressable
            accessibilityLabel={t('files.browser.a11yMore')}
            hitSlop={8}
            onPress={() => setTitleMenuOpen(true)}
            style={({ pressed }) => [styles.navActionBtn, pressed && styles.pressed]}
            testID="files.moreButton"
          >
            <Ellipsis color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
          </Pressable>
        </View>
      )}

      {!searchOpen ? (
        <View style={styles.sectionRow}>
          <Text numberOfLines={1} style={styles.sectionLabel}>
            {deviceName}{isRoot ? t('files.browser.workdirSuffix') : ''}
          </Text>
          {loading && !refreshing ? <ActivityIndicator color={colors.textTertiary} size="small" /> : null}
        </View>
      ) : null}

      {/* 连接正常时不渲染(fs-watch 已保证实时刷新,常驻状态条没有信息量);
          请求失败、可分类连接问题(鉴权/顶号/版本),以及持续超过防闪窗口的
          普通弱网断线,以内联卡片给出提示与重新同步入口(与会话页同款降级形态)。 */}
      {showConnectionBanner ? (
        <ConnectionBanner
          density="compact"
          deviceUnresponsive={deviceUnresponsive}
          error={error}
          issue={connectionIssue}
          lastSyncedAt={lastSyncedAt}
          loading={loading}
          onSync={() => void loadDirectory()}
          status={status}
          variant="inline"
        />
      ) : null}

      {searchOpen && searchMode === 'content' ? (
        <FlatList
          data={contentMatches}
          keyboardShouldPersistTaps="handled"
          keyExtractor={(match, index) => `${match.relPath}:${match.lineNumber}:${index}`}
          ListEmptyComponent={
            <Text style={styles.searchHint} testID="files.contentSearchHint">
              {searchLoading
                ? t('files.browser.searchingContent')
                : query.trim().length >= 2
                  ? t('files.browser.noContentMatch')
                  : t('files.browser.contentSearchMinChars')}
            </Text>
          }
          ListFooterComponent={
            contentMatches.length > 0 && contentSummary ? (
              <Text style={styles.footerText}>{contentSummary}</Text>
            ) : null
          }
          renderItem={({ item }) => (
            <ContentMatchRow
              match={item}
              onPress={() => openPreview(item.relPath, item.lineNumber)}
              query={query}
            />
          )}
          style={styles.list}
        />
      ) : searchOpen ? (
        <FlatList
          data={searchMatches}
          keyboardShouldPersistTaps="handled"
          keyExtractor={(match) => match.relPath}
          ListEmptyComponent={
            <Text style={styles.searchHint} testID="files.searchHint">
              {searchLoading
                ? t('files.browser.indexing')
                : query.trim()
                  ? t('files.browser.noNameMatch')
                  : t('files.browser.nameSearchPrompt')}
            </Text>
          }
          ListFooterComponent={
            searchMatches.length > 0 ? (
              <Text style={styles.footerText}>{t('files.browser.nameResultSummary', { n: searchMatches.length })}</Text>
            ) : null
          }
          renderItem={({ item }) => (
            <SearchResultRow match={item} onPress={() => openSearchResult(item)} />
          )}
          style={styles.list}
        />
      ) : noWorkdir ? (
        <Text style={styles.searchHint} testID="files.noWorkdir">
          {t('files.browser.noWorkdir')}
        </Text>
      ) : viewMode === 'grid' ? (
        <FlatList
          columnWrapperStyle={styles.gridRow}
          contentContainerStyle={styles.gridContent}
          data={items}
          key={`grid-${gridColumns}`}
          keyExtractor={(item) => item.key}
          ListEmptyComponent={!loading ? <Text style={styles.searchHint}>{t('files.browser.folderEmpty')}</Text> : null}
          numColumns={gridColumns}
          refreshControl={
            <RefreshControl
              onRefresh={() => void loadDirectory({ refreshing: true })}
              refreshing={refreshing}
              tintColor={colors.textTertiary}
            />
          }
          renderItem={renderGridItem}
        />
      ) : (
        <FlatList
          contentContainerStyle={styles.listContent}
          data={items}
          ItemSeparatorComponent={ListSeparator}
          key="list"
          keyExtractor={(item) => item.key}
          ListEmptyComponent={!loading ? <Text style={styles.searchHint}>{t('files.browser.folderEmpty')}</Text> : null}
          refreshControl={
            <RefreshControl
              onRefresh={() => void loadDirectory({ refreshing: true })}
              refreshing={refreshing}
              tintColor={colors.textTertiary}
            />
          }
          renderItem={({ item }) => (
            <ListRow
              item={item}
              onLongPress={() => setContextItem(item)}
              onPress={() => openItem(item)}
            />
          )}
        />
      )}

      {!searchOpen ? (
        <View style={styles.footer}>
          <Text style={styles.footerStrong} testID="files.summary">{summary}</Text>
          <Text style={styles.footerText}>
            {notice ?? (status === 'online' ? t('files.browser.footerOnline') : t('files.browser.footerConnecting'))}
          </Text>
        </View>
      ) : null}

      <TitleMenu
        levels={pathLevels}
        onClose={() => setTitleMenuOpen(false)}
        onCopyCurrentPath={copyCurrentDirPath}
        onJump={(target) => {
          setTitleMenuOpen(false);
          if (target !== relPath) openDirectory(target);
        }}
        onSendCurrentToSession={isRoot ? null : sendCurrentDirToSession}
        onSetSort={setSortModePersist}
        onSetView={setViewModePersist}
        open={titleMenuOpen}
        sortMode={sortMode}
        viewMode={viewMode}
      />

      <ContextMenu
        item={contextItem}
        onClose={() => setContextItem(null)}
        onCopyPath={(item) => void copyItemPath(item)}
        onPreview={(item) => {
          setContextItem(null);
          openItem(item);
        }}
        onSend={sendItemToSession}
        onShare={shareItem}
      />

      {lightbox ? (
        <ImageLightbox
          annotation={lightboxAnnotation}
          extraActions={lightboxActions}
          images={lightbox.images}
          initialUrl={lightbox.initialUrl}
          onClose={() => setLightbox(null)}
          onResolveRemoteMedia={resolveFileMedia}
          onShareImage={shareLightboxImage}
          showFileHeader
        />
      ) : null}
    </SafeAreaView>
  );
}

/* ------------------------------ 子组件 ------------------------------ */

/** 网格单元:memo + 回调收 item 参(见 renderGridItem 注释),父级 re-render 时按 props 短路。 */
const GridCell = memo(function GridCell({
  item,
  maker,
  onContext,
  onOpen,
  width,
  workdir,
}: {
  item: FileBrowserGridItem;
  maker: Pick<MobileMakerTransport, 'fileBrowser'>;
  onContext(item: FileBrowserGridItem): void;
  onOpen(item: FileBrowserGridItem): void;
  width: number;
  workdir: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityLabel={t(item.kind === 'dir' ? 'files.browser.a11yOpenFolder' : 'files.browser.a11yPreviewFile', { name: item.name })}
      onLongPress={() => onContext(item)}
      onPress={() => onOpen(item)}
      style={({ pressed }) => [styles.gridCell, { width }, pressed && styles.pressed]}
      testID={`files.cell.${sanitizeTestId(item.name)}`}
    >
      <View style={styles.thumbZone}>
        <FileThumb item={item} maker={maker} workdir={workdir} />
      </View>
      <Text numberOfLines={2} style={styles.cellName}>{item.name}</Text>
      <Text numberOfLines={1} style={styles.cellMeta}>{item.metaLabel}</Text>
    </Pressable>
  );
});

/** 缩略图分派:folder 描边 glyph / image 远程缩略图 / doc 迷你文档页 / generic 类型占位。 */
function FileThumb({
  item,
  maker,
  workdir,
}: {
  item: FileBrowserGridItem;
  maker: Pick<MobileMakerTransport, 'fileBrowser'>;
  workdir: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const thumbUri = useFileThumbnail(maker, workdir, item.relPath, item.mtimeMs, item.thumb === 'image');

  if (item.thumb === 'folder') {
    return <Folder color={colors.borderStrong} fill={colors.surfaceChip} size={iconSize.glyph} strokeWidth={iconStroke.thin} absoluteStrokeWidth />;
  }
  if (item.thumb === 'image' && thumbUri) {
    return <Image resizeMode="cover" source={{ uri: thumbUri }} style={styles.imageThumb} />;
  }
  if (item.thumb === 'doc') {
    return <RealDocThumb item={item} maker={maker} workdir={workdir} />;
  }
  if (item.thumb === 'image') {
    // 缩略图未就绪/失败(如老版本被控端)回退迷你文档页(静默,不出 loading 态)。
    return <DocThumbCard headed={false} seed={item.name} />;
  }
  return <GenericThumbCard name={item.name} />;
}

/** 真实内容迷你页:小文件拉首块渲成微缩文本(缓存见 fileBrowserCache);
 *  过大/失败/加载中回退抽象线条,不出 loading 态。 */
function RealDocThumb({
  item,
  maker,
  workdir,
}: {
  item: FileBrowserGridItem;
  maker: Pick<MobileMakerTransport, 'fileBrowser'>;
  workdir: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const snippet = useDocSnippet(maker, workdir, item.relPath, item.mtimeMs, item.sizeBytes, true);
  if (!snippet) {
    return <DocThumbCard headed={/\.(md|mdx)$/i.test(item.name)} seed={item.name} />;
  }
  return (
    <View style={styles.docThumb}>
      <Text
        allowFontScaling={false}
        numberOfLines={14}
        style={styles.docSnippetText}
      >
        {snippet}
      </Text>
    </View>
  );
}

/** 迷你文档页:抽象线条模拟首屏内容(v1 不拉取真实文本,零流量)。 */
function DocThumbCard({ headed, seed }: { headed: boolean; seed: string }) {
  const styles = useThemedStyles(makeStyles);
  const hash = hashString(seed);
  const widths = [0.86, 0.78, 0.7, 0.82, 0.62, 0.74].map(
    (base, i) => Math.max(0.35, base - (((hash >> (i * 3)) & 7) / 40)),
  );
  return (
    <View style={styles.docThumb}>
      {headed ? <View style={styles.docHeadingBar} /> : null}
      {widths.map((w, i) => (
        <View key={i} style={[styles.docLine, { width: `${Math.round(w * 100)}%` }]} />
      ))}
    </View>
  );
}

function GenericThumbCard({ name }: { name: string }) {
  const { colors } = useTheme();
  const Icon = /\.(db|sqlite3?|realm)$/i.test(name) ? Database : FileIcon;
  return <Icon color={colors.borderStrong} size={iconSize.glyph} strokeWidth={iconStroke.thin} absoluteStrokeWidth />;
}

function ListSeparator() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.listSepWrap}>
      <View style={styles.listSep} />
    </View>
  );
}

function ListRow({
  item,
  onLongPress,
  onPress,
}: {
  item: FileBrowserGridItem;
  onLongPress(): void;
  onPress(): void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const Icon = listIconFor(item);
  return (
    <Pressable
      accessibilityLabel={t(item.kind === 'dir' ? 'files.browser.a11yOpenFolder' : 'files.browser.a11yPreviewFile', { name: item.name })}
      onLongPress={onLongPress}
      onPress={onPress}
      style={({ pressed }) => [styles.listRow, pressed && styles.pressed]}
      testID={`files.row.${sanitizeTestId(item.name)}`}
    >
      <View style={styles.listIconWrap}>
        <Icon color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
      </View>
      <View style={styles.listTextCol}>
        <Text numberOfLines={1} style={styles.listName}>{item.name}</Text>
        <Text numberOfLines={1} style={styles.cellMeta}>{item.metaLabel}</Text>
      </View>
      {item.kind === 'dir' ? (
        <ChevronRight color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
      ) : null}
    </Pressable>
  );
}

function SearchHeader({
  loading,
  mode,
  onCancel,
  onChangeMode,
  onChangeQuery,
  query,
  workdirLabel,
}: {
  loading: boolean;
  mode: 'name' | 'content';
  onCancel(): void;
  onChangeMode(next: 'name' | 'content'): void;
  onChangeQuery(next: string): void;
  query: string;
  workdirLabel: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const modes = [
    ['name', t('files.browser.searchModeName')],
    ['content', t('files.browser.searchModeContent')],
  ] as const;
  return (
    <View>
      <View style={styles.searchRow}>
        <View style={styles.searchField}>
          <Search color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onChangeText={onChangeQuery}
            placeholder={t('files.browser.searchPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            style={styles.searchInput}
            testID="files.searchInput"
            value={query}
          />
          {query ? (
            <Pressable accessibilityLabel={t('files.browser.a11yClear')} hitSlop={8} onPress={() => onChangeQuery('')}>
              <X color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
            </Pressable>
          ) : null}
        </View>
        <Pressable accessibilityLabel={t('files.browser.a11yCancelSearch')} hitSlop={8} onPress={onCancel} testID="files.searchCancel">
          <Text style={styles.cancelText}>{t('files.browser.cancel')}</Text>
        </Pressable>
      </View>
      <View style={styles.searchModeRow}>
        {modes.map(([value, label]) => (
          <Pressable
            accessibilityLabel={t('files.browser.searchModeA11y', { mode: label })}
            key={value}
            onPress={() => onChangeMode(value)}
            style={[styles.searchModePill, mode === value && styles.searchModePillActive]}
            testID={`files.searchMode.${value}`}
          >
            <Text style={[styles.searchModeLabel, mode === value && styles.searchModeLabelActive]}>
              {label}
            </Text>
          </Pressable>
        ))}
        <Text style={styles.scopeHintInline}>
          {t('files.browser.searchScope', { workdir: workdirLabel })}{loading ? t('files.browser.searching') : ''}
        </Text>
      </View>
    </View>
  );
}

/** 内容搜索结果行:文件名:行号 + 命中行文本(关键字加粗)+ 所在目录。 */
function ContentMatchRow({
  match,
  onPress,
  query,
}: {
  match: FileBrowserSearchMatch;
  onPress(): void;
  query: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const name = match.relPath.split('/').filter(Boolean).pop() ?? match.relPath;
  const dirPath = match.relPath.slice(0, Math.max(0, match.relPath.length - name.length - 1));
  const line = match.lineText.trim();
  const hit = highlightSpan(line, query);
  return (
    <Pressable
      accessibilityLabel={t('files.browser.a11yPreviewNameLine', { name, line: match.lineNumber })}
      onPress={onPress}
      style={({ pressed }) => [styles.contentMatchRow, pressed && styles.pressed]}
      testID={`files.contentResult.${sanitizeTestId(name)}`}
    >
      <View style={styles.listIconWrap}>
        <FileText color={colors.textSecondary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
      </View>
      <View style={styles.listTextCol}>
        <Text numberOfLines={1} style={styles.listName}>
          {name}
          <Text style={styles.contentMatchLineNo}> :{match.lineNumber}</Text>
        </Text>
        <Text numberOfLines={1} style={styles.contentMatchLineText}>
          {hit ? (
            <>
              {hit.before}
              <Text style={styles.contentMatchHit}>{hit.matched}</Text>
              {hit.after}
            </>
          ) : line}
        </Text>
        <Text numberOfLines={1} style={styles.cellMeta}>{dirPath || t('files.browser.rootDir')}</Text>
      </View>
    </Pressable>
  );
}

/** 命中行内关键字定位(大小写不敏感首个命中;超长行把命中段挪进可视窗口)。 */
function highlightSpan(line: string, query: string): { before: string; matched: string; after: string } | null {
  const q = query.trim();
  if (!q) return null;
  const index = line.toLowerCase().indexOf(q.toLowerCase());
  if (index < 0) return null;
  // 命中太靠后时截掉前缀,保证命中段出现在单行可视范围内。
  const start = index > 28 ? index - 20 : 0;
  return {
    before: (start > 0 ? '…' : '') + line.slice(start, index),
    matched: line.slice(index, index + q.length),
    after: line.slice(index + q.length),
  };
}

function SearchResultRow({ match, onPress }: { match: FileBrowserNameMatch; onPress(): void }) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityLabel={t('files.browser.a11yPreviewName', { name: match.name })}
      onPress={onPress}
      style={({ pressed }) => [styles.resultRow, pressed && styles.pressed]}
      testID={`files.result.${sanitizeTestId(match.name)}`}
    >
      <View style={styles.miniThumb}>
        {[0.8, 0.9, 0.7, 0.85].map((w, i) => (
          <View key={i} style={[styles.miniThumbLine, { width: `${Math.round(w * 100)}%` }]} />
        ))}
      </View>
      <View style={styles.listTextCol}>
        <Text numberOfLines={1} style={styles.listName}>{match.name}</Text>
        <Text numberOfLines={1} style={styles.cellMeta}>{match.dirRelPath || t('files.browser.rootDir')}</Text>
      </View>
    </Pressable>
  );
}

function TitleMenu({
  levels,
  onClose,
  onCopyCurrentPath,
  onJump,
  onSendCurrentToSession,
  onSetSort,
  onSetView,
  open,
  sortMode,
  viewMode,
}: {
  levels: Array<{ label: string; relPath: string; current: boolean }>;
  onClose(): void;
  onCopyCurrentPath(): void;
  onJump(relPath: string): void;
  onSendCurrentToSession: (() => void) | null;
  onSetSort(sort: FileBrowserSortMode): void;
  onSetView(view: FileBrowserViewMode): void;
  open: boolean;
  sortMode: FileBrowserSortMode;
  viewMode: FileBrowserViewMode;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();

  const row = (
    key: string,
    label: string,
    checked: boolean,
    onPress: () => void,
    trailing?: React.ReactNode,
    dim?: boolean,
  ) => (
    <Pressable
      accessibilityLabel={label}
      key={key}
      onPress={onPress}
      style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
      testID={`files.menu.${sanitizeTestId(key)}`}
    >
      <View style={styles.menuCheckSlot}>
        {checked ? <Check color={colors.textPrimary} size={iconSize.sm} strokeWidth={iconStroke.medium} /> : null}
      </View>
      <Text numberOfLines={1} style={[styles.menuLabel, dim && styles.menuLabelDim]}>{label}</Text>
      {trailing}
    </Pressable>
  );

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={open}>
      <Pressable onPress={onClose} style={styles.overlay} testID="files.titleMenuOverlay">
        <Pressable onPress={() => undefined} style={styles.titleMenuCard}>
          {levels.map((level, index) => (
            <View key={`level:${level.relPath}`}>
              {index > 0 ? <View style={styles.menuSep} /> : null}
              {row(
                `level.${level.label}`,
                level.label,
                level.current,
                () => onJump(level.relPath),
                <Folder color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />,
                !level.current,
              )}
            </View>
          ))}
          <View style={styles.menuGroupSep} />
          {row('view.grid', t('files.browser.viewGrid'), viewMode === 'grid', () => onSetView('grid'),
            <LayoutGrid color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />)}
          <View style={styles.menuSep} />
          {row('view.list', t('files.browser.viewList'), viewMode === 'list', () => onSetView('list'),
            <ListIcon color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />)}
          <View style={styles.menuGroupSep} />
          {row('sort.name', t('files.browser.sortName'), sortMode === 'name', () => onSetSort('name'),
            <ArrowDownAZ color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />)}
          <View style={styles.menuSep} />
          {row('sort.mtime', t('files.browser.sortMtime'), sortMode === 'mtime', () => onSetSort('mtime'),
            <History color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />)}
          <View style={styles.menuSep} />
          {row('sort.size', t('files.browser.sortSize'), sortMode === 'size', () => onSetSort('size'),
            <ArrowDownWideNarrow color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />)}
          <View style={styles.menuGroupSep} />
          {onSendCurrentToSession
            ? row('folder.send', t('files.browser.sendToSession'), false, onSendCurrentToSession,
              <MessageSquarePlus color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />)
            : null}
          {onSendCurrentToSession ? <View style={styles.menuSep} /> : null}
          {row('folder.copy', t('files.browser.copyPath'), false, onCopyCurrentPath,
            <Copy color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />)}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ContextMenu({
  item,
  onClose,
  onCopyPath,
  onPreview,
  onSend,
  onShare,
}: {
  item: FileBrowserGridItem | null;
  onClose(): void;
  onCopyPath(item: FileBrowserGridItem): void;
  onPreview(item: FileBrowserGridItem): void;
  onSend(item: FileBrowserGridItem): void;
  onShare(item: FileBrowserGridItem): void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  if (!item) return null;
  const isFile = item.kind === 'file';

  const actions = [
    ...(isFile ? [{ key: 'preview', label: t('files.browser.preview'), Icon: Eye, onPress: () => onPreview(item) }] : []),
    { key: 'send', label: t('files.browser.sendToSession'), Icon: MessageSquarePlus, onPress: () => onSend(item) },
    { key: 'copy', label: t('files.browser.copyPath'), Icon: Copy, onPress: () => onCopyPath(item) },
    ...(isFile ? [{ key: 'share', label: t('files.browser.exportShare'), Icon: ShareIcon, onPress: () => onShare(item) }] : []),
  ];

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      <Pressable onPress={onClose} style={styles.overlayCenter} testID="files.contextMenuOverlay">
        <View style={styles.liftedCard}>
          <View style={styles.liftedThumbZone}>
            {item.kind === 'dir' ? (
              <Folder color={colors.borderStrong} fill={colors.surfaceChip} size={iconSize.glyph} strokeWidth={iconStroke.thin} absoluteStrokeWidth />
            ) : (
              <DocThumbCard headed={/\.(md|mdx)$/i.test(item.name)} seed={item.name} />
            )}
          </View>
          <Text numberOfLines={1} style={styles.listName}>{item.name}</Text>
          <Text numberOfLines={1} style={styles.cellMeta}>{item.metaLabel}</Text>
        </View>
        <View style={styles.contextMenuCard}>
          {actions.map((action, index) => (
            <View key={action.key}>
              {index > 0 ? <View style={styles.menuSep} /> : null}
              <Pressable
                accessibilityLabel={action.label}
                onPress={action.onPress}
                style={({ pressed }) => [styles.contextMenuRow, pressed && styles.pressed]}
                testID={`files.context.${action.key}`}
              >
                <Text style={styles.menuLabel}>{action.label}</Text>
                <action.Icon color={colors.textSecondary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
              </Pressable>
            </View>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

/* ------------------------------ 工具 ------------------------------ */

function listIconFor(item: FileBrowserGridItem) {
  if (item.kind === 'dir') return Folder;
  if (item.thumb === 'image') return ImageIcon;
  if (/\.(json|ya?ml|ts|tsx|js|jsx|py|rs|go|java|kt|swift|c|h|cpp|cs|sh|lua)$/i.test(item.name)) return FileCode;
  if (item.thumb === 'doc') return FileText;
  if (/\.(db|sqlite3?|realm)$/i.test(item.name)) return Database;
  return FileIcon;
}

function hashString(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  return hash;
}

function sanitizeTestId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/** gallery key(`file:<relPath>`)→ relPath;非文件 key 返回 null。 */
function relPathFromGalleryKey(key: string): string | null {
  return key.startsWith('file:') ? key.slice('file:'.length) : null;
}

function readRouteString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  return null;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.surface },
  pressed: { opacity: 0.72 },
  navRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  navActionBtn: {
    // 与会话头 SessionHeaderIconButton 同规格(34×34 pill),hitSlop 补足 44 热区。
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  titleGroup: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: spacing.xs + 2,
    // 标题居左贴返回箭头(与页面式头的左对齐语义一致),不再居中。
    justifyContent: 'flex-start',
    minWidth: 0,
  },
  title: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.semibold,
    maxWidth: '72%',
  },
  titleChevronChip: {
    alignItems: 'center',
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    height: 20,
    justifyContent: 'center',
    width: 20,
  },
  sectionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  sectionLabel: {
    color: colors.textTertiary,
    flex: 1,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
  },
  list: { flex: 1 },
  gridContent: { paddingBottom: spacing.xl, paddingHorizontal: spacing.lg },
  gridRow: { gap: spacing.md, marginBottom: spacing.lg },
  gridCell: { alignItems: 'center', gap: spacing.xs + 2 },
  thumbZone: { alignItems: 'center', height: 112, justifyContent: 'center', width: '100%' },
  docThumb: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: 2, // 文档缩略卡刻意 2px 锐角(iOS Files 风格,ALLOWLIST 登记豁免)
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
    height: 104,
    paddingHorizontal: 8,
    paddingVertical: 10,
    width: 80,
  },
  docHeadingBar: { backgroundColor: colors.borderStrong, height: 4, width: '54%' },
  docLine: { backgroundColor: colors.border, height: 2 },
  // 微缩真实文本:模拟 iOS Files 的文档首屏缩略;禁用系统字号缩放。
  docSnippetText: {
    color: colors.textSecondary,
    fontFamily: monoFont,
    fontSize: docThumbSnippetType.fontSize,
    lineHeight: docThumbSnippetType.lineHeight,
  },
  imageThumb: {
    borderColor: colors.border,
    borderRadius: 2, // 图片缩略同文档卡的刻意 2px 锐角(iOS Files 风格,ALLOWLIST 登记豁免)
    borderWidth: StyleSheet.hairlineWidth,
    height: 104,
    width: '92%',
  },
  cellName: {
    color: colors.textPrimary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.medium,
    textAlign: 'center',
  },
  cellMeta: {
    color: colors.textTertiary,
    fontSize: typeScale.micro,
    lineHeight: lineHeight.micro,
    textAlign: 'center',
  },
  listContent: { paddingBottom: spacing.xl, paddingHorizontal: spacing.lg },
  listRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.md, minHeight: 54 },
  listIconWrap: { alignItems: 'center', justifyContent: 'center', width: 30 },
  listTextCol: { flex: 1, gap: 2, minWidth: 0 },
  listName: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body },
  listSepWrap: { paddingLeft: 30 + spacing.md },
  listSep: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth },
  footer: {
    alignItems: 'center',
    gap: 2,
    paddingBottom: spacing.xs,
    paddingTop: spacing.sm,
  },
  footerStrong: { color: colors.textPrimary, fontSize: typeScale.footnote, fontWeight: fontWeight.semibold },
  footerText: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    paddingVertical: spacing.sm,
    textAlign: 'center',
  },
  searchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  searchField: {
    alignItems: 'center',
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.container,
    flex: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 36,
    paddingHorizontal: spacing.md,
  },
  searchInput: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.code,
    paddingVertical: spacing.sm,
  },
  cancelText: { color: colors.textPrimary, fontSize: typeScale.body },
  scopeHint: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  searchModeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  searchModePill: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 28,
    paddingHorizontal: spacing.md,
  },
  searchModePillActive: { backgroundColor: colors.surfaceChip, borderColor: colors.borderStrong },
  searchModeLabel: { color: colors.textSecondary, fontSize: typeScale.caption },
  searchModeLabelActive: { color: colors.textPrimary, fontWeight: fontWeight.medium },
  scopeHintInline: {
    color: colors.textTertiary,
    flex: 1,
    fontSize: typeScale.caption,
    textAlign: 'right',
  },
  contentMatchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 64,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  contentMatchLineNo: { color: colors.textTertiary, fontSize: typeScale.footnote },
  contentMatchLineText: {
    color: colors.textSecondary,
    fontFamily: monoFont,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  contentMatchHit: { color: colors.textPrimary, fontWeight: fontWeight.semibold },
  searchHint: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.code,
    padding: spacing.lg,
    textAlign: 'center',
  },
  resultRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
  },
  miniThumb: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: 2, // 搜索结果迷你缩略卡同款刻意 2px 锐角(iOS Files 风格,ALLOWLIST 登记豁免)
    borderWidth: StyleSheet.hairlineWidth,
    gap: 3,
    height: 36,
    paddingHorizontal: 4,
    paddingVertical: 5,
    width: 28,
  },
  miniThumbLine: { backgroundColor: colors.border, height: 1.5 },
  overlay: { backgroundColor: colors.overlay, flex: 1 },
  overlayCenter: {
    alignItems: 'center',
    backgroundColor: colors.overlay,
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
  },
  titleMenuCard: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    marginHorizontal: spacing.xxl * 2 + spacing.sm,
    marginTop: 96,
    overflow: 'hidden',
  },
  menuRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  menuCheckSlot: { alignItems: 'center', justifyContent: 'center', width: 16 },
  menuLabel: { color: colors.textPrimary, flex: 1, fontSize: typeScale.body, fontWeight: fontWeight.medium },
  menuLabelDim: { color: colors.textSecondary },
  menuSep: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth },
  menuGroupSep: { backgroundColor: colors.surfaceChip, height: 6 },
  liftedCard: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    width: 180,
  },
  liftedThumbZone: { alignItems: 'center', height: 112, justifyContent: 'center' },
  contextMenuCard: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    width: 230,
  },
  contextMenuRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
    minHeight: 46,
    paddingHorizontal: spacing.md,
  },
});
