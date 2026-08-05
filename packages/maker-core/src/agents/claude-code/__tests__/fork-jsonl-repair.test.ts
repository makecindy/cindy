import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  repairForkedClaudeJsonlText,
  repairForkedClaudeSessionJsonl,
} from '../fork-jsonl-repair.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-fork-jsonl-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

describe('repairForkedClaudeJsonlText', () => {
  it('remaps compact metadata uuid references from the source session to the forked session', () => {
    const headOld = '11111111-1111-4111-8111-111111111111';
    const headNew = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const anchorOld = '22222222-2222-4222-8222-222222222222';
    const anchorNew = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const tailOld = '33333333-3333-4333-8333-333333333333';
    const tailNew = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const progressOld = '44444444-4444-4444-8444-444444444444';
    const boundaryOld = '55555555-5555-4555-8555-555555555555';
    const boundaryNew = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    const text = [
      line({ type: 'user', uuid: headNew, sessionId: 'fork', forkedFrom: { sessionId: 'source', messageUuid: headOld } }),
      line({ type: 'user', uuid: anchorNew, sessionId: 'fork', forkedFrom: { sessionId: 'source', messageUuid: anchorOld } }),
      line({ type: 'assistant', uuid: tailNew, sessionId: 'fork', parentUuid: anchorNew, forkedFrom: { sessionId: 'source', messageUuid: tailOld } }),
      line({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: boundaryNew,
        sessionId: 'fork',
        forkedFrom: { sessionId: 'source', messageUuid: boundaryOld },
        compactMetadata: {
          trigger: 'manual',
          preTokens: 900000,
          postTokens: 8000,
          preservedSegment: {
            headUuid: headOld,
            anchorUuid: anchorOld,
            tailUuid: tailOld,
          },
          preservedMessages: {
            anchorUuid: anchorOld,
            uuids: [headOld, anchorOld, tailOld],
            allUuids: [headOld, progressOld, anchorOld, tailOld],
          },
        },
      }),
    ].join('\n') + '\n';

    const result = repairForkedClaudeJsonlText(text);
    const repaired = result.text
      .trim()
      .split('\n')
      .map((raw) => JSON.parse(raw) as Record<string, unknown>);
    const compact = repaired.at(-1) as {
      compactMetadata: {
        preservedSegment: Record<string, string>;
        preservedMessages: Record<string, string | string[]>;
      };
    };

    expect(result.changed).toBe(true);
    expect(result.uuidMap).toEqual(new Map([
      [headOld, headNew],
      [anchorOld, anchorNew],
      [tailOld, tailNew],
      [boundaryOld, boundaryNew],
    ]));
    expect(result.compactBoundaryCount).toBe(1);
    expect(result.initialContextTokens).toBe(8000);
    expect(result.remappedCompactRefCount).toBe(10);
    expect(result.unresolvedCompactRefCount).toBe(1);
    expect(result.invalidPreservedSegmentRefCount).toBe(0);
    expect(compact.compactMetadata.preservedSegment).toEqual({
      headUuid: headNew,
      anchorUuid: anchorNew,
      tailUuid: tailNew,
    });
    expect(compact.compactMetadata.preservedMessages).toEqual({
      anchorUuid: anchorNew,
      uuids: [headNew, anchorNew, tailNew],
      allUuids: [headNew, progressOld, anchorNew, tailNew],
    });
  });

  it('clears invalid compact preserved metadata when a compact anchor cannot be mapped', () => {
    const text = [
      line({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sessionId: 'fork',
        compactMetadata: {
          trigger: 'manual',
          postTokens: 123,
          preservedSegment: {
            headUuid: '11111111-1111-4111-8111-111111111111',
            anchorUuid: '22222222-2222-4222-8222-222222222222',
            tailUuid: '33333333-3333-4333-8333-333333333333',
          },
          preservedMessages: {
            uuids: ['11111111-1111-4111-8111-111111111111'],
          },
        },
      }),
    ].join('\n') + '\n';

    const result = repairForkedClaudeJsonlText(text);
    const repaired = JSON.parse(result.text.trimEnd()) as {
      compactMetadata: Record<string, unknown>;
    };

    expect(result.changed).toBe(true);
    expect(result.initialContextTokens).toBe(123);
    expect(result.invalidPreservedSegmentRefCount).toBe(0);
    expect(result.clearedInvalidPreservedSegmentRefCount).toBe(3);
    expect(result.compactMetadataRepairs).toEqual([{
      boundaryUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      invalidRefs: [
        { field: 'headUuid', ref: '11111111-1111-4111-8111-111111111111' },
        { field: 'anchorUuid', ref: '22222222-2222-4222-8222-222222222222' },
        { field: 'tailUuid', ref: '33333333-3333-4333-8333-333333333333' },
      ],
      removedPreservedSegment: true,
      removedPreservedMessages: true,
    }]);
    expect(repaired.compactMetadata).toEqual({
      trigger: 'manual',
      postTokens: 123,
    });
  });

  it('estimates the initial context snapshot from the latest usage or compact boundary', () => {
    const text = [
      line({
        type: 'assistant',
        uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 30,
            output_tokens: 50,
          },
        },
      }),
      line({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        compactMetadata: {
          preTokens: 330,
          postTokens: 40,
        },
      }),
      line({ type: 'user', uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
      line({
        type: 'assistant',
        uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        message: {
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 8,
            output_tokens: 10,
          },
        },
      }),
    ].join('\n') + '\n';

    const result = repairForkedClaudeJsonlText(text);

    expect(result.initialContextTokens).toBe(53);
  });

  it('does not carry pre-compact usage across a compact boundary without post tokens', () => {
    const text = [
      line({
        type: 'assistant',
        uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 200_000,
            cache_creation_input_tokens: 30,
            output_tokens: 50,
          },
        },
      }),
      line({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        compactMetadata: {
          trigger: 'manual',
          preTokens: 200_130,
        },
      }),
      line({ type: 'user', uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    ].join('\n') + '\n';

    const result = repairForkedClaudeJsonlText(text);

    expect(result.initialContextTokens).toBe(0);
  });

  it('throws a line-numbered error for malformed JSONL', () => {
    const text = [
      line({ type: 'user', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      '{bad json',
    ].join('\n') + '\n';

    expect(() => repairForkedClaudeJsonlText(text)).toThrow(
      'Fork JSONL parse error at line 2: {bad json',
    );
  });
});

describe('repairForkedClaudeSessionJsonl', () => {
  it('finds the forked JSONL under the Claude projects root and persists compact metadata remaps', async () => {
    const projectsRoot = await makeTempDir();
    const workingDir = path.join(projectsRoot, 'repo');
    const projectDir = path.join(projectsRoot, workingDir.replace(/[^a-zA-Z0-9]/g, '-'));
    const sessionId = '99999999-9999-4999-8999-999999999999';
    const oldUuid = '11111111-1111-4111-8111-111111111111';
    const newUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      jsonlPath,
      [
        line({
          type: 'user',
          uuid: newUuid,
          sessionId,
          forkedFrom: { sessionId: 'source', messageUuid: oldUuid },
        }),
        line({
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          sessionId,
          compactMetadata: {
            preservedSegment: {
              headUuid: oldUuid,
              anchorUuid: oldUuid,
              tailUuid: oldUuid,
            },
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const result = await repairForkedClaudeSessionJsonl({ sessionId, workingDir, projectsRoot });
    const repaired = await fs.readFile(jsonlPath, 'utf8');

    expect(result.filePath).toBe(jsonlPath);
    expect(result.uuidMap).toEqual(new Map([[oldUuid, newUuid]]));
    expect(result.invalidPreservedSegmentRefCount).toBe(0);
    expect(repaired).toContain(`"headUuid":"${newUuid}"`);
  });

  it('uses the direct workingDir project path before scanning sibling project dirs', async () => {
    const projectsRoot = await makeTempDir();
    const workingDir = path.join(projectsRoot, 'repo');
    const directProjectDir = path.join(projectsRoot, workingDir.replace(/[^a-zA-Z0-9]/g, '-'));
    const otherProjectDir = path.join(projectsRoot, 'other-project');
    const sessionId = '99999999-9999-4999-8999-999999999999';
    await fs.mkdir(directProjectDir, { recursive: true });
    await fs.mkdir(otherProjectDir, { recursive: true });
    await fs.writeFile(
      path.join(directProjectDir, `${sessionId}.jsonl`),
      line({
        type: 'user',
        uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sessionId,
      }) + '\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(otherProjectDir, `${sessionId}.jsonl`),
      line({
        type: 'user',
        uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        sessionId,
      }) + '\n',
      'utf8',
    );

    const result = await repairForkedClaudeSessionJsonl({ sessionId, workingDir, projectsRoot });

    expect(result.filePath).toBe(path.join(directProjectDir, `${sessionId}.jsonl`));
  });

  it('backs up and repairs a first-line compact boundary with dangling preservedSegment refs', async () => {
    const projectsRoot = await makeTempDir();
    const workingDir = path.join(projectsRoot, 'repo');
    const projectDir = path.join(projectsRoot, workingDir.replace(/[^a-zA-Z0-9]/g, '-'));
    const sessionId = '99999999-9999-4999-8999-999999999999';
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.mkdir(projectDir, { recursive: true });
    const original = [
      line({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sessionId,
        compactMetadata: {
          trigger: 'manual',
          postTokens: 321,
          preservedSegment: {
            headUuid: '11111111-1111-4111-8111-111111111111',
            anchorUuid: '22222222-2222-4222-8222-222222222222',
            tailUuid: '33333333-3333-4333-8333-333333333333',
          },
          preservedMessages: {
            uuids: ['11111111-1111-4111-8111-111111111111'],
          },
        },
      }),
      line({ type: 'user', uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sessionId }),
    ].join('\n') + '\n';
    await fs.writeFile(jsonlPath, original, 'utf8');

    const result = await repairForkedClaudeSessionJsonl({ sessionId, workingDir, projectsRoot });
    const repaired = await fs.readFile(jsonlPath, 'utf8');
    const repairedEntries = repaired.trimEnd().split('\n').map((raw) => JSON.parse(raw) as Record<string, unknown>);
    const compact = repairedEntries[0] as Record<string, unknown> & { compactMetadata: Record<string, unknown> };

    expect(result.changed).toBe(true);
    expect(result.backupPath).toMatch(`${sessionId}.jsonl.bak.`);
    await expect(fs.readFile(result.backupPath as string, 'utf8')).resolves.toBe(original);
    expect(repairedEntries).toHaveLength(2);
    expect(compact.type).toBe('system');
    expect(compact.subtype).toBe('compact_boundary');
    expect(compact.compactMetadata).toEqual({
      trigger: 'manual',
      postTokens: 321,
    });
    expect(result.invalidPreservedSegmentRefCount).toBe(0);
    expect(result.clearedInvalidPreservedSegmentRefCount).toBe(3);
  });
});

describe('repairForkedClaudeSessionJsonl 权限保留(Copilot review)', () => {
  it('备份沿用源转录 mode,0600 不被放宽为 0644', async () => {
    const fsPromises = await import('node:fs/promises');
    const projectsRoot = await makeTempDir();
    const workingDir = path.join(projectsRoot, 'repo');
    const projectDir = path.join(projectsRoot, workingDir.replace(/[^a-zA-Z0-9]/g, '-'));
    const sessionId = '99999999-9999-4999-8999-999999999998';
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.mkdir(projectDir, { recursive: true });
    // 构造一个带 compact boundary 需要修复的转录
    const oldUuid = '11111111-1111-4111-8111-111111111112';
    const newUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8';
    await fs.writeFile(
      jsonlPath,
      [
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          uuid: newUuid,
          sessionId,
          compactMetadata: {
            postTokens: 100,
            preservedSegment: { headUuid: oldUuid, anchorUuid: oldUuid, tailUuid: oldUuid },
          },
        }),
        line({ type: 'user', uuid: newUuid, sessionId }),
      ].join('\n') + '\n',
      { encoding: 'utf8', mode: 0o600 },
    );
    const beforeMode = (await fsPromises.stat(jsonlPath)).mode & 0o777;

    const result = await repairForkedClaudeSessionJsonl({ sessionId, workingDir, projectsRoot });
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    // 不变量:备份与修复后文件权限与原文一致(Windows 恒 0o666 → 恒等;
    // POSIX 0600 不被放宽)。
    const bakMode = (await fsPromises.stat(result.backupPath!)).mode & 0o777;
    expect(bakMode).toBe(beforeMode);
  });
});
