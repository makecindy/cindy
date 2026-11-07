import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { analyzeSkillUsageTranscript, hashSkillContent, type SkillUsageAgentKind } from '../usageAnalyzer';

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

  it('does not mis-parse Codex response records as native Pi entries', () => {
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

function analyzeLines(agentKind: SkillUsageAgentKind, lines: string[]) {
  return analyzeSkillUsageTranscript({
    agentKind, lines, sessionId: `${agentKind}-test`, sdkSessionId: `${agentKind}-native`,
    rawFilePath: path.join(os.tmpdir(), `${agentKind}-usage-test.jsonl`),
  }).exposures;
}

function claudeRead(callId: string, skillName: string): string {
  return claudeLine({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: callId, name: 'Read', input: { file_path: `/skills/${skillName}/SKILL.md` } },
  ] } });
}

function claudeResult(callId: string, content: string, isError = false): string {
  return claudeLine({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: callId, content, is_error: isError },
  ] } });
}

function codexInjection(skillName: string): string {
  return codexLine({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_text', text: codexSkillInjection(skillName, `/skills/${skillName}`, skillDocument(skillName, 'Observed rules.')) },
  ] } });
}

function codexFunction(callId: string, name: string, args: Record<string, unknown>): string {
  return codexLine({ type: 'response_item', payload: {
    type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args),
  } });
}

function piEntry(id: string, parentId: string | null, message: Record<string, unknown>): string {
  return JSON.stringify({ type: 'message', id, parentId, timestamp: '2026-06-18T01:00:00.000Z', message });
}

function piCall(id: string, parentId: string, callId: string, name: string, args: Record<string, unknown>): string {
  return piEntry(id, parentId, { role: 'assistant', content: [{ type: 'toolCall', id: callId, name, arguments: args }] });
}

function piResult(id: string, parentId: string, callId: string, text: string, isError = false): string {
  return piEntry(id, parentId, { role: 'toolResult', toolCallId: callId, content: [{ type: 'text', text }], isError });
}

describe('native user turns', () => {
  it.each(['claude-code', 'codex', 'pi'] as const)('counts skill reads requested for diagnosis in %s', (agentKind) => {
    const userMessage = '请根据实际执行记录，诊断 Skill "target"。';
    const document = skillDocument('target', 'Target rules.');
    const lines: Record<SkillUsageAgentKind, string[]> = {
      'claude-code': [
        claudeLine({ type: 'user', message: { content: userMessage } }),
        claudeRead('read', 'target'),
        claudeResult('read', document),
      ],
      codex: [
        codexLine({ type: 'event_msg', payload: { type: 'user_message', message: userMessage } }),
        codexFunction('read', 'functions.exec_command', { cmd: "cat '/skills/target/SKILL.md'" }),
        codexToolOutput('read', document),
      ],
      pi: [
        piEntry('user', null, { role: 'user', content: userMessage }),
        piCall('call', 'user', 'read', 'read', { path: '/skills/target/SKILL.md' }),
        piResult('result', 'call', 'read', document),
      ],
    };
    const exposures = analyzeLines(agentKind, lines[agentKind]);
    expect(exposures).toHaveLength(1);
    expect(exposures[0]).toMatchObject({ skillName: 'target', skillDocumentHash: hashSkillContent(document) });
  });

  it('keeps Claude observations across a compact summary', () => {
    const command = (id: string) => claudeLine({ type: 'assistant', message: { content: [
      { type: 'tool_use', id, name: 'Bash', input: { command: 'run-check' } },
    ] } });
    const target = skillDocument('target', 'Target rules.');
    const exposures = analyzeLines('claude-code', [
      claudeLine({ type: 'user', message: { content: 'Use other for the current task.' } }),
      claudeRead('other-read', 'other'),
      claudeResult('other-read', skillDocument('other', 'Other rules.')),
      command('before-summary'),
      claudeLine({ type: 'user', isCompactSummary: true, message: { content: 'Summary of earlier work.' } }),
      command('after-summary'),
      claudeLine({ type: 'user', message: { content: 'Use target for the next task.' } }),
      claudeRead('real-read', 'target'),
      claudeResult('real-read', target),
      command('new-turn'),
      claudeResult('before-summary', 'failed', true),
    ]);
    expect(exposures.map(item => item.skillName)).toEqual(['other', 'target']);
    expect(exposures[0].observation).toMatchObject({ toolCallCount: 2, repeatedToolCallCount: 1, toolErrorCount: 1 });
    expect(exposures[1]).toMatchObject({ rawLineNo: 9 });
    expect(exposures[1].observation).toMatchObject({ toolCallCount: 1, repeatedToolCallCount: 0, toolErrorCount: 0 });
  });

  it('counts a repeated tool once for every skill in the same load group', () => {
    const command = (id: string) => claudeLine({ type: 'assistant', message: { content: [
      { type: 'tool_use', id, name: 'Bash', input: { command: 'run-check' } },
    ] } });
    const exposures = analyzeLines('claude-code', [
      claudeLine({ type: 'system', attachment: { type: 'invoked_skills', skills: ['first', 'second'].map(name => ({
        name, content: claudeSkillInjection(`/skills/${name}`, skillDocument(name, 'Rules.')),
      })) } }),
      command('first-command'),
      command('repeated-command'),
      claudeRead('next-read', 'next'),
      claudeResult('next-read', skillDocument('next', 'New rules.')),
      command('next-group-command'),
    ]);
    expect(exposures.map(item => item.observation.repeatedToolCallCount)).toEqual([1, 1, 0]);
    expect(exposures.map(item => item.observation.toolCallCount)).toEqual([2, 2, 1]);
  });

  it('matches Claude namespaced invocations to the SkillHub directory name', () => {
    const document = skillDocument('frontmatter-alias', 'Target rules.');
    const invoke = (id: string) => claudeLine({ type: 'assistant', message: { content: [
      { type: 'tool_use', id, name: 'Skill', input: { skill: 'cindy:target' } },
    ] } });
    const inject = (id: string) => claudeLine({ type: 'user', sourceToolUseID: id,
      message: { content: claudeSkillInjection('/skills/target', document) } });
    const exposures = analyzeLines('claude-code', [
      claudeLine({ type: 'user', message: { content: 'Use target now.' } }),
      invoke('business-skill'),
      inject('business-skill'),
    ]);
    expect(exposures).toHaveLength(1);
    expect(exposures[0]).toMatchObject({
      skillName: 'target', skillPath: '/skills/target', toolUseId: 'business-skill',
      skillDocumentHash: hashSkillContent(document),
    });
  });

  it('preserves a namespaced skill name when no path identifies the SkillHub directory', () => {
    const exposures = analyzeLines('codex', [
      codexLine({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: `<skill name="vendor:target">\n${skillDocument('target', 'Rules.')}\n</skill>` },
      ] } }),
    ]);
    expect(exposures[0]).toMatchObject({ skillName: 'vendor:target', skillPath: null });
  });

  it('does not assign a successful document to the failed first path in a batch read', () => {
    const beta = skillDocument('beta', 'Beta rules.');
    const exposures = analyzeLines('codex', [
      codexToolCall('batch', "cat '/skills/alpha/SKILL.md' '/skills/beta/SKILL.md'"),
      codexToolOutput('batch', `Exit code: 1\nOutput:\ncat: /skills/alpha/SKILL.md: No such file\n${beta}`),
    ]);
    expect(exposures).toHaveLength(1);
    expect(exposures[0]).toMatchObject({ skillName: 'beta', skillPath: null, skillDocumentHash: hashSkillContent(beta) });
  });

  it('preserves explicit document paths in a batch read with partial failure', () => {
    const beta = skillDocument('display-alias', 'Beta rules.');
    const exposures = analyzeLines('codex', [
      codexToolCall('batch', "cat '/skills/alpha/SKILL.md' '/skills/beta/SKILL.md'"),
      codexToolOutput('batch', `Exit code: 1\nOutput:\nMissing alpha.\n${claudeSkillInjection('/skills/beta', beta)}`),
    ]);
    expect(exposures).toHaveLength(1);
    expect(exposures[0]).toMatchObject({ skillName: 'beta', skillPath: '/skills/beta', skillDocumentHash: hashSkillContent(beta) });
  });

  it('does not infer paths from output order even when a batch returns every document', () => {
    const beta = skillDocument('beta', 'Beta rules.');
    const alpha = skillDocument('alpha', 'Alpha rules.');
    const exposures = analyzeLines('codex', [
      codexToolCall('batch', "cat '/skills/alpha/SKILL.md' '/skills/beta/SKILL.md'"),
      codexToolOutput('batch', `${beta}\n${alpha}`),
      codexToolCall('after-batch', 'check-both'),
    ]);
    expect(exposures.map(({ skillName, skillPath }) => ({ skillName, skillPath }))).toEqual([
      { skillName: 'beta', skillPath: null }, { skillName: 'alpha', skillPath: null },
    ]);
    expect(exposures.map(({ observation }) => observation.commandCallCount)).toEqual([1, 1]);
  });

  it('keeps late Claude reads in their calling turn without replacing the current load group', () => {
    const target = skillDocument('target', 'Target rules.');
    const exposures = analyzeLines('claude-code', [
      claudeLine({ type: 'user', message: { role: 'user', content: 'Read target for the first task.' } }),
      claudeRead('old-read', 'target'),
      claudeLine({ type: 'user', message: { role: 'user', content: 'Use target for the next task.' } }),
      claudeRead('new-read', 'target'),
      claudeResult('new-read', target),
      claudeResult('old-read', target),
      claudeLine({ type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'new-command', name: 'Bash', input: { command: 'run-check' } },
      ] } }),
    ]);
    expect(exposures.map(item => item.skillName)).toEqual(['target', 'target']);
    expect(exposures[0]).toMatchObject({ rawLineNo: 5, source: 'claude_skill_file_read', observation: { toolCallCount: 1 } });
    expect(exposures[1]).toMatchObject({ rawLineNo: 6, source: 'claude_skill_file_read', observation: { toolCallCount: 0 } });
  });

  it('recognizes late Claude Skill-tool results independently from later injections', () => {
    const document = skillDocument('target', 'Target rules.');
    const exposures = analyzeLines('claude-code', [
      claudeLine({ type: 'user', message: { content: 'Use target for the first task.' } }),
      claudeLine({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'old-skill', name: 'Skill', input: { skill: 'target' } },
      ] } }),
      claudeLine({ type: 'user', message: { content: 'New business task.' } }),
      claudeLine({ type: 'user', sourceToolUseID: 'old-skill', message: { content: claudeSkillInjection('/skills/target', document) } }),
      claudeLine({ type: 'user', message: { content: claudeSkillInjection('/skills/target', document) } }),
    ]);
    expect(exposures).toHaveLength(2);
    expect(exposures[0]).toMatchObject({ source: 'claude_skill_tool', rawLineNo: 4, toolUseId: 'old-skill' });
    expect(exposures[1]).toMatchObject({ source: 'claude_skill_content_injection', rawLineNo: 5 });
  });

  it('uses Codex event users once and preserves observations through response-item duplicates', () => {
    const target = skillDocument('target', 'Target rules.');
    const userMessage = 'Use target for the first task.';
    const exposures = analyzeLines('codex', [
      codexLine({ type: 'event_msg', payload: { type: 'user_message', message: userMessage } }),
      codexFunction('old-read', 'functions.exec_command', { cmd: "cat '/skills/target/SKILL.md'" }),
      codexInjection('target'),
      codexInjection('other'),
      codexLine({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: userMessage }] } }),
      codexFunction('in-turn', 'functions.exec_command', { cmd: 'run-check' }),
      codexLine({ type: 'event_msg', payload: { type: 'user_message', message: 'Use target now.' } }),
      codexToolOutput('old-read', `Process exited with code 0\nFinal output:\n${target}`),
      codexLine({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'new-read', name: 'functions.exec_command',
        input: JSON.stringify({ cmd: "Get-Content -LiteralPath '/skills/target/SKILL.md'" }) } }),
      codexLine({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'new-read',
        output: `Process exited with code 0\nFinal output:\n${target}` } }),
      codexFunction('new-command', 'functions.exec_command', { cmd: 'run-check' }),
      codexToolOutput('in-turn', 'Process exited with code 1\nFinal output:\nfailed'),
      codexLine({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'free-js', name: 'functions.exec',
        input: "await tools.exec_command({cmd: \"cat '/skills/target/SKILL.md'\"})" } }),
      codexLine({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'free-js', output: target } }),
    ]);
    expect(exposures.map(item => item.skillName)).toEqual(['target', 'other', 'target', 'target']);
    expect(exposures[0].observation.toolCallCount).toBe(0);
    expect(exposures[1].observation).toMatchObject({ toolCallCount: 1, commandFailureCount: 1 });
    expect(exposures[2].observation.toolCallCount).toBe(0);
    expect(exposures[3]).toMatchObject({ source: 'codex_skill_file_read', rawLineNo: 10, skillDocumentHash: hashSkillContent(target) });
    expect(exposures[3].observation).toMatchObject({ toolCallCount: 2, commandCallCount: 1, toolErrorCount: 0 });
  });

  it('does not associate a new Claude injection with a pending Skill from an earlier turn', () => {
    const document = skillDocument('target', 'Target rules.');
    const exposures = analyzeLines('claude-code', [
      claudeLine({ type: 'user', message: { content: 'Use target for the first task.' } }),
      claudeLine({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'old-skill', name: 'Skill', input: { skill: 'target' } },
      ] } }),
      claudeLine({ type: 'user', message: { content: 'New business task.' } }),
      claudeLine({ type: 'user', message: { content: claudeSkillInjection('/skills/target', document) } }),
    ]);
    expect(exposures).toHaveLength(1);
    expect(exposures[0]).toMatchObject({ source: 'claude_skill_content_injection', rawLineNo: 4 });
  });

  it('recognizes literal shell custom-call input while leaving JavaScript custom calls opaque', () => {
    const document = skillDocument('target', 'Target rules.');
    const exposures = analyzeLines('codex', [
      codexLine({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'shell', name: 'functions.shell_command',
        input: "cat '/skills/target/SKILL.md'" } }),
      codexLine({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'shell', output: document } }),
    ]);
    expect(exposures).toHaveLength(1);
    expect(exposures[0]).toMatchObject({ source: 'codex_skill_file_read', skillName: 'target', toolUseId: 'shell' });
  });

  it('keeps Pi exposure windows on their parent branch and ignores summaries', () => {
    const target = skillDocument('target', 'Target rules.');
    const other = skillDocument('other', 'Other rules.');
    const exposures = analyzeLines('pi', [
      JSON.stringify({ type: 'session', version: 3, id: 'native-session', cwd: '/project' }),
      piEntry('u1', null, { role: 'user', content: 'Use target for the first task.' }),
      piCall('a1', 'u1', 'first-read', 'read', { path: '/skills/target/SKILL.md' }),
      JSON.stringify({ type: 'compaction', id: 'c1', parentId: 'a1', summary: claudeSkillInjection('/skills/target', target) }),
      piResult('r1', 'c1', 'first-read', target),
      piCall('a2', 'r1', 'other-read', 'read', { path: '/skills/other/SKILL.md' }),
      piResult('r2', 'a2', 'other-read', other),
      piCall('a3', 'r2', 'old-command', 'bash', { command: 'run-check' }),
      piEntry('u2', 'a3', { role: 'user', content: [{ type: 'text', text: 'Use target now.' }] }),
      piCall('a4', 'u2', 'target-read', 'read', { path: '/skills/target/SKILL.md' }),
      piResult('r3', 'a4', 'target-read', target),
      piResult('r3', 'a4', 'target-read', target),
      piResult('late-error', 'r3', 'old-command', 'failed', true),
      piCall('branch-read', 'a2', 'branch-target', 'read', { path: '/skills/target/SKILL.md' }),
      piResult('branch-result', 'branch-read', 'branch-target', target),
      piCall('branch-command', 'r2', 'other-command', 'bash', { command: 'run-check' }),
      JSON.stringify({ type: 'branch_summary', id: 'summary', parentId: 'branch-command', summary: 'Summary of earlier work.' }),
      piCall('branch-command-2', 'summary', 'other-command-2', 'bash', { command: 'run-check' }),
    ]);
    expect(exposures.map(item => item.skillName)).toEqual(['target', 'other', 'target', 'target']);
    expect(exposures[0].observation.toolCallCount).toBe(0);
    expect(exposures[1].observation).toMatchObject({ toolCallCount: 3, repeatedToolCallCount: 1, toolErrorCount: 1, commandFailureCount: 1 });
    expect(exposures[2]).toMatchObject({ source: 'pi_skill_file_read', rawLineNo: 11, skillDocumentHash: hashSkillContent(target) });
    expect(exposures[2].observation.toolCallCount).toBe(0);
    expect(exposures[3]).toMatchObject({ rawLineNo: 15, observation: { toolCallCount: 0 } });
  });

  it('does not treat YAML at the start of a Pi skill body as the stripped document frontmatter', () => {
    const body = skillDocument('example-template', 'Example rules.');
    const injection = `<skill name="target" location="/skills/target/SKILL.md">\nReferences are relative to /skills/target.\n${body}\n</skill>`;
    const exposures = analyzeLines('pi', [piEntry('user', null, { role: 'user', content: injection })]);
    expect(exposures[0]).toMatchObject({
      skillName: 'target', skillDocumentHash: null, documentHashSource: 'unavailable',
      exposureContentHash: hashSkillContent(body),
    });
  });

  it.each(['', 'Extract this PDF.'])('parses native Pi /skill expansion as a new user turn, args: %s', (args) => {
    const target = skillDocument('target', 'Target rules.');
    // Pi 0.85.1 的 _expandSkillCommand 在添加这层包装前会移除 frontmatter。
    const body = 'Target rules.';
    const skillBlock = `<skill name="target" location="/skills/target/SKILL.md">\nReferences are relative to /skills/target.\n${body}\n</skill>`;
    const injection = args ? `${skillBlock}\n${args}` : skillBlock;
    const exposures = analyzeLines('pi', [
      piEntry('u1', null, { role: 'user', content: 'Read target for the first task.' }),
      piCall('read', 'u1', 'first-read', 'read', { path: '/skills/target/SKILL.md' }),
      piResult('read-result', 'read', 'first-read', target),
      piEntry('injection', 'read-result', { role: 'user', content: injection }),
      piCall('a1', 'injection', 'run', 'bash', { command: 'run-check' }),
    ]);
    expect(exposures).toHaveLength(2);
    expect(exposures[0].observation.commandCallCount).toBe(0);
    expect(exposures[1]).toMatchObject({
      source: 'pi_skill_injection', skillName: 'target', skillPath: '/skills/target',
      skillDocumentHash: null, documentHashSource: 'unavailable', rawLineNo: 4,
      exposureContentHash: hashSkillContent(args ? `${body}\n${args}` : body),
    });
    expect(exposures[1].observation.commandCallCount).toBe(1);
  });

  it.each([
    "echo '/skills/target/SKILL.md'",
    "rm '/skills/target/SKILL.md'",
    "python script.py '/skills/target/SKILL.md'",
    'cat "$dynamic/target/SKILL.md"',
  ])('does not infer skill reads from a mention or dynamic path: %s', (cmd) => {
    const exposures = analyzeLines('codex', [
      codexFunction('call', 'functions.exec_command', { cmd }),
      codexToolOutput('call', skillDocument('target', 'Target rules.')),
    ]);
    expect(exposures).toEqual([]);
  });
});

describe('Pi context ownership', () => {
  const injection = (name: string) => `<skill name="${name}" location="/skills/${name}/SKILL.md">\nRules.\n</skill>`;

  it('isolates sibling signatures, restores ancestors, and attributes late errors to their calling branch', () => {
    const exposures = analyzeLines('pi', [
      piEntry('root', null, { role: 'user', content: injection('target') }),
      piCall('a1', 'root', 'call-a1', 'bash', { command: 'run-check' }),
      piCall('b1', 'root', 'call-b1', 'bash', { command: 'run-check' }),
      piCall('b2', 'b1', 'call-b2', 'bash', { command: 'run-check' }),
      piCall('a2', 'a1', 'call-a2', 'bash', { command: 'run-check' }),
      piResult('result-a1', 'a2', 'call-a1', 'failed', true),
      piResult('wrong-branch', 'b2', 'call-a2', 'failed', true),
      piResult('result-a2', 'result-a1', 'call-a2', 'failed', true),
      piCall('c1', 'root', 'call-c1', 'bash', { command: 'run-check' }),
    ]);
    expect(exposures).toHaveLength(1);
    expect(exposures[0].observation).toEqual({
      toolCallCount: 5, repeatedToolCallCount: 2, toolErrorCount: 2, commandCallCount: 5, commandFailureCount: 2,
    });
  });

  it('ignores duplicate entries after their contexts are released', () => {
    const exposures = analyzeLines('pi', [
      piEntry('root', null, { role: 'user', content: injection('target') }),
      JSON.stringify({ type: 'session', id: 'a1', parentId: 'root' }),
      piCall('a1', 'root', 'call-a1', 'bash', { command: 'run-check' }),
      piResult('leaf', 'a1', 'call-a1', 'ok'),
      piEntry('leaf', 'root', { role: 'user', content: injection('duplicate') }),
      piCall('a2', 'a1', 'call-a2', 'bash', { command: 'run-check' }),
    ]);
    expect(exposures.map(item => item.skillName)).toEqual(['target']);
    expect(exposures[0].observation).toMatchObject({ toolCallCount: 2, repeatedToolCallCount: 1 });
  });

  it('does not inherit a missing or forward parent context', () => {
    const exposures = analyzeLines('pi', [
      piCall('early', 'future', 'early-call', 'bash', { command: 'run-check' }),
      piEntry('future', null, { role: 'user', content: injection('target') }),
      piCall('back-to-early', 'early', 'early-follow-up', 'bash', { command: 'run-check' }),
      piCall('missing', 'missing-parent', 'missing-call', 'bash', { command: 'run-check' }),
      piCall('valid', 'future', 'valid-call', 'bash', { command: 'run-check' }),
    ]);
    expect(exposures).toHaveLength(1);
    expect(exposures[0].observation).toMatchObject({ toolCallCount: 1, repeatedToolCallCount: 0 });
  });

  it('keeps a late skill read in its old turn without replacing the current load group', () => {
    const exposures = analyzeLines('pi', [
      piEntry('old-user', null, { role: 'user', content: 'Old task.' }),
      piCall('old-read', 'old-user', 'old-call', 'read', { path: '/skills/old/SKILL.md' }),
      piEntry('new-user', 'old-read', { role: 'user', content: injection('current') }),
      piCall('before', 'new-user', 'before-call', 'bash', { command: 'run-check' }),
      piResult('late-read', 'before', 'old-call', skillDocument('old', 'Old rules.')),
      piCall('after', 'late-read', 'after-call', 'bash', { command: 'run-check' }),
    ]);
    expect(exposures.map(item => item.skillName)).toEqual(['current', 'old']);
    expect(exposures[0].observation).toMatchObject({ toolCallCount: 2, repeatedToolCallCount: 1 });
    expect(exposures[1].observation).toMatchObject({ toolCallCount: 0, repeatedToolCallCount: 0 });
  });

  it('counts a long linear tool history without changing its observation window', () => {
    const calls = 1200;
    const lines = [piEntry('root', null, { role: 'user', content: injection('target') })];
    let parentId = 'root';
    for (let i = 0; i < calls; i += 1) {
      lines.push(piCall(`call-${i}`, parentId, `tool-${i}`, 'bash', { command: `echo ${i}` }));
      lines.push(piResult(`result-${i}`, `call-${i}`, `tool-${i}`, 'ok'));
      parentId = `result-${i}`;
    }
    lines.push(piCall('repeat', parentId, 'repeat-tool', 'bash', { command: 'echo 0' }));
    lines.push(piResult('repeat-result', 'repeat', 'repeat-tool', 'failed', true));
    const exposures = analyzeLines('pi', lines);
    expect(exposures).toHaveLength(1);
    expect(exposures[0].observation).toEqual({
      toolCallCount: calls + 1, repeatedToolCallCount: 1, toolErrorCount: 1,
      commandCallCount: calls + 1, commandFailureCount: 1,
    });
  });
});

describe('stable native exposure identities', () => {
  const document = skillDocument('target', 'Rules.');
  const cases: Array<{ agentKind: SkillUsageAgentKind; lines: string[] }> = [
    { agentKind: 'claude-code', lines: [claudeLine({ uuid: 'record', type: 'user',
      message: { content: claudeSkillInjection('/skills/target', document) } })] },
    { agentKind: 'codex', lines: [codexLine({ type: 'response_item', payload: { id: 'record', type: 'message', role: 'user',
      content: [{ type: 'input_text', text: codexSkillInjection('target', '/skills/target', document) }] } })] },
    { agentKind: 'pi', lines: [piEntry('record', null, { role: 'user', content:
      `<skill name="target" location="/skills/target/SKILL.md">\nRules.\n</skill>` })] },
  ];

  it.each(cases)('keeps $agentKind IDs through archive moves and changed record positions', ({ agentKind, lines }) => {
    const analyze = (archived: boolean, sessionId = 'logical-native-session') => analyzeSkillUsageTranscript({
      agentKind, sessionId, sdkSessionId: agentKind === 'pi' ? (archived ? '/archive/pi.jsonl' : '/sessions/pi.jsonl') : 'native',
      rawFilePath: path.join(os.tmpdir(), archived ? 'archived_sessions' : 'sessions', 'session.jsonl'),
      lines: archived ? [JSON.stringify({ type: 'header' }), ...lines] : lines,
    }).exposures[0];
    expect(analyze(true).id).toBe(analyze(false).id);
    expect(analyze(true).rawLineNo).toBe(2);
    expect(analyze(true).rawFilePath).not.toBe(analyze(false).rawFilePath);
    expect(analyze(false, 'other-native-session').id).not.toBe(analyze(false).id);
  });

  it('uses native tool IDs when the transcript has no record ID', () => {
    const lines = [codexToolCall('read-target', "cat '/skills/target/SKILL.md'"), codexToolOutput('read-target', document)];
    expect(analyzeLines('codex', lines)[0].id).toBe(analyzeLines('codex', [JSON.stringify({ type: 'header' }), ...lines])[0].id);
  });

  it('keeps separate tool reads distinct when Claude returns them in the same native record', () => {
    const exposures = analyzeLines('claude-code', [
      claudeRead('read-1', 'target'),
      claudeRead('read-2', 'target'),
      claudeLine({ uuid: 'batch-result', type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'read-1', content: document },
        { type: 'tool_result', tool_use_id: 'read-2', content: document },
      ] } }),
    ]);
    expect(exposures).toHaveLength(2);
    expect(exposures[0].id).not.toBe(exposures[1].id);
  });

  it('keeps engine identities distinct even when native session and record IDs match', () => {
    const ids = cases.map(({ agentKind, lines }) => analyzeSkillUsageTranscript({
      agentKind, sessionId: 'same-session', sdkSessionId: 'same-session', rawFilePath: 'same-file', lines,
    }).exposures[0].id);
    expect(new Set(ids).size).toBe(cases.length);
  });
});
