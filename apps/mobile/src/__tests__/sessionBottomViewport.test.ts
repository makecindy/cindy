import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { keyboardControlRegion, type ReservedRegion } from '@/platform/windowGeometry';

const source = ts.createSourceFile('session.tsx', readFileSync(
  resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function element(id: string) {
  let result: ts.JsxElement | undefined;
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(prop =>
      ts.isJsxAttribute(prop) && prop.name.getText(source) === 'testID'
      && prop.initializer && ts.isStringLiteral(prop.initializer) && prop.initializer.text === id)) result = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!result) throw new Error(`Missing ${id}`);
  return result;
}
function style(node: ts.JsxElement, bindings: Record<string, unknown>) {
  const attribute = node.openingElement.attributes.properties.find(prop =>
    ts.isJsxAttribute(prop) && prop.name.getText(source) === 'style') as ts.JsxAttribute;
  const expression = (attribute.initializer as ts.JsxExpression).expression!;
  const value = new Function(...Object.keys(bindings), `return (${expression.getText(source)});`)(...Object.values(bindings));
  return Object.assign({}, ...value.filter(Boolean));
}

it('clips the input and held card at the selected region while measuring only the bottom content', () => {
  const viewport = element('session.bottomViewport');
  const layer = element('session.bottomLayer');
  expect(layer.parent).toBe(viewport);
  expect(layer.openingElement.getText(source)).toContain('ref={bottomOverlayRef}');
  expect(viewport.openingElement.getText(source)).toContain('pointerEvents="box-none"');
  const regions: ReservedRegion[][] = [
    [{ kind: 'division', x: 0, y: 380, width: 800, height: 20 }],
    [{ kind: 'division', x: 390, y: 0, width: 20, height: 800 }],
    [{ kind: 'occlusion', x: 0, y: 650, width: 800, height: 80 }],
  ];
  for (const reserved of regions) for (const keyboardHeight of [0, 450]) {
    const geometry = { width: 800, height: 800, insets: { top: 24, bottom: 16, left: 0, right: 0 },
      regions: reserved, regularWidth: true, regularHeight: true, barEdge: 'none' as const, reservedRegionsSupported: true };
    const region = keyboardControlRegion(geometry, keyboardHeight);
    const bindings = { StyleSheet: { absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } },
      adaptiveWindow: geometry, composerRegion: region, paneLayout: { detail: { x: 0, width: 800 } },
      windowDimensions: geometry, insets: geometry.insets, styles: {}, nativeComposerFrameAvailable: true,
      sessionOperationLayout: { composerSlot: 'editable' }, shareSelectionActive: false,
      nativeShellLayout: { keyboardBottomInset: Math.max(0, keyboardHeight - 16) } };
    const clip = style(viewport, bindings);
    const input = style(layer, bindings);
    expect(clip).toMatchObject({ position: 'absolute', overflow: 'hidden', top: region.y, left: region.x,
      right: 800 - region.x - region.width, bottom: 800 - region.y - region.height });
    // Expanded input/attachments remain under a real native clipping ancestor;
    // the held card can extend above the measured input within that ancestor.
    expect(input.overflow).toBe('visible');
    expect(input.maxHeight).toBe(region.height);
    expect(input.bottom).toBe(-geometry.insets.bottom);
    expect(viewport.getText(source)).toContain('<SessionComposerPalette');
    expect(viewport.getText(source)).toContain('<ComposerActivityStatus');
    expect(viewport.getText(source)).toContain('<SessionComposerInput');
  }
});

it('keeps the newest row above the measured phone composer, including expanded input and safe area', async () => {
  const { mobileMessageListBottomPadding, mobileMessageListEndOffset } = await import('@/session/messageScroll');
  let inset: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'contentBottomInset') {
      inset = (node.initializer as ts.JsxExpression).expression;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(inset).toBeDefined();
  // Execute the actual SessionScreen prop and MessageRenderer padding helper.
  const contentInset = new Function('bottomOverlayHeight', `
    const companionInlineInteraction = false, shareSelectionActive = false,
      nativeComposerFrameAvailable = true, sessionOperationLayout = { composerSlot: 'editable' },
      MOBILE_MESSAGE_LIST_BOTTOM_PADDING = 132;
    return (${inset!.getText(source)});
  `);
  for (const keyboard of [0, 310]) for (const composer of [96, 132, 280]) for (const body of [64, 2400, 3000]) {
    const viewport = 844 - keyboard;
    const padding = mobileMessageListBottomPadding(composer, contentInset(composer));
    // LegendList alignItemsAtEnd aligns short histories; long histories use the
    // same end offset that the production tail follower verifies after resize.
    const height = Math.max(viewport, body + padding);
    const offset = mobileMessageListEndOffset({ contentHeight: height, viewportHeight: viewport, offsetY: 0 });
    const newestRowBottom = height - padding - offset;
    expect(newestRowBottom).toBe(viewport - composer);
    expect(padding).toBe(composer); // No extra gap from a fixed minimum on small inputs.
  }
  expect(contentInset(0)).toBe(132); // Only the as-yet unmeasured first layout uses the fallback.
});
