import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const installer = readFileSync(new URL('../resources/installer.nsh', import.meta.url), 'utf8');
const directory = readFileSync(
  new URL('../resources/installer-directory.nsh', import.meta.url),
  'utf8',
);

describe('Windows NSIS include paths', () => {
  it('resolves project-owned includes from BUILD_RESOURCES_DIR', () => {
    expect(installer).toContain('!include "${BUILD_RESOURCES_DIR}\\winget-shortcuts.nsh"');
    expect(installer).toContain('!include "${BUILD_RESOURCES_DIR}\\installer-directory.nsh"');
    expect(directory).toContain(
      '!include "${BUILD_RESOURCES_DIR}\\installer-directory-messages.nsh"',
    );
  });

  it('does not depend on the NSIS working directory for project-owned files', () => {
    expect(installer).not.toContain('!include "winget-shortcuts.nsh"');
    expect(installer).not.toContain('!include "installer-directory.nsh"');
    expect(directory).not.toContain('!include "installer-directory-messages.nsh"');
  });
});
