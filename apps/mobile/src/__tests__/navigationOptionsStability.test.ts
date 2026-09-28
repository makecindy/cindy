import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('navigation option stability', () => {
  it('keeps login and system-back screen options stable across unrelated rerenders', () => {
    const systemBack = readSource('src/platform/chrome/SystemNavigationBack.tsx');
    expect(systemBack).toContain('const screenOptions = useMemo(() => ({');
    expect(systemBack).toContain('<Stack.Screen options={screenOptions} />');
    expect(systemBack).not.toContain('<Stack.Screen options={{');

    const login = readSource('app/(auth)/login.tsx');
    expect(login).toContain('const loginStatusBarOptions = useMemo(() => ({');
    expect(login).toContain('<Stack.Screen options={loginStatusBarOptions} />');
  });
});
