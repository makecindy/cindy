interface AtResourceInsertEditor {
  isDestroyed: boolean;
  state: { doc: unknown };
}

/**
 * Native resource picking is asynchronous. Only apply its result while the
 * originating editor and document are still current, so a late picker result
 * cannot replace text typed after the picker opened or content from another
 * task that reused the composer.
 */
export function isAtResourceInsertTargetCurrent(
  originEditor: AtResourceInsertEditor,
  currentEditor: AtResourceInsertEditor | null,
  originDoc: unknown,
  originStorageKey: string | undefined,
  currentStorageKey: string | undefined,
): boolean {
  return (
    currentEditor === originEditor &&
    !originEditor.isDestroyed &&
    originEditor.state.doc === originDoc &&
    currentStorageKey === originStorageKey
  );
}
