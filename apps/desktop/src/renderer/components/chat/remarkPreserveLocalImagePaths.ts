/**
 * Preserve the exact local image destination before mdast-to-hast URL
 * serialization makes literal percent escapes ambiguous.
 *
 * Both a real space and the literal filename segment `%20` reach a custom
 * react-markdown image renderer as `%20`. Store the mdast value in a neutral
 * data property so the renderer can route the original filesystem path.
 */

import type { Image, Root } from 'mdast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';

export const RAW_LOCAL_IMAGE_SRC_PROP = 'data-cindy-raw-local-image-src';

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

function isLocalImageDestination(url: string): boolean {
  return (
    WINDOWS_ABSOLUTE_PATH_RE.test(url) ||
    url.startsWith('file://') ||
    !URL_SCHEME_RE.test(url)
  );
}

const remarkPreserveLocalImagePaths: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'image', (node: Image) => {
      if (!isLocalImageDestination(node.url)) return;

      node.data = {
        ...node.data,
        hProperties: {
          ...(node.data?.hProperties ?? {}),
          [RAW_LOCAL_IMAGE_SRC_PROP]: node.url,
        },
      };
    });
  };
};

export default remarkPreserveLocalImagePaths;
