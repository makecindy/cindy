/**
 * agentActionsCompactBlocks.test.ts
 * ---------------------------------------------------------------------------
 * cc-agent-compact-blocks v2 — source-scan invariants for the F8/F9/F10/F11/F12
 * decisions:
 *
 *   F8  AgentActionsBlock + ThinkingCard default to COLLAPSED — no
 *       "auto-expanded while streaming" path.
 *   F9  Both blocks consume `useExpandedBlockMemory` (persistent storage)
 *       and have removed the v1 `userInteractedRef` / `prevStreamingRef`
 *       state machine.
 *   F10 MessageStream wraps render items in `gap-3.5` (= 14 px), exactly
 *       half of the v1 `gap-7` (28 px).
 *   F11 AgentActionRow renders Claude and Codex single-file actions as a real
 *       **chip** (chat-input-chip-* tokens) and routes edits to one shared
 *       Lightbox — not an inline 2nd-level expand.
 *   F12 Other tools (Bash/Grep/...) toggle inline input/output details,
 *       not the payload Lightbox.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const renderer = (rel: string) =>
  // 归一化 CRLF → LF：Windows autocrlf=true 检出下工作树是 CRLF，
  // 而下面的源码扫描断言里内嵌裸 \n，不归一化会在 Windows 上误报失败。
  readFileSync(resolve(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const blockSrc = renderer('components/chat/AgentActionsBlock.tsx');
const rowSrc = renderer('components/chat/AgentActionRow.tsx');
const userMessageSrc = renderer('components/chat/UserMessage.tsx');
const thinkingSrc = renderer('components/chat/ThinkingCard.tsx');
const streamSrc = renderer('components/chat/MessageStream.tsx');
const toolPayloadSrc = renderer('components/chat/ToolPayloadLightbox.tsx');

// ── F8: default collapsed ──────────────────────────────────────────────────

describe('F8 — default collapsed', () => {
  it('AgentActionsBlock no longer initializes expanded from isStreaming', () => {
    // v1 had `useState<boolean>(isStreaming)` — must be gone.
    expect(blockSrc).not.toMatch(/useState<boolean>\(\s*isStreaming\s*\)/);
    // v2 reads expand state from useExpandedBlockMemory.
    expect(blockSrc).toMatch(/useExpandedBlockMemory/);
  });

  it('AgentActionsBlock dropped the userInteractedRef + prevStreamingRef state machine', () => {
    expect(blockSrc).not.toMatch(/userInteractedRef/);
    expect(blockSrc).not.toMatch(/prevStreamingRef/);
  });

  it('ThinkingCard no longer initializes expanded from isTurnActive', () => {
    expect(thinkingSrc).not.toMatch(/useState<boolean>\(\s*!!\s*isTurnActive\s*\)/);
    expect(thinkingSrc).not.toMatch(/prevTurnActiveRef/);
    expect(thinkingSrc).toMatch(/useExpandedBlockMemory/);
  });

  it('AgentActionsBlock no longer accepts isStreaming prop in its interface', () => {
    // The export interface should NOT contain `isStreaming` — F8/F9 removed it.
    // We slice the AgentActionsBlockProps interface and check.
    const ifaceStart = blockSrc.indexOf('AgentActionsBlockProps');
    const open = blockSrc.indexOf('{', ifaceStart);
    const close = blockSrc.indexOf('}', open);
    const slice = blockSrc.slice(open, close);
    expect(slice).not.toMatch(/isStreaming/);
  });
});

// ── F9: in-memory expand state (persistence intentionally removed) ─────────

describe('F9 — useExpandedBlockMemory in-memory store', () => {
  it('does not touch localStorage (state is session-only)', () => {
    const hookSrc = renderer('hooks/useExpandedBlockMemory.ts');
    expect(hookSrc).not.toMatch(/localStorage/);
  });

  it('AgentActionsBlock builds a stable agent:<clientId> block id', () => {
    expect(blockSrc).toMatch(/agent:\$\{toolCalls\[0\]\.clientId\}/);
  });

  it('ThinkingCard builds a stable thinking:* block id', () => {
    const persistedKeyBlock = thinkingSrc.match(/const persistedKey = useMemo\(\(\) => \{[\s\S]*?\}, \[blockKey, startedAt\]\);/)?.[0] ?? '';
    expect(persistedKeyBlock).toMatch(/return `thinking:\$\{blockKey\}`/);
    expect(persistedKeyBlock).toMatch(/return `thinking:\$\{startedAt\}`/);
    expect(persistedKeyBlock).toContain("return 'thinking:unknown'");
    expect(thinkingSrc).toContain('useExpandedBlockMemory(persistedKey)');
  });
});

// ── F10: vertical spacing halved ────────────────────────────────────────────

describe('F10 — message stream spacing halved', () => {
  it('MessageStream items wrapper uses gap-3.5 (was gap-7)', () => {
    expect(streamSrc).toMatch(/flex flex-col gap-3\.5/);
    expect(streamSrc).not.toMatch(/flex flex-col gap-7/);
  });
});

// ── F11: file chip + diff lightbox ─────────────────────────────────────────

describe('F11 — file chip + diff lightbox', () => {
  it('AgentActionRow imports the chip-style FileIcon + uses chat-input-chip tokens', () => {
    expect(rowSrc).toMatch(
      /import\s+\{[^}]*File as FileIcon[^}]*\}\s+from\s+'lucide-react'/,
    );
    expect(rowSrc).toMatch(/--chat-input-chip-bg/);
    expect(rowSrc).toMatch(/--chat-input-chip-border/);
    expect(rowSrc).toMatch(/--chat-input-chip-text/);
  });

  it('AgentActionRow no longer embeds RowDiffBody / RowJsonBody inline', () => {
    expect(rowSrc).not.toMatch(/RowDiffBody/);
    expect(rowSrc).not.toMatch(/RowJsonBody/);
  });

  it('Claude Edit / Write / MultiEdit and Codex file_change share diff mode', () => {
    expect(rowSrc).toMatch(/buildDiffPayload/);
    expect(rowSrc).toMatch(/kind:\s*'diff'/);
    expect(rowSrc).toMatch(/rawDiff:\s*change\.diff/);
    expect(rowSrc).toMatch(/ToolPayloadLightbox/);
    expect(rowSrc).not.toMatch(/FileChangeDetails/);
  });

  it('Read tool routes to TextLightbox', () => {
    expect(rowSrc).toMatch(/TextLightbox/);
    expect(rowSrc).toMatch(/toolName === 'Read'/);
  });

  it('file chip context menu stays reachable from keyboard context-menu shortcuts', () => {
    expect(rowSrc).toMatch(/const chipRect = fileChipRef\.current\?\.getBoundingClientRect\(\)/);
    expect(rowSrc).toMatch(/e\.key !== 'ContextMenu'/);
    expect(rowSrc).toMatch(/e\.shiftKey && e\.key === 'F10'/);
    expect(rowSrc).toMatch(/fileChipMenu\.openAt\(/);
  });
});

// ── F12: Other tools → inline details via chevron ──────────────────────────

describe('F12 — non-file tools → inline details', () => {
  it('AgentActionRow routes non-file tools to inline expansion', () => {
    expect(rowSrc).toMatch(/const isInlineExpand = !isFilePathTool/);
    expect(rowSrc).toMatch(/if \(isInlineExpand\) \{[\s\S]*?setExpanded/);
    expect(rowSrc).toMatch(/isInlineExpand && expanded/);
    expect(rowSrc).toMatch(/formatInlineInput/);
  });

  it('AgentActionRow prefers displayCommand and normalizes historical raw wrappers', () => {
    // issue #450: 行主文案改走 maker-shared 的 describeToolUse(displayCommand
    // 优先逻辑在共享层,由 toolUseDescriptor.test.ts 覆盖);就地展开区仍走
    // commandDisplayText 保留命令原文。
    expect(rowSrc).toMatch(/function commandDisplayText/);
    expect(rowSrc).toMatch(/inp\.displayCommand/);
    expect(rowSrc).toMatch(/inp\.command/);
    expect(rowSrc).toMatch(/normalizeDisplayCommand\(inp\.command\)/);
    expect(rowSrc).toMatch(/const cmd = commandDisplayText\(inp\)/);
    expect(rowSrc).toMatch(/describeToolUse/);
  });

  it('ToolPayloadLightbox remains the file/diff payload modal, not the non-file routing contract', () => {
    expect(toolPayloadSrc).toMatch(/kind:\s*'diff'/);
    expect(toolPayloadSrc).toMatch(/kind:\s*'json'/);
    expect(toolPayloadSrc).toMatch(/<DiffView/);
    expect(toolPayloadSrc).toMatch(/<MarkdownDiffBlock/);
    expect(toolPayloadSrc).toMatch(/e\.key\s*===\s*'Escape'/);
    expect(toolPayloadSrc).toMatch(/onClick=\{handleClose\}/);
  });

  it('ToolPayloadLightbox keeps duplicate MultiEdit diffs addressable with an index in the key', () => {
    const buildDiffPayloadBlock = rowSrc.match(
      /function buildDiffPayload\([\s\S]*?\n}\n\nexport interface AgentActionRowProps/,
    )?.[0] ?? '';
    expect(buildDiffPayloadBlock).toContain("key: 'edit:0'");
    expect(buildDiffPayloadBlock).toContain("key: 'write:0'");
    expect(buildDiffPayloadBlock).toMatch(/edits\.map\(\(e, index\) =>/);
    expect(buildDiffPayloadBlock).toMatch(/key:\s*`edit:\$\{index\}`/);
    expect(toolPayloadSrc).toContain('key={diff.key}');
  });
});

// ── MessageStream cleanup ──────────────────────────────────────────────────

describe('MessageStream cleanup', () => {
  it('renders persisted Orca communication messages as collapsible cards', () => {
    expect(userMessageSrc).toMatch(/parseOrcaCommunicationContent/);
    expect(userMessageSrc).toMatch(/chat\.userMessage\.orcaFromLead/);
    expect(userMessageSrc).toMatch(/chat\.userMessage\.orcaFromWorker/);
    expect(userMessageSrc).toMatch(/aria-expanded=\{orcaExpanded\}/);
  });

  it('hides only empty Orca worker communication results, not tool calls', () => {
    expect(streamSrc).toMatch(/isOrcaCommunicationTool/);
    expect(streamSrc).toMatch(/isEmptyOrcaCommunicationResult/);
    expect(streamSrc).toMatch(/shouldHideToolResult/);
    expect(streamSrc).toMatch(/send_to_lead/);
    expect(streamSrc).toMatch(/read_lead/);
    expect(streamSrc).toMatch(/lead_status/);
    expect(streamSrc).not.toMatch(/if \(isHiddenOrcaCommunicationTool\(toolName\)\)/);
  });

  it('tool_segment items no longer carry isStreaming', () => {
    // The render path inside MessageStream should not pass isStreaming any more.
    // Find the AgentActionsBlock JSX block and assert no isStreaming prop.
    const idx = streamSrc.indexOf('<AgentActionsBlock');
    expect(idx).toBeGreaterThan(-1);
    const close = streamSrc.indexOf('/>', idx);
    const slice = streamSrc.slice(idx, close);
    expect(slice).not.toMatch(/isStreaming/);
  });

  it('ThinkingCard JSX no longer threads isTurnActive', () => {
    const idx = streamSrc.indexOf('<ThinkingCard');
    expect(idx).toBeGreaterThan(-1);
    const close = streamSrc.indexOf('/>', idx);
    const slice = streamSrc.slice(idx, close);
    expect(slice).not.toMatch(/isTurnActive/);
  });

  it('does not rescan every render for a missing search focus target', () => {
    expect(streamSrc).toMatch(/const lastMissingFocusRef = useRef/);
    expect(streamSrc).toContain('missingFocus.itemCount === allRenderItems.length');
    expect(streamSrc).toContain('missingFocus.lastItemKey === lastItemKey');
    expect(streamSrc).toContain('lastMissingFocusRef.current = {');
  });
});
