import { describe, expect, it } from 'vitest';

import type { UserMessage } from '../../types/common.js';
import { formatManagedImageReferences } from './managed-image-reference.js';

describe('formatManagedImageReferences', () => {
  it('numbers references by original image order and emits JSON-safe metadata', () => {
    const firstManagedUrl = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    const secondManagedUrl = 'xdt-image://session/second%20image.png';
    const content: UserMessage['content'] = [
      { type: 'image', path: '/tmp/unmanaged.png' },
      { type: 'text', text: 'Edit the last two images' },
      { type: 'image', path: '/tmp/first.png', managedUrl: firstManagedUrl },
      { type: 'image', path: '/tmp/second.png', managedUrl: secondManagedUrl },
    ];

    const formatted = formatManagedImageReferences(content);

    expect(formatted).toContain(JSON.stringify({ image: 2, uri: firstManagedUrl }));
    expect(formatted).toContain(JSON.stringify({ image: 3, uri: secondManagedUrl }));
    expect(formatted).not.toContain(JSON.stringify({ image: 1 }));
  });

  it('does not add metadata when the turn has no Host-managed image identity', () => {
    expect(formatManagedImageReferences('plain text')).toBe('');
    expect(formatManagedImageReferences([
      { type: 'image', path: '/tmp/unmanaged.png' },
      { type: 'text', text: 'Describe it' },
    ])).toBe('');
  });
});
