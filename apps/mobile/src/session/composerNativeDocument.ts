import {
  composerDocumentProjectedText,
  serializeComposerDocument,
  type ComposerDocument,
  type ComposerNode,
  type ComposerSelection,
} from "./composerDocument";

export function nativeComposerNodes(document: ComposerDocument) {
  return document.nodes.map((node) => ({
    node,
    label:
      node.type === "text"
        ? ""
        : node.type === "quote"
          ? node.quote.text.slice(0, 80)
          : node.type === "pasted-text"
            ? node.display
            : node.label,
    wire: serializeComposerDocument({ version: 1, nodes: [node] }).text,
  }));
}

/** UIKit selection is UTF-16 with one code unit per attachment, unlike wire offsets. */
export function nativeOffsetToComposer(
  document: ComposerDocument,
  offset: number,
) {
  let remaining = Math.max(0, offset),
    projected = 0,
    atoms = 0;
  for (const node of document.nodes) {
    if (remaining <= 0) break;
    const nativeLength = node.type === "text" ? node.text.length : 1;
    if (node.type === "text") projected += Math.min(remaining, nativeLength);
    else {
      projected += composerDocumentProjectedText({
        version: 1,
        nodes: [node],
      }).length;
      atoms++;
    }
    remaining -= nativeLength;
  }
  return { offset: projected, atoms };
}
export function nativeSelectionToComposer(
  document: ComposerDocument,
  start: number,
  end: number,
): ComposerSelection {
  const a = nativeOffsetToComposer(document, start),
    b = nativeOffsetToComposer(document, end);
  return {
    start: a.offset,
    end: b.offset,
    atomRange: { start: a.atoms, end: b.atoms },
  };
}
export function composerOffsetToNative(
  document: ComposerDocument,
  offset: number,
) {
  let remaining = Math.max(0, offset),
    native = 0;
  for (const node of document.nodes) {
    const length = composerDocumentProjectedText({
      version: 1,
      nodes: [node],
    }).length;
    if (node.type === "text") {
      if (remaining <= length) return native + remaining;
      native += length;
    } else {
      if (length > 0 && remaining < length) return native;
      native++;
    }
    remaining -= length;
  }
  return native;
}

/** Preserve which side of a zero-width quote a remembered caret belongs to. */
export function composerSelectionToNative(document: ComposerDocument, selection: ComposerSelection) {
  const endpoint = (offset: number, atomCount: number | undefined) => {
    if (atomCount === undefined) return composerOffsetToNative(document, offset);
    let native = 0, projected = 0, atoms = 0;
    for (const node of document.nodes) {
      if (atoms === atomCount && offset === projected) return native;
      const length = composerDocumentProjectedText({ version: 1, nodes: [node] }).length;
      if (node.type === 'text') {
        if (atoms === atomCount && offset >= projected && offset <= projected + length) return native + offset - projected;
        native += node.text.length;
      } else { native++; atoms++; }
      projected += length;
    }
    return native;
  };
  return { start: endpoint(selection.start, selection.atomRange?.start), end: endpoint(selection.end, selection.atomRange?.end) };
}
