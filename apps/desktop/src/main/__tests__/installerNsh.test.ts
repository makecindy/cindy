import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const installerScript = fs.readFileSync(
  path.resolve(__dirname, '../../../resources/installer.nsh'),
  'utf8',
);

function macroBody(name: string): string {
  const match = installerScript.match(
    new RegExp(`!macro ${name}(?: [^\\r\\n]*)?\\r?\\n([\\s\\S]*?)!macroend`),
  );
  expect(match, `missing NSIS macro: ${name}`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('Windows installer process shutdown contract', () => {
  it('stops the packaged app before both install and uninstall mutate its files', () => {
    const stopRunningProduct = macroBody('stopRunningProduct');

    expect(stopRunningProduct).toContain('nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"');
    expect(stopRunningProduct).toContain('nsProcess::_KillProcess "${APP_EXECUTABLE_FILENAME}"');
    expect(stopRunningProduct).toContain('/SD IDOK');
    expect(stopRunningProduct).toContain('Goto check_running');
    expect(macroBody('customInit')).toContain('!insertmacro stopRunningProduct');
    expect(macroBody('customUnInit')).toContain('!insertmacro stopRunningProduct');
  });
});
