import { describe, expect, it } from 'vitest';
import { parsePiManagementArgs, parsePiManagementText } from '../managed-command.js';

describe('Pi management grammar', () => {
  it.each(['pi update', '/pi update --self', 'pi update self', 'pi update pi'])(
    'routes %s to core, not a source', text => {
      expect(parsePiManagementText(text)).toEqual({ action: 'command', command: { kind: 'self', force: false } });
    },
  );
  it.each([
    ['pi update --all', 'all'], ['pi update --self --extensions', 'all'],
    ['pi update --extensions', 'extensions'], ['pi list', 'list'], ['pi --version', 'version'],
  ])('classifies %s', (text, kind) => {
    expect(parsePiManagementText(text)).toMatchObject({ action: 'command', command: { kind } });
  });
  it('keeps single package aliases and quoted paths equivalent', () => {
    expect(parsePiManagementText('pi update --extension npm:test')).toEqual(parsePiManagementText('pi update npm:test'));
    expect(parsePiManagementText('pi uninstall "./a b"')).toEqual({ action: 'remove', source: './a b' });
    expect(parsePiManagementText('pi update --self --force')).toMatchObject({ command: { kind: 'self', force: true } });
  });
  it.each(['pi update --unknown', 'pi update --all --self', 'pi install', 'pi remove a b',
    'pi install --local a', 'pi update --extension', 'pi update --models', 'pi config',
    'pi update && echo done', 'pi\nupdate', 'pi install "$HOME/package"', 'pi update\npi remove a', 'pi login', 'pi update --models --self'])('explicitly rejects %s', text => {
    expect(parsePiManagementText(text)).toHaveProperty('error');
  });
  it('does not claim interactive slash or ordinary prose', () => {
    expect(parsePiManagementText('/compact')).toBeUndefined();
    expect(parsePiManagementText('please update Pi')).toBeUndefined();
    expect(parsePiManagementArgs(['update', '--help'])).toEqual({ action: 'command', command: { kind: 'help', topic: 'update' } });
  });
});
