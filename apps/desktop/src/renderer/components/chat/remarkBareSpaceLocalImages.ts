/**
 * remarkBareSpaceLocalImages — turn `![alt](/abs/path with spaces/x.png)` left as
 * plain text by CommonMark into a real `image` node.
 *
 * Agents often write local images under folders such as `Application Support`
 * without the `<...>` form CommonMark requires. Main-process IM delivery recovers
 * the same construct with the same matcher (`shared/bareSpaceLocalImages.ts`),
 * and mobile already renders it, so the desktop chat must show what IM sends.
 *
 * Must run before remarkLocalPathLinks (which would otherwise cut the path into
 * link fragments) and before remarkPreserveRawLocalDestinations (which records
 * the raw local destination for the img renderer).
 */

import type { Root } from 'mdast';
import type { Plugin } from 'unified';
import { recoverBareSpaceLocalImages } from '../../../shared/bareSpaceLocalImages';

const remarkBareSpaceLocalImages: Plugin<[], Root> = () => {
  return (tree, file) => {
    recoverBareSpaceLocalImages(tree, String(file));
  };
};

export default remarkBareSpaceLocalImages;
