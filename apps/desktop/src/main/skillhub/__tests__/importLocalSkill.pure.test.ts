import { describe, expect, it } from 'vitest';

import {
  classifyImportSourcePath,
  extractSkillMetadataFromMd,
  findZipSkillPackageRoot,
  isValidImportSkillName,
  relativizeZipEntry,
} from '../importLocalSkill.pure';

describe('isValidImportSkillName', () => {
  it('accepts registry-safe names', () => {
    expect(isValidImportSkillName('my-skill')).toBe(true);
    expect(isValidImportSkillName('a')).toBe(true);
  });

  it('rejects uppercase, underscores, empty', () => {
    expect(isValidImportSkillName('My-Skill')).toBe(false);
    expect(isValidImportSkillName('my_skill')).toBe(false);
    expect(isValidImportSkillName('')).toBe(false);
  });
});

describe('classifyImportSourcePath', () => {
  it('accepts zip and SKILL.md', () => {
    expect(classifyImportSourcePath('/tmp/pkg.zip')).toEqual({ kind: 'zip' });
    expect(classifyImportSourcePath('/tmp/SKILL.md')).toEqual({ kind: 'md' });
    expect(classifyImportSourcePath('/tmp/skill.md')).toEqual({ kind: 'md' });
  });

  it('rejects other md names and unknown extensions', () => {
    expect(classifyImportSourcePath('/tmp/README.md')).toMatchObject({ error: expect.any(String) });
    expect(classifyImportSourcePath('/tmp/foo.tar')).toMatchObject({ error: expect.any(String) });
  });
});

describe('findZipSkillPackageRoot', () => {
  it('finds SKILL.md at zip root', () => {
    expect(findZipSkillPackageRoot(['SKILL.md', 'refs/a.md'])).toEqual({ packageRoot: '' });
  });

  it('finds SKILL.md under a single top-level folder', () => {
    expect(findZipSkillPackageRoot(['my-skill/SKILL.md', 'my-skill/refs/x.md'])).toEqual({
      packageRoot: 'my-skill/',
    });
  });

  it('errors when missing or ambiguous', () => {
    expect(findZipSkillPackageRoot(['readme.txt'])).toMatchObject({ error: expect.any(String) });
    expect(
      findZipSkillPackageRoot(['a/SKILL.md', 'b/SKILL.md']),
    ).toMatchObject({ error: expect.any(String) });
  });

  it('prefers root SKILL.md when nested copies also exist', () => {
    expect(findZipSkillPackageRoot(['SKILL.md', 'vendor/SKILL.md'])).toEqual({ packageRoot: '' });
  });
});

describe('relativizeZipEntry', () => {
  it('strips package root and skips __MACOSX', () => {
    expect(relativizeZipEntry('my-skill/SKILL.md', 'my-skill/')).toBe('SKILL.md');
    expect(relativizeZipEntry('__MACOSX/._x', '')).toBeNull();
    expect(relativizeZipEntry('other/SKILL.md', 'my-skill/')).toBeNull();
  });
});

describe('extractSkillMetadataFromMd', () => {
  it('extracts name, description, and version', () => {
    const result = extractSkillMetadataFromMd(`---
name: demo-skill
description: Does useful things
version: 1.2.3
---

# Body
`);
    expect(result).toEqual({
      ok: true,
      metadata: {
        name: 'demo-skill',
        description: 'Does useful things',
        version: '1.2.3',
      },
    });
  });

  it('defaults version to 0.1.0', () => {
    const result = extractSkillMetadataFromMd(`---
name: demo-skill
description: Does useful things
---
`);
    expect(result.ok && result.metadata.version).toBe('0.1.0');
  });

  it('rejects missing name/description and invalid name', () => {
    expect(
      extractSkillMetadataFromMd(`---
description: only desc
---
`),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_FRONTMATTER' });

    expect(
      extractSkillMetadataFromMd(`---
name: Bad_Name
description: x
---
`),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_NAME' });
  });
});
