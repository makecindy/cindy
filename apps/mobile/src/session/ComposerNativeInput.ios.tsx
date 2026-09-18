import { requireNativeView, requireOptionalNativeModule } from "expo";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useTheme } from '@/theme';
import { File, Paths } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
import type {
  ComposerRichInputProps,
  ComposerRichInputHandle,
} from "./ComposerRichInput";
import {
  composerDocumentProjectedText,
  parseStoredComposerDocument,
  type ComposerDocument,
  type ComposerNode,
} from "./composerDocument";
import {
  nativeComposerNodes,
  composerOffsetToNative,
  nativeSelectionToComposer,
} from "./composerNativeDocument";
import { composerNodesForBoundedPlainTextPaste } from "./composerPaste";
import { COMPOSER_PASTED_IMAGE_FILE_PREFIX } from "./pastedImageAttachment";

type Payload = { ack: number; nodes: ReturnType<typeof nativeComposerNodes> };
type NativeHandle = {
  expand(): Promise<void>;
  resolveLink(href: string, semantic: object): Promise<void>;
  focus(): Promise<void>;
  blur(): Promise<void>;
  setDocument(document: Payload, offset: number, focus: boolean): Promise<void>;
  insertNodes(
    nodes: Payload["nodes"],
    revision: number,
    start: number,
    length: number,
  ): Promise<boolean>;
};
type Event<T> = NativeSyntheticEvent<T>;
type Props = ViewProps & {
  ref?: React.Ref<NativeHandle>;
  colorScheme: string;
  document: Payload;
  editable: boolean;
  placeholder: string;
  textColor: string;
  caretColor: string;
  placeholderColor: string;
  chipColor: string;
  inputLabel: string;
  inputHint: string;
  inputID?: string;
  onDocumentChange(event: Event<{ document: unknown; revision: number }>): void;
  onSelectionChange(
    event: Event<{ start: number; end: number; revision: number }>,
  ): void;
  onFocusChange(event: Event<{ focused: boolean }>): void;
  onContentHeight(event: Event<{ height: number }>): void;
  onPasteText(
    event: Event<{
      text: string;
      revision: number;
      start: number;
      length: number;
    }>,
  ): void;
  onPasteImages(event: Event<{ images: string[] }>): void;
};
export const nativeComposerAvailable =
  !!requireOptionalNativeModule("CindyComposer");
const NativeInput = nativeComposerAvailable
  ? requireNativeView<Props>("CindyComposer")
  : null;

export const ComposerNativeInput = forwardRef<
  ComposerRichInputHandle,
  ComposerRichInputProps
>(function ComposerNativeInput(props, ref) {
  const { mode } = useTheme();
  const native = useRef<NativeHandle>(null);
  const current = useRef(props.document);
  const revision = useRef(0);
  const initialEnd = props.document.nodes.reduce((length, node) => length + (node.type === 'text' ? node.text.length : 1), 0);
  const selection = useRef({ start: initialEnd, end: initialEnd });
  // Dictation reports its selection before React renders the corresponding draft.
  // Keep projected offsets keyed by that draft; native apply() can echo the old caret.
  const rememberedSelection = useRef<{ draft: string; start: number; end: number } | null>(null);
  const mounted = useRef(true);
  const pendingImages = useRef(new Set<string>());
  current.current = props.document;
  const payload = (document: ComposerDocument): Payload => ({
    ack: revision.current,
    nodes: nativeComposerNodes(document),
  });
  const { animatedHeight, height } = props;
  const animatedStyle = useAnimatedStyle(() => ({
    height: animatedHeight?.value ?? height,
  }));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const uri of pendingImages.current)
        void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      pendingImages.current.clear();
    };
  }, []);
  // stop() retains this handle while the final transcript renders. Keep its
  // identity for this mounted editor so the screen's replacement guard stays valid.
  useImperativeHandle(ref, () => ({
    getSelection(draft) {
      const remembered = rememberedSelection.current;
      if (remembered?.draft === draft)
        return { start: remembered.start, end: remembered.end };
      if (draft !== composerDocumentProjectedText(current.current))
        return { start: draft.length, end: draft.length };
      return nativeSelectionToComposer(
        current.current,
        selection.current.start,
        selection.current.end,
      );
    },
    rememberSelection(draft, value) {
      rememberedSelection.current = { draft, ...value };
    },
    expand() { void native.current?.expand(); },
    focus() {
      void native.current?.focus();
    },
    blur() {
      void native.current?.blur();
    },
    applyDocumentAndSetSelectionToEnd(document) {
      rememberedSelection.current = null;
      void native.current?.setDocument(
        payload(document),
        nativeComposerNodes(document).reduce(
          (n, x) => n + (x.node.type === "text" ? x.node.text.length : 1),
          0,
        ),
        true,
      );
    },
    applyDocumentAndFocusSelection(document, offset) {
      rememberedSelection.current = null;
      void native.current?.setDocument(
        payload(document),
        composerOffsetToNative(document, offset),
        true,
      );
    },
    insertNode(node: ComposerNode) {
      void native.current?.insertNodes(
        nativeComposerNodes({ version: 1, nodes: [node] }),
        -1,
        -1,
        0,
      );
    },
  }), []);
  if (!NativeInput) return null;
  return (
    <Animated.View
      style={[{ width: "100%", opacity: props.hidden ? 0 : 1 }, animatedStyle]}
    >
      <NativeInput
        ref={native}
        style={{ flex: 1 }}
        colorScheme={mode}
        document={payload(props.document)}
        editable={props.editable !== false}
        placeholder={props.placeholder}
        inputHint={props.accessibilityHint ?? ""}
        inputLabel={props.accessibilityLabel}
        inputID={props.testID}
        textColor={props.theme.text}
        caretColor={props.caretHidden ? "transparent" : props.theme.focus}
        chipColor={props.theme.chip}
        placeholderColor={props.theme.placeholder}
        onDocumentChange={({ nativeEvent }) => {
          const document = parseStoredComposerDocument(nativeEvent.document);
          if (!document || nativeEvent.revision < revision.current) return;
          rememberedSelection.current = null;
          revision.current = nativeEvent.revision;
          current.current = document;
          props.onChangeDocument(document);
        }}
        onSelectionChange={({ nativeEvent }) => {
          if (nativeEvent.revision >= revision.current)
            selection.current = nativeEvent;
        }}
        onFocusChange={({ nativeEvent }) =>
          nativeEvent.focused ? props.onFocus?.() : props.onBlur?.()
        }
        onContentHeight={({ nativeEvent }) =>
          props.onHeightChange?.(nativeEvent.height)
        }
        onPasteText={({ nativeEvent }) => {
          const nodes = composerNodesForBoundedPlainTextPaste(nativeEvent.text);
          if (nodes)
            void native.current
              ?.insertNodes(
                nativeComposerNodes({ version: 1, nodes }),
                nativeEvent.revision,
                nativeEvent.start,
                nativeEvent.length,
              )
              .then((inserted) => {
                if (!inserted || !props.resolveSessionLinkLabel) return;
                for (const node of nodes) {
                  if (node.type !== "session-link" || node.titled) continue;
                  void props
                    .resolveSessionLinkLabel(node.href)
                    .then((semantic) => {
                      if (semantic && mounted.current)
                        void native.current?.resolveLink(node.href, semantic);
                    })
                    .catch(() => {});
                }
              });
        }}
        onPasteImages={({ nativeEvent }) => {
          const images = nativeEvent.images;
          if (!images.length) {
            props.onPasteImagesLoadFailed?.();
            return;
          }
          props.onPasteImagesLoading?.(images.length);
          void (async () => {
            const uris: string[] = [];
            try {
              for (const base64 of images) {
                const file = new File(
                  Paths.cache,
                  `${COMPOSER_PASTED_IMAGE_FILE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
                );
                pendingImages.current.add(file.uri);
                uris.push(file.uri);
                await FileSystem.writeAsStringAsync(file.uri, base64, {
                  encoding: FileSystem.EncodingType.Base64,
                });
              }
              if (!mounted.current || !props.onPasteImages)
                throw new Error("paste cancelled");
              for (const uri of uris) pendingImages.current.delete(uri);
              props.onPasteImages(uris);
            } catch {
              for (const uri of uris) {
                pendingImages.current.delete(uri);
                void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
              }
              if (mounted.current) props.onPasteImagesLoadFailed?.();
            }
          })();
        }}
      />
    </Animated.View>
  );
});
