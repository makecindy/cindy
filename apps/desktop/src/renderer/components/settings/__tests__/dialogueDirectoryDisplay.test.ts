import { describe, expect, it } from 'vitest';
import { dialogueDirectoryDisplayParts } from '../dialogueDirectoryDisplay';

describe('chat workspace path summary across platforms', () => {
  // These are inputs for the explicitly named target platform, not host filesystem paths.
  it.each([
    ['win32', 'C:\\Users\\me\\AppData\\Roaming\\Cindy\\owners\\49011892028b05fbb1ef\\dialogues', ['Cindy', 'dialogues']],
    ['win32', 'D:/My Files/dialogues/49011892028b05fbb1ef', ['My Files', 'dialogues']],
    ['win32', '\\\\server\\share\\dialogues\\49011892028b05fbb1ef', ['share', 'dialogues']],
    ['darwin', '/Users/me/Library/Application Support/Cindy/owners/49011892028b05fbb1ef/dialogues', ['Cindy', 'dialogues']],
    ['darwin', '/Volumes/Work Drive/dialogues/49011892028b05fbb1ef', ['Work Drive', 'dialogues']],
    ['linux', '/home/me/.config/Cindy/owners/49011892028b05fbb1ef/dialogues', ['Cindy', 'dialogues']],
    ['linux', '/mnt/资料/dialogues/49011892028b05fbb1ef', ['资料', 'dialogues']],
    ['linux', '/home/me/back\\slash/dialogues/49011892028b05fbb1ef', ['back\\slash', 'dialogues']],
  ])('%s: %s', (platform, directory, expected) => {
    expect(dialogueDirectoryDisplayParts(directory as string, platform as string)).toEqual(expected);
  });
});
