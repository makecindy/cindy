import { forwardRef, useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { File, Paths } from 'expo-file-system';
import * as Clipboard from 'expo-clipboard';
import {
  normalizeComposerDocument,
  parseStoredComposerDocument,
  type ComposerDocument,
  type ComposerNode,
  type ResolvedSessionLinkSemantic,
} from '@/session/composerDocument';
import { composerNodesForBoundedPlainTextPaste } from '@/session/composerPaste';
import { buildComposerRichInputHtml, type ComposerRichInputTheme } from '@/session/composerRichInputHtml';
import { COMPOSER_SINGLE_LINE_HEIGHT } from '@/session/composerTextMetrics';
import {
  parseComposerWebMessage,
  type ComposerWebMessage,
} from '@/session/composerRichInputProtocol';
import { COMPOSER_PASTED_IMAGE_FILE_PREFIX } from '@/session/pastedImageAttachment';

export interface ComposerRichInputHandle {
  applyDocumentAndSetSelectionToEnd(document: ComposerDocument): void;
  blur(): void;
  focus(): void;
  insertNode(node: ComposerNode): void;
}

export interface ComposerRichInputProps {
  accessibilityHint?: string;
  accessibilityLabel: string;
  document: ComposerDocument;
  editable?: boolean;
  height: number;
  hidden?: boolean;
  maxHeight: number;
  onBlur?: () => void;
  onChangeDocument(document: ComposerDocument): void;
  onFocus?: () => void;
  onHeightChange?: (height: number) => void;
  onPasteImages?: (uris: string[]) => void;
  onPasteImagesLoadFailed?: () => void;
  onPasteImagesLoading?: (count: number) => void;
  placeholder: string;
  resolveSessionLinkLabel?: (href: string) => Promise<ResolvedSessionLinkSemantic | null>;
  testID?: string;
  theme: ComposerRichInputTheme;
}

interface PendingImagePaste {
  expectedCount: number;
  settledIndexes: Set<number>;
  urisByIndex: Map<number, string>;
}

/** Editable WebView wrapper; the native side only accepts the semantic protocol above. */
export const ComposerRichInput = forwardRef<ComposerRichInputHandle, ComposerRichInputProps>(
  function ComposerRichInput({
    accessibilityHint,
    accessibilityLabel,
    document,
    editable = true,
    height,
    hidden = false,
    maxHeight,
    onBlur,
    onChangeDocument,
    onFocus,
    onHeightChange,
    onPasteImages,
    onPasteImagesLoadFailed,
    onPasteImagesLoading,
    placeholder,
    resolveSessionLinkLabel,
    testID,
    theme,
  }, forwardedRef) {
    const webViewRef = useRef<WebView | null>(null);
    const readyRef = useRef(false);
    const webSignatureRef = useRef('');
    const pendingDocumentRef = useRef<{
      document: ComposerDocument;
      focusAfter: boolean;
    } | null>(null);
    const pendingFocusRef = useRef(false);
    const pendingNodeInsertionsRef = useRef<ComposerNode[]>([]);
    const pendingImagePastesRef = useRef(new Map<string, PendingImagePaste>());
    const pendingImagePasteOrderRef = useRef<string[]>([]);
    const pastedImageFileSequenceRef = useRef(0);
    /** 尚未交接给附件上传 hook 的 WebView 粘贴缓存文件。 */
    const pendingPastedImageFilesRef = useRef(new Set<string>());
    const disposedRef = useRef(false);
    const initialConfigRef = useRef({
      accessibilityLabel,
      document,
      editable,
      maxHeight,
      placeholder,
      theme,
    });
    const html = useMemo(
      () => buildComposerRichInputHtml(initialConfigRef.current),
      [],
    );
    const runtimeConfig = useMemo(() => ({
      accessibilityLabel,
      editable,
      maxHeight,
      placeholder,
      theme,
    }), [
      accessibilityLabel,
      editable,
      maxHeight,
      placeholder,
      theme.background,
      theme.border,
      theme.chip,
      theme.focus,
      theme.placeholder,
      theme.text,
      theme.textSecondary,
    ]);

    const inject = useCallback((script: string) => {
      webViewRef.current?.injectJavaScript(`try { ${script} } catch (_) {} true;`);
    }, []);
    const focusEditor = useCallback(() => {
      if (!readyRef.current) {
        pendingFocusRef.current = true;
        return;
      }
      inject('window.cindyComposer.focus();');
    }, [inject]);
    const applyDocument = useCallback((value: ComposerDocument, focusAfter = false) => {
      if (!readyRef.current) {
        pendingDocumentRef.current = { document: value, focusAfter };
        return;
      }
      inject(`window.cindyComposer.applyDocument(${JSON.stringify(value)}, ${focusAfter});`);
    }, [inject]);

    useEffect(() => {
      const signature = JSON.stringify(document);
      if (signature === webSignatureRef.current) return;
      webSignatureRef.current = signature;
      applyDocument(document);
    }, [applyDocument, document]);
    useEffect(() => {
      inject(`window.cindyComposer.setConfig(${JSON.stringify(runtimeConfig)});`);
    }, [inject, runtimeConfig]);

    useEffect(() => {
      if (!forwardedRef) return undefined;
      const handle: ComposerRichInputHandle = {
        applyDocumentAndSetSelectionToEnd: (value) => {
          webSignatureRef.current = JSON.stringify(value);
          applyDocument(value, true);
        },
        blur: () => {
          pendingFocusRef.current = false;
          if (pendingDocumentRef.current?.focusAfter) {
            pendingDocumentRef.current = {
              ...pendingDocumentRef.current,
              focusAfter: false,
            };
          }
          if (readyRef.current) inject('window.cindyComposer.blur();');
        },
        focus: focusEditor,
        insertNode: (node) => {
          if (!readyRef.current) {
            pendingNodeInsertionsRef.current.push(node);
            return;
          }
          inject(`window.cindyComposer.insertNode(${JSON.stringify(node)});`);
        },
        // 注意:曾有过 setSelectionToEnd: focusEditor 的别名——web 侧 placeCaretAtEnd
        // 必须 root.focus(),而 keyboardDisplayRequiresUserAction={false} 让任何程序化
        // focus 都会弹软键盘。「只挪选区不聚焦」在这个 WebView 编辑器上不成立,需要
        // caret 在末尾的调用方请显式用 focus / applyDocumentAndSetSelectionToEnd,
        // 并自行承担弹键盘的语义。
      };
      if (typeof forwardedRef === 'function') forwardedRef(handle);
      else forwardedRef.current = handle;
      return () => {
        if (typeof forwardedRef === 'function') forwardedRef(null);
        else forwardedRef.current = null;
      };
    }, [applyDocument, focusEditor, forwardedRef, inject]);

    const persistPastedImage = useCallback(async (
      message: Extract<ComposerWebMessage, { type: 'paste-image' }>,
    ): Promise<string> => {
      if (!message.base64) throw new Error('empty pasted image');
      const extension = extensionForMime(message.mimeType);
      const sequence = ++pastedImageFileSequenceRef.current;
      const file = new File(
        Paths.cache,
        `${COMPOSER_PASTED_IMAGE_FILE_PREFIX}${Date.now()}-${sequence}.${extension}`,
      );
      const FileSystem = await import('expo-file-system/legacy');
      pendingPastedImageFilesRef.current.add(file.uri);
      try {
        await FileSystem.writeAsStringAsync(file.uri, message.base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        if (disposedRef.current) {
          throw new Error('composer disposed during pasted image write');
        }
        return file.uri;
      } catch (error) {
        await FileSystem.deleteAsync(file.uri, { idempotent: true }).catch(() => undefined);
        pendingPastedImageFilesRef.current.delete(file.uri);
        throw error;
      }
    }, []);

    const drainCompletedImagePastes = useCallback(() => {
      while (pendingImagePasteOrderRef.current.length > 0) {
        const requestId = pendingImagePasteOrderRef.current[0];
        const batch = pendingImagePastesRef.current.get(requestId);
        if (!batch || batch.settledIndexes.size < batch.expectedCount) return;
        pendingImagePasteOrderRef.current.shift();
        pendingImagePastesRef.current.delete(requestId);
        const uris = [...batch.urisByIndex.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, uri]) => uri);
        if (uris.length > 0 && onPasteImages) {
          // 所有权在调用前转交上传 hook；后续成功 / 失败 / 取消由其负责清理。
          for (const uri of uris) pendingPastedImageFilesRef.current.delete(uri);
          onPasteImages(uris);
        } else {
          if (uris.length > 0) {
            for (const uri of uris) pendingPastedImageFilesRef.current.delete(uri);
            void deleteComposerPastedImageUris(uris);
          }
          onPasteImagesLoadFailed?.();
        }
      }
    }, [onPasteImages, onPasteImagesLoadFailed]);

    useEffect(() => {
      disposedRef.current = false;
      return () => {
        disposedRef.current = true;
        const pendingUris = [...pendingPastedImageFilesRef.current];
        pendingPastedImageFilesRef.current.clear();
        if (pendingUris.length > 0) void deleteComposerPastedImageUris(pendingUris);
      };
    }, []);

    const settlePastedImage = useCallback((
      requestId: string,
      index: number,
      uri?: string,
    ) => {
      const batch = pendingImagePastesRef.current.get(requestId);
      if (!batch || index < 0 || index >= batch.expectedCount || batch.settledIndexes.has(index)) return;
      batch.settledIndexes.add(index);
      if (uri) batch.urisByIndex.set(index, uri);
      drainCompletedImagePastes();
    }, [drainCompletedImagePastes]);

    const commitPlainTextPaste = useCallback(async (
      message: Extract<ComposerWebMessage, { type: 'paste-text-request' }>,
    ) => {
      let text = message.text ?? '';
      if (!text) {
        try {
          text = await Clipboard.getStringAsync();
        } catch {
          text = '';
        }
      }
      const nodes = composerNodesForBoundedPlainTextPaste(text);
      if (!nodes) {
        inject(
          `window.cindyComposer.commitPaste(${JSON.stringify(message.requestId)}, []);`,
        );
        return;
      }
      inject(
        `window.cindyComposer.commitPaste(${JSON.stringify(message.requestId)}, ${JSON.stringify(nodes)});`,
      );
      if (!resolveSessionLinkLabel) return;
      const hrefs = new Set(nodes.flatMap((node) => (
        node.type === 'session-link' && node.titled !== true ? [node.href] : []
      )));
      hrefs.forEach((href) => {
        void resolveSessionLinkLabel(href)
          .then((semantic) => {
            if (!semantic) return;
            inject(
              `window.cindyComposer.resolveSessionLink(${JSON.stringify(href)}, ${JSON.stringify(semantic)});`,
            );
          })
          .catch(() => {
            // Keep the stable short-id placeholder when the target is unavailable.
          });
      });
    }, [inject, resolveSessionLinkLabel]);

    const handleMessage = useCallback((event: WebViewMessageEvent) => {
      const message = parseComposerWebMessage(event.nativeEvent.data);
      if (!message) return;
      if (message.type === 'ready') {
        readyRef.current = true;
        inject(`window.cindyComposer.setConfig(${JSON.stringify(runtimeConfig)});`);
        const pending = pendingDocumentRef.current;
        pendingDocumentRef.current = null;
        if (pending) applyDocument(pending.document, pending.focusAfter);
        const pendingNodeInsertions = pendingNodeInsertionsRef.current;
        pendingNodeInsertionsRef.current = [];
        for (const node of pendingNodeInsertions) {
          inject(`window.cindyComposer.insertNode(${JSON.stringify(node)});`);
        }
        if (pendingFocusRef.current) {
          pendingFocusRef.current = false;
          focusEditor();
        }
        return;
      }
      if (message.type === 'change') {
        const next = parseStoredComposerDocument(message.document);
        if (!next) return;
        const normalized = normalizeComposerDocument(next);
        webSignatureRef.current = JSON.stringify(normalized);
        onChangeDocument(normalized);
        return;
      }
      if (message.type === 'height') {
        if (Number.isFinite(message.height)) {
          onHeightChange?.(Math.max(COMPOSER_SINGLE_LINE_HEIGHT, Math.min(maxHeight, message.height)));
        }
        return;
      }
      if (message.type === 'focus') return onFocus?.();
      if (message.type === 'blur') return onBlur?.();
      if (message.type === 'paste-text-request') {
        void commitPlainTextPaste(message);
        return;
      }
      if (message.type === 'paste-images-start') {
        pendingImagePastesRef.current.set(message.requestId, {
          expectedCount: message.count,
          settledIndexes: new Set(),
          urisByIndex: new Map(),
        });
        pendingImagePasteOrderRef.current.push(message.requestId);
        onPasteImagesLoading?.(Math.max(0, message.count));
        return;
      }
      if (message.type === 'paste-image-failed') {
        settlePastedImage(message.requestId, message.index);
        return;
      }
      if (message.type === 'paste-image') {
        void persistPastedImage(message)
          .then((uri) => settlePastedImage(message.requestId, message.index, uri))
          .catch(() => settlePastedImage(message.requestId, message.index));
      }
    }, [applyDocument, commitPlainTextPaste, focusEditor, inject, maxHeight, onBlur, onChangeDocument, onFocus, onHeightChange, onPasteImagesLoading, persistPastedImage, runtimeConfig, settlePastedImage]);

    return (
      <WebView
        ref={webViewRef}
        accessibilityHint={accessibilityHint}
        accessibilityLabel={accessibilityLabel}
        // hidden 期间(语音听写)把整棵子树从无障碍树里摘掉。opacity: 0 只影响视觉与
        // hitTest,读屏焦点仍能落到这个不可见的 textbox 上;而它的 focus 已不再停止听写
        // (停听写只认覆盖层的真实触摸),读屏用户会卡在一个「按了没反应」的输入框里。
        // iOS 用 accessibilityElementsHidden,Android 用 importantForAccessibility,
        // 两端都要给,少一个就会在该平台留下幽灵焦点。
        accessibilityElementsHidden={hidden}
        importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
        allowFileAccess={false}
        // iOS 给 WKWebView 里的可编辑区域挂一条系统表单导航条(上一项 / 下一项 /
        // 完成),iOS 26 起画成键盘上方的独立浮动胶囊。composer 只有这一个字段,
        // 前后导航恒为禁用态,整条对用户没有任何价值却占掉一行。RN TextInput
        // 没有这条,所以只有会话页这个富文本输入框会出现。
        //
        // 仅 iPhone:iPad 上同一个 accessory view 承载撤销 / 重做 / 粘贴等真实
        // 编辑能力(本 app app.json 声明了 supportsTablet),清掉是功能回退。
        hideKeyboardAccessoryView={Platform.OS === 'ios' && !Platform.isPad}
        javaScriptEnabled
        keyboardDisplayRequiresUserAction={false}
        onMessage={handleMessage}
        originWhitelist={['about:blank']}
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        source={{ html }}
        style={[styles.webView, { height, opacity: hidden ? 0 : 1 }]}
        testID={testID}
        textInteractionEnabled
      />
    );
  },
);

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/gif') return 'gif';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/heic' || mimeType === 'image/heif') return 'heic';
  return 'jpg';
}

async function deleteComposerPastedImageUris(uris: readonly string[]): Promise<void> {
  const FileSystem = await import('expo-file-system/legacy');
  await Promise.all(uris.map((uri) => (
    FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined)
  )));
}

const styles = StyleSheet.create({
  webView: {
    backgroundColor: 'transparent',
    // react-native-webview defaults the native child to flex: 1. Override it
    // because this composer drives the child with an explicit measured height.
    flex: 0,
    minHeight: COMPOSER_SINGLE_LINE_HEIGHT,
  },
});
