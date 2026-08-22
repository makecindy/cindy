import { describe, expect, it } from 'vitest';

import {
  collectBotOutputArtifacts,
  parseBotOutputArtifacts,
} from '../botOutputArtifact.js';

describe('Bot output artifacts', () => {
  it('extracts managed and compatibility references without accepting local paths', () => {
    const hash = 'a'.repeat(64);
    expect(collectBotOutputArtifacts([
      `![result](cindy-media://blobs/${hash}.png)`,
      'report: xdt-file://local/?path=%2Fworkspace%2Freport.pdf',
      'unsafe: /Users/private/secret.txt',
      `duplicate cindy-media://blobs/${hash}.png`,
    ].join('\n'))).toEqual([
      { ref: `cindy-media://blobs/${hash}.png`, kind: 'image' },
      { ref: 'xdt-file://local/?path=%2Fworkspace%2Freport.pdf', kind: 'file' },
    ]);
  });

  it('fails closed for malformed persisted values', () => {
    expect(parseBotOutputArtifacts('{bad')).toEqual([]);
    expect(parseBotOutputArtifacts(JSON.stringify([
      { ref: 'cindy-media://blobs/a.png', kind: 'image' },
      { ref: 1, kind: 'file' },
      { ref: 'https://example.com/a.png', kind: 'remote' },
    ]))).toEqual([{ ref: 'cindy-media://blobs/a.png', kind: 'image' }]);
  });
});
