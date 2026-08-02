import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { analyzeSkillUsageTranscript, hashSkillContent } from '../usageAnalyzer';

const claudeSessionId = '15356275-b340-401f-abd1-3bc2bd4824c5';
const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function claudeLine(value: Record<string, unknown>): string {
  return JSON.stringify({
    sessionId: claudeSessionId,
    timestamp: '2026-06-18T01:00:00.000Z',
    isSidechain: false,
    userType: 'external',
    entrypoint: 'sdk-ts',
    cwd: 'D:\\agent-workspaces\\sample-project',
    ...value,
  });
}

function codexLine(value: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: '2026-06-18T01:00:00.000Z',
    ...value,
  });
}

function createSkillDir(skillName: string, skillDocument: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `xdt-skill-${skillName}-`));
  const skillDir = path.join(root, skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillDocument);
  tmpRoots.push(root);
  return skillDir;
}

function skillDocument(skillName: string, body: string): string {
  return [
    '---',
    `name: ${skillName}`,
    `description: ${skillName} description`,
    '---',
    `# ${skillName}`,
    '',
    body,
  ].join('\n');
}

function claudeSkillInjection(skillDir: string, document: string, extraLines: string[] = []): string {
  return [
    `Base directory for this skill: ${skillDir}`,
    '',
    document,
    ...(extraLines.length > 0 ? ['', ...extraLines] : []),
  ].join('\n');
}

function codexSkillInjection(skillName: string, skillDir: string, document: string): string {
  return [
    `<skill name="${skillName}">`,
    `Base directory for this skill: ${skillDir}`,
    '',
    document,
    '</skill>',
  ].join('\n');
}

function codexToolCall(callId: string, command: string): string {
  return codexLine({
    type: 'response_item',
    payload: {
      type: 'function_call',
      call_id: callId,
      name: 'functions.shell_command',
      arguments: JSON.stringify({ command }),
    },
  });
}

function codexToolOutput(callId: string, output = 'Exit code: 0\nOK'): string {
  return codexLine({
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output,
    },
  });
}

describe('analyzeSkillUsageTranscript', () => {
  it('hashes injected skill content as the observed document version', () => {
    const document = skillDocument('parallel-web-search', 'Use parallel-cli for web search.');
    const skillDir = createSkillDir('parallel-web-search', document);
    const first = analyzeSkillUsageTranscript({
      agentKind: 'claude-code',
      sessionId: 'claude-local',
      sdkSessionId: claudeSessionId,
      rawFilePath: 'D:\\agent-transcripts\\claude\\session-a.jsonl',
      lines: [
        claudeLine({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: claudeSkillInjection(skillDir, document, [
                  'ARGUMENTS:',
                  'Search the web for: canonical version hash',
                  'Run: parallel-cli search "canonical version hash"',
                ]),
              },
            ],
          },
        }),
      ],
    });
    const second = analyzeSkillUsageTranscript({
      agentKind: 'claude-code',
      sessionId: 'claude-local',
      sdkSessionId: claudeSessionId,
      rawFilePath: 'D:\\agent-transcripts\\claude\\session-b.jsonl',
      lines: [
        claudeLine({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: claudeSkillInjection(skillDir, document, [
                  'ARGUMENTS:',
                  'Search the web for: injected instance hash',
                  'Run: parallel-cli search "injected instance hash"',
                ]),
              },
            ],
          },
        }),
      ],
    });

    expect(first.exposures).toHaveLength(1);
    expect(second.exposures).toHaveLength(1);
    expect(first.exposures[0]).toMatchObject({
      skillName: 'parallel-web-search',
      skillPath: skillDir,
      source: 'claude_skill_content_injection',
      skillDocumentHash: hashSkillContent(document),
      documentHashSource: 'transcript_skill_content',
    });
    expect(second.exposures[0].skillDocumentHash).toBe(first.exposures[0].skillDocumentHash);
    expect(second.exposures[0].exposureContentHash).not.toBe(first.exposures[0].exposureContentHash);
  });

  it('does not rewrite historical injection versions from the current local SKILL.md', () => {
    const historicalDocument = skillDocument('word-doc', 'Use mammoth for legacy Word extraction.');
    const currentDocument = skillDocument('word-doc', 'Use markitdown for current Word extraction.');
    const skillDir = createSkillDir('word-doc', currentDocument);
    const result = analyzeSkillUsageTranscript({
      agentKind: 'codex',
      sessionId: 'codex-local',
      sdkSessionId: '019ed673-c614-7ac1-8d22-c0ddc81f9cf0',
      rawFilePath: '/agent-transcripts/codex/2026/06/18/historical-version.jsonl',
      lines: [
        codexLine({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: codexSkillInjection('word-doc', skillDir, historicalDocument) }],
          },
        }),
      ],
    });

    expect(result.exposures).toHaveLength(1);
    expect(result.exposures[0]).toMatchObject({
      skillName: 'word-doc',
      skillPath: skillDir,
      source: 'codex_skill_injection',
      skillDocumentHash: hashSkillContent(historicalDocument),
      documentHashSource: 'transcript_skill_content',
    });
    expect(result.exposures[0].skillDocumentHash).not.toBe(hashSkillContent(currentDocument));
  });

  it('hashes injected exposures even when the local SKILL.md is unavailable', () => {
    const missingSkillDir = path.join(os.tmpdir(), 'xdt-missing-skill', 'word-doc');
    const document = skillDocument('word-doc', 'Use python-docx for Word files.');
    const result = analyzeSkillUsageTranscript({
      agentKind: 'codex',
      sessionId: 'codex-local',
      sdkSessionId: '019ed673-c614-7ac1-8d22-c0ddc81f9cf0',
      rawFilePath: '/agent-transcripts/codex/2026/06/18/rollout.jsonl',
      lines: [
        codexLine({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: codexSkillInjection('word-doc', missingSkillDir, document) }],
          },
        }),
      ],
    });

    expect(result.exposures).toHaveLength(1);
    expect(result.exposures[0]).toMatchObject({
      skillName: 'word-doc',
      skillPath: missingSkillDir,
      source: 'codex_skill_injection',
      skillDocumentHash: hashSkillContent(document),
      documentHashSource: 'transcript_skill_content',
    });
    expect(result.exposures[0].exposureContentHash).toBe(hashSkillContent(document));
  });

  it('uses SKILL.md file-read content as the document hash source', () => {
    const document = skillDocument('code-discipline', 'Use local patterns before editing.');
    const result = analyzeSkillUsageTranscript({
      agentKind: 'claude-code',
      sessionId: 'claude-local',
      sdkSessionId: claudeSessionId,
      rawFilePath: 'D:\\agent-transcripts\\claude\\subagents\\agent.jsonl',
      lines: [
        claudeLine({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_read_skill',
                name: 'Read',
                input: { file_path: 'D:\\agent-skill-roots\\claude\\code-discipline\\SKILL.md' },
              },
            ],
          },
        }),
        claudeLine({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_read_skill',
                content: [
                  '1\t---',
                  '2\tname: code-discipline',
                  '3\tdescription: code-discipline description',
                  '4\t---',
                  '5\t# code-discipline',
                  '6\t',
                  '7\tUse local patterns before editing.',
                ].join('\n'),
              },
            ],
          },
        }),
      ],
    });

    expect(result.exposures).toHaveLength(1);
    expect(result.exposures[0]).toMatchObject({
      skillName: 'code-discipline',
      skillPath: 'D:\\agent-skill-roots\\claude\\code-discipline',
      source: 'claude_skill_file_read',
      toolUseId: 'toolu_read_skill',
      skillDocumentHash: hashSkillContent(document),
      exposureContentHash: hashSkillContent(document),
      documentHashSource: 'transcript_file_read',
    });
  });

  it('does not mis-parse a Pi transcript as Codex (Pi is explicitly skipped, no exposures)', () => {
    // Pi 原生转录格式与 Codex 不同;分析器不得把 agentKind:'pi' 回落到 Codex 解析器,
    // 否则会静默产出错误归属的 exposure。喂一条 Codex 会识别为技能注入的行,agentKind
    // 设为 pi → 必须 0 exposure(显式跳过,而非误当 Codex)。
    const document = skillDocument('code-discipline', 'Use local patterns before editing.');
    const result = analyzeSkillUsageTranscript({
      agentKind: 'pi',
      sessionId: 'pi-local',
      sdkSessionId: '019ed673-c614-7ac1-8d22-c0ddc81f9cf0',
      rawFilePath: '/agent-transcripts/pi/2026/06/18/skip.jsonl',
      lines: [
        codexLine({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: codexSkillInjection('code-discipline', '/agent-skill-roots/pi/code-discipline', document),
              },
            ],
          },
        }),
      ],
    });
    expect(result.exposures).toEqual([]);
  });

  it('counts repeated tool calls only inside the active exposure window', () => {
    const firstDocument = skillDocument('code-discipline', 'Use local patterns before editing.');
    const secondDocument = skillDocument('systematic-debugging', 'Find the root cause first.');
    const result = analyzeSkillUsageTranscript({
      agentKind: 'codex',
      sessionId: 'codex-local',
      sdkSessionId: '019ed673-c614-7ac1-8d22-c0ddc81f9cf0',
      rawFilePath: '/agent-transcripts/codex/2026/06/18/repeated-scope.jsonl',
      lines: [
        codexLine({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: codexSkillInjection('code-discipline', '/agent-skill-roots/codex/code-discipline', firstDocument),
              },
            ],
          },
        }),
        codexToolCall('call_first_test', 'pnpm test'),
        codexToolOutput('call_first_test'),
        codexLine({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: codexSkillInjection(
                  'systematic-debugging',
                  '/agent-skill-roots/codex/systematic-debugging',
                  secondDocument,
                ),
              },
            ],
          },
        }),
        codexToolCall('call_second_test', 'pnpm test'),
        codexToolOutput('call_second_test'),
        codexToolCall('call_second_test_repeat', 'pnpm test'),
        codexToolOutput('call_second_test_repeat'),
      ],
    });

    expect(result.exposures).toHaveLength(2);
    expect(result.exposures[0].observation).toMatchObject({
      toolCallCount: 1,
      repeatedToolCallCount: 0,
      commandCallCount: 1,
    });
    expect(result.exposures[1].observation).toMatchObject({
      toolCallCount: 2,
      repeatedToolCallCount: 1,
      commandCallCount: 2,
    });
  });

  it('attributes tool observations to every active skill exposure in the same turn', () => {
    const firstDocument = skillDocument('code-discipline', 'Use local patterns before editing.');
    const secondDocument = skillDocument('systematic-debugging', 'Find the root cause first.');
    const firstSkillDir = createSkillDir('code-discipline', firstDocument);
    const secondSkillDir = createSkillDir('systematic-debugging', secondDocument);
    const result = analyzeSkillUsageTranscript({
      agentKind: 'claude-code',
      sessionId: 'claude-local',
      sdkSessionId: claudeSessionId,
      rawFilePath: 'D:\\agent-transcripts\\claude\\session-multi-skill.jsonl',
      lines: [
        claudeLine({
          type: 'system',
          attachment: {
            type: 'invoked_skills',
            skills: [
              { name: 'code-discipline', content: claudeSkillInjection(firstSkillDir, firstDocument) },
              { name: 'systematic-debugging', content: claudeSkillInjection(secondSkillDir, secondDocument) },
            ],
          },
        }),
        claudeLine({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_test',
                name: 'Bash',
                input: { command: 'pnpm test' },
              },
            ],
          },
        }),
        claudeLine({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_test',
                content: 'Exit code: 1\nOutput:\nfailed',
              },
            ],
          },
        }),
      ],
    });

    expect(result.exposures).toHaveLength(2);
    for (const exposure of result.exposures) {
      expect(exposure.observation).toMatchObject({
        toolCallCount: 1,
        repeatedToolCallCount: 0,
        toolErrorCount: 1,
        commandCallCount: 1,
        commandFailureCount: 1,
      });
    }
  });

  it('counts a tool result once when the transcript repeats it', () => {
    const document = skillDocument('code-discipline', 'Use local patterns before editing.');
    const result = analyzeSkillUsageTranscript({
      agentKind: 'codex',
      sessionId: 'codex-local',
      sdkSessionId: '019ed673-c614-7ac1-8d22-c0ddc81f9cf0',
      rawFilePath: '/agent-transcripts/codex/2026/06/18/repeated-result.jsonl',
      lines: [
        codexLine({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: codexSkillInjection('code-discipline', '/agent-skill-roots/codex/code-discipline', document),
              },
            ],
          },
        }),
        codexToolCall('call_failed_test', 'pnpm test'),
        codexToolOutput('call_failed_test', 'Exit code: 1\nOutput:\nfailed'),
        codexToolOutput('call_failed_test', 'Exit code: 1\nOutput:\nfailed'),
      ],
    });

    expect(result.exposures).toHaveLength(1);
    expect(result.exposures[0].observation).toMatchObject({
      toolCallCount: 1,
      toolErrorCount: 1,
      commandCallCount: 1,
      commandFailureCount: 1,
    });
  });

  it('stops attributing Codex tool calls after the next user turn starts', () => {
    const document = skillDocument('code-discipline', 'Use local patterns before editing.');
    const result = analyzeSkillUsageTranscript({
      agentKind: 'codex',
      sessionId: 'codex-local',
      sdkSessionId: '019ed673-c614-7ac1-8d22-c0ddc81f9cf0',
      rawFilePath: '/agent-transcripts/codex/2026/06/18/turn-boundary.jsonl',
      lines: [
        codexLine({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: codexSkillInjection('code-discipline', '/agent-skill-roots/codex/code-discipline', document),
              },
            ],
          },
        }),
        codexToolCall('call_in_turn', 'pnpm test'),
        codexToolOutput('call_in_turn'),
        codexLine({
          type: 'event_msg',
          payload: { type: 'user_message', message: '继续改另一个问题' },
        }),
        codexToolCall('call_next_turn', 'pnpm test'),
        codexToolOutput('call_next_turn'),
      ],
    });

    expect(result.exposures).toHaveLength(1);
    expect(result.exposures[0].observation).toMatchObject({
      toolCallCount: 1,
      commandCallCount: 1,
    });
  });
});
