import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { createWechatMcpServer } from '../cindy_wechatMcpServer';

describe('cindy_wechat proactive routing', () => {
  it('sends only to the host-resolved known peer', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, messageId: 'msg-1' }));
    const server = createWechatMcpServer({
      getActivePeerIdForSession: () => null,
      getMostRecentPeerId: () => 'peer-history',
      getPeerId: () => 'peer-session',
      sendMessage,
      sendFile: vi.fn(),
    });
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'wechat-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    try {
      const result = await client.callTool({
        name: 'call_tool',
        arguments: { name: 'send_message_to_user', args: { text: 'hello' } },
      });
      expect(sendMessage).toHaveBeenCalledWith('peer-session', 'hello');
      expect(JSON.stringify(result)).toContain('msg-1');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('fails closed when no peer has ever been observed', async () => {
    const sendMessage = vi.fn();
    const server = createWechatMcpServer({
      getActivePeerIdForSession: () => null,
      getMostRecentPeerId: () => null,
      getPeerId: () => null,
      sendMessage,
      sendFile: vi.fn(),
    });
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'wechat-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    try {
      const result = await client.callTool({
        name: 'call_tool',
        arguments: { name: 'send_message_to_user', args: { text: 'hello' } },
      });
      expect(JSON.stringify(result)).toContain('NO_PEER_CONTEXT');
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('sends a working-directory file only to the host-resolved peer', async () => {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-wechat-mcp-'));
    const absPath = path.join(workingDir, 'preview.png');
    await fs.writeFile(absPath, 'png-bytes');
    const sendFile = vi.fn(async () => ({ ok: true, messageId: 'media-1' }));
    const server = createWechatMcpServer({
      getActivePeerIdForSession: () => null,
      getMostRecentPeerId: () => 'peer-history',
      getPeerId: () => 'peer-session',
      sendMessage: vi.fn(),
      sendFile,
      workingDir,
    });
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'wechat-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    try {
      const call = await client.callTool({
        name: 'call_tool',
        arguments: {
          name: 'send_file_to_user',
          args: { absPath, displayName: 'result.png' },
        },
      });
      expect(sendFile).toHaveBeenCalledWith('peer-session', await fs.realpath(absPath), 'result.png');
      expect(JSON.stringify(call)).toContain('media-1');
    } finally {
      await client.close();
      await server.close();
      await fs.rm(workingDir, { recursive: true, force: true });
    }
  });

  it('rejects files outside the current working directory', async () => {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-wechat-workdir-'));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-wechat-outside-'));
    const outsidePath = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(outsidePath, 'not-for-wechat');
    const sendFile = vi.fn();
    const server = createWechatMcpServer({
      getActivePeerIdForSession: () => null,
      getMostRecentPeerId: () => 'peer-history',
      getPeerId: () => 'peer-session',
      sendMessage: vi.fn(),
      sendFile,
      workingDir,
    });
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'wechat-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    try {
      const call = await client.callTool({
        name: 'call_tool',
        arguments: { name: 'send_file_to_user', args: { absPath: outsidePath } },
      });
      expect(JSON.stringify(call)).toContain('PATH_OUT_OF_BOUNDS');
      expect(sendFile).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
      await Promise.all([
        fs.rm(workingDir, { recursive: true, force: true }),
        fs.rm(outsideDir, { recursive: true, force: true }),
      ]);
    }
  });
});
