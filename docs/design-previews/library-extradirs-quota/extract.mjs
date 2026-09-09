#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { findRepoRoot, makeLeaf, extractByPattern, readJson } from './extract-helpers.mjs';
import { join } from 'node:path';

const repoRoot = findRepoRoot();
const actions = join(repoRoot, 'apps/desktop/src/renderer/components/new-chat/extraDirsActions.ts');
const chatInput = join(repoRoot, 'apps/desktop/src/renderer/components/new-chat/ChatInput.tsx');
const panel = join(repoRoot, 'apps/desktop/src/renderer/components/new-chat/AtMentionPanel.tsx');
const validator = join(repoRoot, 'apps/desktop/src/main/maker-ipc/extraDirsValidator.ts');
const zh = join(repoRoot, 'apps/desktop/src/renderer/i18n/locales/zh-CN/common.json');
const en = join(repoRoot, 'apps/desktop/src/renderer/i18n/locales/en/common.json');

const zhCopy = readJson(zh).extraDirs;
const enCopy = readJson(en).extraDirs;
const chatSrc = readFileSync(chatInput, 'utf8');
const panelSrc = readFileSync(panel, 'utf8');
const count = (src, re) => (src.match(re) || []).length;

const truth = {
  quota: {
    max: extractByPattern(validator, 'export const EXTRA_DIRS_MAX = (\\d+)', {
      locator: 'extraDirsValidator EXTRA_DIRS_MAX',
    }),
    slotPrefix: extractByPattern(actions, "export const LIBRARY_EXTRA_DIR_SLOT_PREFIX = '([^']+)'", {
      locator: 'extraDirsActions LIBRARY_EXTRA_DIR_SLOT_PREFIX',
    }),
    systemLabel: extractByPattern(actions, "isLibraryExtraDirSlot\\(dir\\) \\? '([^']+)'", {
      locator: 'extraDirsActions extraDirDisplayLabel 系统项文案',
    }),
  },
  wiring: {
    chatInputQuotaSites: makeLeaf(
      count(chatSrc, /countUserExtraDirs\(currentExtraDirs\) \+ countUserExtraDirs\(currentWritableDirs\)/g),
      chatInput,
      { locator: 'ChatInput 加目录/可写目录两处配额公式次数' },
    ),
    chatInputBadgeSites: makeLeaf(
      count(chatSrc, /countUserExtraDirs\(extraDirs \?\? \[\]\) \+ countUserExtraDirs\(writableDirs \?\? \[\]\)/g),
      chatInput,
      { locator: 'ChatInput ExtraDirsButton extraDirsCount 公式次数' },
    ),
    panelLabelSites: makeLeaf(
      count(panelSrc, /extraDirDisplayLabel\(p\)/g),
      panel,
      { locator: 'AtMentionPanel extraDirDisplayLabel(p) 次数' },
    ),
    panelNoRemoveSites: makeLeaf(
      count(panelSrc, /isLibraryExtraDirSlot\(p\) \? null/g),
      panel,
      { locator: 'AtMentionPanel library 槽不画移除按钮' },
    ),
  },
  copy: {
    'zh-CN': {
      sectionTitle: makeLeaf(zhCopy.sectionTitle, zh, { locator: 'extraDirs.sectionTitle', keyPath: 'extraDirs.sectionTitle' }),
      addReadOnly: makeLeaf(zhCopy.addReadOnly, zh, { locator: 'extraDirs.addReadOnly', keyPath: 'extraDirs.addReadOnly' }),
      atLimit: makeLeaf(zhCopy.atLimit, zh, { locator: 'extraDirs.atLimit', keyPath: 'extraDirs.atLimit' }),
      tooltipCount: makeLeaf(zhCopy.tooltipCount, zh, { locator: 'extraDirs.tooltipCount', keyPath: 'extraDirs.tooltipCount' }),
      empty: makeLeaf(zhCopy.empty, zh, { locator: 'extraDirs.empty', keyPath: 'extraDirs.empty' }),
    },
    en: {
      sectionTitle: makeLeaf(enCopy.sectionTitle, en, { locator: 'extraDirs.sectionTitle', keyPath: 'extraDirs.sectionTitle' }),
      addReadOnly: makeLeaf(enCopy.addReadOnly, en, { locator: 'extraDirs.addReadOnly', keyPath: 'extraDirs.addReadOnly' }),
      atLimit: makeLeaf(enCopy.atLimit, en, { locator: 'extraDirs.atLimit', keyPath: 'extraDirs.atLimit' }),
      tooltipCount: makeLeaf(enCopy.tooltipCount, en, { locator: 'extraDirs.tooltipCount', keyPath: 'extraDirs.tooltipCount' }),
      empty: makeLeaf(enCopy.empty, en, { locator: 'extraDirs.empty', keyPath: 'extraDirs.empty' }),
    },
  },
};

process.stdout.write(JSON.stringify(truth));
