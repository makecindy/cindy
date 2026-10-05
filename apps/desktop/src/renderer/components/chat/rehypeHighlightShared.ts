import rehypeHighlight from 'rehype-highlight';

type HighlightTransformer = ReturnType<typeof rehypeHighlight>;

let sharedTransformer: HighlightTransformer | undefined;

/**
 * rehype-highlight with one lowlight instance for the whole renderer.
 *
 * react-markdown builds a new processor and re-attaches plugins on every
 * render, and rehype-highlight's attacher calls createLowlight(common) each
 * time, re-registering about forty languages. Switching back to a long task
 * re-renders every bubble at once, so that registration is pure repeated work.
 * The returned transformer only reads the lowlight registry and never touches
 * the processor, so one instance can serve every processor.
 */
export function rehypeHighlightShared(): HighlightTransformer {
  sharedTransformer ??= rehypeHighlight();
  return sharedTransformer;
}
