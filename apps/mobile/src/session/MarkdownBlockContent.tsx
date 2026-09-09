import { memo, type ReactNode } from 'react';
import type { MobileMarkdownBlock } from '@/session/messageMarkdown';

function shallowEqual(left: object, right: object): boolean {
  if (left === right) return true;
  const entries = Object.entries(left);
  return entries.length === Object.keys(right).length
    && entries.every(([key, value]) => Object.hasOwn(right, key)
      && Object.is(value, (right as Record<string, unknown>)[key]));
}

function sameBlock(left: MobileMarkdownBlock, right: MobileMarkdownBlock): boolean {
  if (left === right) return true;
  // Android's bounded text runs clone oversized blocks on each grouping pass.
  // Compare their flat inline data so unchanged chunks also keep their spans.
  // Non-text blocks stay on the parser identity fast path (no deep table walk).
  if (!('inlines' in left) || !('inlines' in right)) return false;
  const { inlines: leftInlines, ...leftFields } = left;
  const { inlines: rightInlines, ...rightFields } = right;
  return shallowEqual(leftFields, rightFields)
    && leftInlines.length === rightInlines.length
    && leftInlines.every((inline, index) => shallowEqual(inline, rightInlines[index]));
}

/**
 * Keep immutable parser blocks as React update boundaries. This component adds
 * no native view: text-run blocks remain children of the SAME selectable text
 * view, so selection can still span paragraphs and list items.
 */
export const MarkdownBlockContent = memo(function MarkdownBlockContent({
  block,
  leadingGap = false,
  renderBlock,
}: {
  block: MobileMarkdownBlock;
  leadingGap?: boolean;
  renderBlock: (block: MobileMarkdownBlock, leadingGap: boolean) => ReactNode;
}) {
  return renderBlock(block, leadingGap);
}, (previous, next) => (
  previous.renderBlock === next.renderBlock
  && previous.leadingGap === next.leadingGap
  && sameBlock(previous.block, next.block)
));
