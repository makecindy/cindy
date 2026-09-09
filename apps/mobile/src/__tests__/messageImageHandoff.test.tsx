// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMessageContentLayout } from '@/session/messageContentLayout';
import { attachmentImageDisplaySize, mediaThumbnailPhase, shouldAutoResolveMediaThumbnail } from '@/session/mediaThumbnail';
import { isDesktopLocalMediaUrl } from '@/session/remoteMedia';
import { spacing } from '@/theme/tokens';

// Run the production components with real React effects; only native image decoding is controlled.
const source = ts.createSourceFile('renderer.tsx', readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['PendingAttachmentImage', 'MediaPreview']);
const pendingSource = ts.createSourceFile('pending.tsx', readFileSync(resolve(process.cwd(), 'src/session/PendingSendBubble.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const hookCode = pendingSource.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'useThumbCellUri')!.getText(pendingSource);
const componentCode = source.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? '')).map((node) => node.getText(source)).join('\n') + '\n' + hookCode;
const compiled = ts.transpileModule(componentCode, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const cache = new Map();
  const handlers = new Map<string, { onLoad: (event: unknown) => void; onError: () => void }>();
  const durable = new Map<string, string>();
  const flatten = (style: unknown): React.CSSProperties => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
  const View = ({ children, style, testID, onPress }: any) => <div style={flatten(style)} data-testid={testID} onClick={onPress}>{children}</div>;
  const ExpoImage = ({ source: imageSource, style, onLoad, onError }: any) => {
    handlers.set(imageSource.uri, { onLoad, onError });
    return <div data-image={imageSource.uri} style={flatten(style)} />;
  };
  const Image = Object.assign(ExpoImage, { getSize: vi.fn() });
  const bindings = { React, View, Text: View, ExpoImage, Image,
    useThemedStyles: () => ({}), makeStyles: () => ({}),
    useRecyclingState: React.useState, useState: React.useState, useLayoutEffect: React.useLayoutEffect,
    useEffect: React.useEffect, useRef: React.useRef, useCallback: React.useCallback,
    attachmentIntrinsicSizeCache: cache, ATTACHMENT_INTRINSIC_CACHE_MAX: 500,
    attachmentImageDisplaySize, mediaThumbnailPhase, shouldAutoResolveMediaThumbnail, isDesktopLocalMediaUrl,
    getSentAttachmentThumbUri: (ref: string) => durable.get(ref) ?? null,
    MessageContentOpenButton: View,
    buildMediaPayload: (media: unknown) => media,
    summarizeMessagePayloadPreview: () => ({ actionLabel: 'Open', title: 'Image', meta: ['Image'], detail: 'Preview' }),
    payloadMediaKindLabel: () => 'Image',
  };
  const components = new Function(...Object.keys(bindings), `${compiled}; return { PendingAttachmentImage, MediaPreview, useThumbCellUri };`)(...Object.values(bindings));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => { act(() => root.unmount()); host.remove(); });
  const layout = buildMessageContentLayout({ screenWidth: 390 });
  const render = (node: React.ReactNode) => act(() => root.render(node));
  const frame = () => {
    const image = host.querySelector('[data-image]') as HTMLElement;
    return [image.style.width, image.style.height];
  };
  return { ...components, host, render, layout, handlers, frame, durable, Image };
}

describe('image frame continuity', () => {
  it('keeps the displayed pending source when upload completes, but releases it on attachment replacement', () => {
    const f = fixture();
    const Probe = ({ thumb }: any) => <span>{f.useThumbCellUri(thumb)}</span>;
    const thumb = { key: 'message-slot-0', uri: 'file:///original.jpg', ossRef: null };
    f.render(<Probe thumb={thumb} />);
    f.durable.set('cindy-oss-attach://m/a', 'file:///durable.jpg');
    f.render(<Probe thumb={{ ...thumb, ossRef: 'cindy-oss-attach://m/a' }} />);
    expect(f.host.textContent).toBe(thumb.uri);
    f.render(<Probe thumb={{ ...thumb, uri: 'file:///replacement.jpg' }} />);
    expect(f.host.textContent).toBe('file:///replacement.jpg');
  });
  it.each([[900, 1600], [1600, 900]])('keeps the loaded %s x %s frame on the first formal render before any new decode', (width, height) => {
    const f = fixture();
    const localPreview = { uri: 'ph://photo', sourceRef: 'cindy-oss-attach://m/a' };
    f.render(<f.PendingAttachmentImage uri={localPreview.uri} layout={f.layout} />);
    act(() => f.handlers.get(localPreview.uri)!.onLoad({ source: { width, height } }));
    const pendingFrame = f.frame();
    const resolveRemote = vi.fn();
    const formal = <f.MediaPreview layout={f.layout} label="photo" variant="attachment" localPreview={localPreview}
      media={{ kind: 'image', url: 'cindy-media://blobs/a.jpg', previewable: false }} onResolveRemoteMedia={resolveRemote} />;
    f.render(formal);
    expect(f.frame()).toEqual(pendingFrame);
    expect(f.host.querySelector('[data-testid="message.mediaThumbLoading"]')).toBeNull();
    expect(resolveRemote).not.toHaveBeenCalled();
    expect(f.Image.getSize).not.toHaveBeenCalled();
    // Registration finishing later must not replace the already visible local source.
    f.durable.set(localPreview.sourceRef, 'file:///durable.jpg');
    f.render(React.cloneElement(formal));
    expect(f.host.querySelector('[data-image]')?.getAttribute('data-image')).toBe(localPreview.uri);
    expect(f.frame()).toEqual(pendingFrame);
    // A deleted paste source can switch to its durable copy, retaining the same geometry.
    act(() => f.handlers.get(localPreview.uri)!.onError());
    expect(f.host.querySelector('[data-image]')?.getAttribute('data-image')).toBe('file:///durable.jpg');
    expect(f.frame()).toEqual(pendingFrame);
  });

  it('keeps an unavailable OSS image inside the attachment frame rather than a small file card', () => {
    const f = fixture();
    f.render(<f.MediaPreview layout={f.layout} label="photo" variant="attachment"
      media={{ kind: 'image', url: 'cindy-oss-attach://m/missing', previewable: false }} />);
    const fallback = f.host.querySelector('[data-testid="message.mediaThumbFallback"]') as HTMLElement;
    expect(fallback.style.width).toBe(`${f.layout.attachmentImageMaxWidth}px`);
    expect(fallback.style.height).toBe(`${f.layout.attachmentImageMaxHeight}px`);
  });

  it('uses the same top spacing and attachment-to-body gap in both row layouts', () => {
    function styles(file: ts.SourceFile, selected: string[]) {
      const properties: string[] = [];
      function visit(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'makeStyles') {
          const body = (node.initializer as ts.ArrowFunction).body as ts.CallExpression;
          for (const property of (body.arguments[0] as ts.ObjectLiteralExpression).properties) {
            if (property.name && selected.includes(property.name.getText(file))) properties.push(property.getText(file));
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(file);
      expect(properties).toHaveLength(selected.length);
      return new Function('spacing', 'MOBILE_MESSAGE_LIST_BOTTOM_PADDING', `return ({${properties.join(',')}});`)(spacing, 0);
    }
    const pending = styles(pendingSource, ['rowWrap', 'bubbleRow', 'content', 'attachmentStrip']);
    const formal = styles(source, ['messages', 'messageItem', 'userMessageItem', 'attachmentStrip']);
    const top = (rows: any[]) => rows.reduce((sum, row) => sum + (row.marginTop ?? 0) + (row.paddingTop ?? 0), formal.messages.gap);
    expect(top([pending.rowWrap, pending.bubbleRow, pending.content])).toBe(top([formal.messageItem, formal.userMessageItem]));
    expect(formal.messages.gap).toBe(spacing.lg);
    expect(pending.content.gap + pending.attachmentStrip.marginBottom).toBe(formal.messageItem.gap + formal.attachmentStrip.marginBottom);
  });
});
