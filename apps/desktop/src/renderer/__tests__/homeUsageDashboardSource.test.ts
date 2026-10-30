import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../components/new-chat/HomeUsageDashboard.tsx'), 'utf8');

// Guard the account identity passed to the hook and isolation of cached history.
describe('HomeUsageDashboard account isolation contract', () => {
  it('shows cached usage immediately while marking background refresh', () => {
    expect(source).toContain(
      'const { history, refreshing: usageRefreshing } = useUsageHistory({ paused: collapsed, userId: user?.id });',
    );
    expect(source).toContain('const { user } = useAuth();');
    expect(source).toContain('const layoutHistory = history ?? emptyLayoutHistory;');
    expect(source).toContain("t('usageDashboard.updating')");
  });


  it('scopes renderer usage-history snapshots by account', () => {
    const hookSource = readFileSync(resolve(__dirname, '../hooks/useUsageHistory.ts'), 'utf8');
    expect(hookSource).toContain('function storageKeyForScope(scopeKey: string): string');
    expect(hookSource).toContain('localStorage.getItem(storageKeyForScope(scopeKey))');
    expect(hookSource).toContain(
      'localStorage.setItem(storageKeyForScope(scopeKey), JSON.stringify(p))',
    );
    expect(hookSource).toContain('const scopes = new Map<string, UsageHistoryScopeState>();');
    expect(hookSource).toContain('const scopeKey = normalizeScopeKey(opts?.userId);');
  });


  it('does not render the previous account history after the scope changes', () => {
    const hookSource = readFileSync(resolve(__dirname, '../hooks/useUsageHistory.ts'), 'utf8');
    expect(hookSource).toContain(
      'const [historyState, setHistoryState] = useState<{ scopeKey: string; value: UsageHistoryPayload | null }>',
    );
    expect(hookSource).toContain('setHistoryState({ scopeKey: scopedKey, value });');
    expect(hookSource).toContain(
      'const history = historyState.scopeKey === scopedKey ? historyState.value : scope.cache;',
    );
  });

});
