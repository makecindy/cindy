import { describe, expect, it } from 'vitest';

import {
  attachmentExtension,
  isDangerousAttachmentName,
} from '../attachmentSafety';

describe('attachment safety policy', () => {
  it('normalizes extensions across Windows and POSIX paths', () => {
    expect(attachmentExtension('C:\\Downloads\\SETUP.EXE')).toBe('.exe');
    expect(attachmentExtension('/tmp/archive.tar.gz')).toBe('.gz');
    expect(attachmentExtension('.env')).toBe('');
  });

  it.each([
    'setup.exe',
    'installer.msi',
    'update.msu',
    'package.dmg',
    'bundle.pkg',
    'tool.app',
    'script.cmd',
    'script.ps1',
    'script.vbs',
    'script.js',
    'script.jse',
    'script.py',
    'script.pyw',
    'script.rb',
    'payload.hta',
    'settings.reg',
    'launch.command',
    'tool.AppImage',
    'package.deb',
    'payload.jar',
    'shortcut.lnk',
    'website.url',
  ])('marks %s as dangerous', (name) => {
    expect(isDangerousAttachmentName(name)).toBe(true);
  });

  it.each(['archive.zip', 'model.blend', 'design.psd', 'report.pdf', 'source.ts']) (
    'keeps %s outside the executable policy',
    (name) => {
      expect(isDangerousAttachmentName(name)).toBe(false);
    },
  );
});
