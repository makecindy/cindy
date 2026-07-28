/**
 * SessionImportSection source-level lifecycle contract tests.
 *
 * The component calls Electron IPC through preload, so this pins the first-entry
 * scan behavior without booting renderer globals.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = resolve(__dirname, '..', 'components', 'settings', 'SessionImportSection.tsx');
const source = readFileSync(sourcePath, 'utf8');

describe('SessionImportSection initial scan', () => {
  it('runs the existing scan path once when the import settings panel mounts', () => {
    expect(source).toContain('const initialScanStartedRef = useRef(false);');
    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*if \(initialScanStartedRef\.current\) return;\s*initialScanStartedRef\.current = true;\s*void runScan\(\);\s*\}, \[runScan\]\);/,
    );
  });

  it('keeps the last scan result in memory so re-entering import settings renders stale data immediately', () => {
    expect(source).toContain('let cachedSessionImportScan: ScanResult | null = null;');
    expect(source).toContain('useState<ScanResult | null>(() => cachedSessionImportScan)');
    expect(source).toContain('cachedSessionImportScan = result;');
  });

  it('keeps project groups collapsed by default, including after an automatic refresh', () => {
    expect(source).toMatch(/const \[expanded, setExpanded\] = useState<Set<string>>\(\(\) => new Set\(\)\);/);
    expect(source).toContain('setExpanded(new Set());');
    expect(source).not.toContain('getDefaultExpandedProjectKeys');
  });

  it('renders dialogue imports as first-level session rows instead of expandable folder groups', () => {
    expect(source).toContain("type: 'dialogue'");
    expect(source).toContain("item.sidebarBucket !== 'project' || !item.projectDir");
    expect(source).toMatch(
      /if \(listItem\.type === 'dialogue'\)[\s\S]*<SessionImportRow[\s\S]*item=\{item\}[\s\S]*checked=\{selected\.has\(item\.key\)\}/,
    );
  });

  it('places project selection before the expand control and indents project child rows', () => {
    expect(source).toContain('grid min-h-14 grid-cols-[16px_20px_minmax(0,1fr)_auto] items-center gap-x-2 px-4 py-2');
    expect(source).toContain('className="flex h-6 w-5 items-center justify-center rounded-full');
    expect(source).toMatch(
      /checked=\{selectedCount === group\.items\.length\}[\s\S]*onClick=\{\(\) => toggleGroup\(group\.key\)\}/,
    );
    expect(source).toMatch(
      /<SessionImportRow[\s\S]*checked=\{selected\.has\(item\.key\)\}[\s\S]*onToggle=\{\(\) => toggleItem\(item\.key\)\}[\s\S]*isProjectChild/,
    );
    expect(source).toContain("isProjectChild ? 'pl-[40px] pr-4' : 'px-4'");
  });

  it('shows project basename first and full project path as secondary text', () => {
    expect(source).toContain("import { basename, cn } from '@/lib/utils';");
    expect(source).toContain('{groupProjectName(group.items[0], t)}');
    expect(source).toContain("{group.items.length} {t('settings.sessionImport.sessions')} · {groupProjectPath(group.items[0], t)}");
    expect(source).toContain('return basename(item.projectDir) || item.projectDir;');
  });

  it('offers a select-all control scoped to the visible (filtered) candidates', () => {
    expect(source).toMatch(
      /const toggleAllVisible = useCallback\(\(\) => \{[\s\S]*for \(const item of visibleCandidates\)/,
    );
    expect(source).toContain(
      "{t('settings.sessionImport.selectAll', { count: visibleCandidates.length })}",
    );
    expect(source).toMatch(
      /checked=\{visibleCandidates\.length > 0 && visibleSelectedCount === visibleCandidates\.length\}/,
    );
  });

  it('keeps scan summary explanations visible instead of relying on pointer-only title tooltips', () => {
    expect(source).toContain('mt-1 text-11 leading-[1.4] text-[var(--settings-section-desc)]');
    expect(source).toMatch(/>\s*\{hint\}\s*<\/p>/);
    expect(source).not.toContain('title={hint}');
    expect(source).not.toContain('className="sr-only">{hint}</span>');
  });

  it('surfaces selections hidden by the current filters next to the import button', () => {
    expect(source).toContain('const hiddenSelectedCount = selectedItems.length - visibleSelectedCount;');
    expect(source).toMatch(
      /\{hiddenSelectedCount > 0 && \([\s\S]*selectedOutsideFilter[\s\S]*count: hiddenSelectedCount/,
    );
  });

  it('keeps metadata pills on one line and lets long session titles truncate instead of stretching rows', () => {
    expect(source).toContain(
      'shrink-0 whitespace-nowrap rounded-full border border-[var(--settings-input-border)]',
    );
    expect(source).toContain(
      'min-w-0 flex-1 truncate text-13 font-medium text-[var(--settings-section-sublabel)]',
    );
  });

  it('uses the sidebar time formatter for project and session-row timestamps', () => {
    expect(source).toContain(
      "import { formatSidebarTime, formatSidebarTimeAbsolute } from '@/features/cc-agent/lib/formatSidebarTime';",
    );
    expect(source).toContain('const latestUpdatedAt = group.items[0]?.updatedAt;');
    expect(source).toContain('dateTime={latestUpdatedAt}');
    expect(source).toContain('title={formatSidebarTimeAbsolute(latestUpdatedAt)}');
    expect(source).toContain('{formatSidebarTime(latestUpdatedAt, t)}');
    expect(source).toContain('dateTime={item.updatedAt}');
    expect(source).toContain('title={formatSidebarTimeAbsolute(item.updatedAt)}');
    expect(source).toContain('{formatSidebarTime(item.updatedAt, t)}');
  });
});
