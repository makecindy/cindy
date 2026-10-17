import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ root: '', owner: 'owner-a' }));

vi.mock('electron', () => ({ app: { getPath: () => h.root } }));
vi.mock('../../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));
vi.mock('../../ownerScopedStorage.js', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) => path.join(h.root, 'owners', h.owner, ...parts),
}));
vi.mock('../../../appSessionState.js', () => ({ activeOwnerScopeKey: () => h.owner }));

import {
  addBotImConnectionRecord,
  listBotImConnections,
  listBotImConnectionsForBot,
  readBotImConnection,
  removeBotImConnectionRecord,
  secretKeyPrefixFor,
  setBotImConnectionGroupActivation,
  updateBotImConnectionRecord,
} from '../botImConnectionStore';

const file = () => path.join(h.root, 'owners', h.owner, 'bot-im-connections.json');

describe('bot im connection store', () => {
  beforeEach(() => {
    h.root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-im-connections-'));
    h.owner = 'owner-a';
  });

  afterEach(() => {
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('starts empty and never exposes credentials in the record file', async () => {
    expect(listBotImConnections()).toEqual([]);
    const record = await addBotImConnectionRecord(
      { botId: 'bot-a', channel: 'telegram' },
      { now: () => 10, id: () => 'a1b2c3d4e5f6' },
    );
    expect(record).toEqual({
      id: 'a1b2c3d4e5f6',
      botId: 'bot-a',
      channel: 'telegram',
      createdAt: 10,
      botContextId: null,
    });
    const raw = fs.readFileSync(file(), 'utf8');
    expect(raw).not.toMatch(/token|secret/i);
    expect(secretKeyPrefixFor(record.id)).toBe('bot-im-a1b2c3d4e5f6-');
    expect(secretKeyPrefixFor(record.id)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('keeps the Feishu service, records the platform id once connected, and lists per bot', async () => {
    await addBotImConnectionRecord(
      { botId: 'bot-a', channel: 'feishu', service: 'lark' },
      { now: () => 1, id: () => 'aaaaaaaaaaaa' },
    );
    await addBotImConnectionRecord(
      { botId: 'bot-b', channel: 'telegram' },
      { now: () => 2, id: () => 'bbbbbbbbbbbb' },
    );
    expect(readBotImConnection('aaaaaaaaaaaa')?.service).toBe('lark');
    const updated = await updateBotImConnectionRecord('aaaaaaaaaaaa', { botContextId: 'cli_x' });
    expect(updated?.botContextId).toBe('cli_x');
    expect(listBotImConnectionsForBot('bot-a').map((r) => r.id)).toEqual(['aaaaaaaaaaaa']);
    expect(listBotImConnections().map((r) => r.id)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  });

  it('removes a record and ignores ids that do not match the id shape', async () => {
    await addBotImConnectionRecord({ botId: 'bot-a', channel: 'telegram' }, { id: () => 'cccccccccccc' });
    expect(await removeBotImConnectionRecord('not-an-id')).toBeNull();
    expect(await removeBotImConnectionRecord('cccccccccccc')).toMatchObject({ id: 'cccccccccccc' });
    expect(listBotImConnections()).toEqual([]);
    expect(readBotImConnection('cccccccccccc')).toBeNull();
  });

  it('drops malformed entries written by hand', async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(
      file(),
      JSON.stringify({
        connections: {
          dddddddddddd: { botId: 'bot-a', channel: 'telegram', createdAt: 5, botContextId: null },
          'bad id': { botId: 'bot-a', channel: 'telegram' },
          eeeeeeeeeeee: { botId: 'bot-a', channel: 'slack' },
        },
      }),
    );
    expect(listBotImConnections().map((r) => r.id)).toEqual(['dddddddddddd']);
  });

  it('keeps per-group activation on the record and drops anything but chatId → always', async () => {
    await addBotImConnectionRecord({ botId: 'bot-a', channel: 'telegram' }, { id: () => '111111111111' });
    expect((await setBotImConnectionGroupActivation('111111111111', '-1001', 'always'))?.groupActivation).toEqual({
      '-1001': 'always',
    });
    await setBotImConnectionGroupActivation('111111111111', '-1002', 'always');
    expect(readBotImConnection('111111111111')?.groupActivation).toEqual({ '-1001': 'always', '-1002': 'always' });
    // mention 是缺省: 清掉这一项, 全空时整个字段不落盘。
    await setBotImConnectionGroupActivation('111111111111', '-1001', 'mention');
    expect(readBotImConnection('111111111111')?.groupActivation).toEqual({ '-1002': 'always' });
    await setBotImConnectionGroupActivation('111111111111', '-1002', 'mention');
    expect(readBotImConnection('111111111111')?.groupActivation).toBeUndefined();
    expect(await setBotImConnectionGroupActivation('nope', '-1', 'always')).toBeNull();

    fs.writeFileSync(
      file(),
      JSON.stringify({
        connections: {
          '222222222222': {
            botId: 'bot-a',
            channel: 'telegram',
            createdAt: 5,
            botContextId: '9',
            groupActivation: { '-1': 'always', '-2': 'mention', abc: 'always', '-3': 'nope' },
          },
        },
      }),
    );
    expect(readBotImConnection('222222222222')?.groupActivation).toEqual({ '-1': 'always' });
  });

  it('is scoped per data owner', async () => {
    await addBotImConnectionRecord({ botId: 'bot-a', channel: 'telegram' }, { id: () => 'ffffffffffff' });
    h.owner = 'owner-b';
    expect(listBotImConnections()).toEqual([]);
  });
});
