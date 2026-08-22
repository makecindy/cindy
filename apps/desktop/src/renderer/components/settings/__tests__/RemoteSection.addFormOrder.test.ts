import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'RemoteSection.tsx'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

describe('RemoteSection add form order', () => {
  it('keeps SSH and Cindy host lists before the manual add form', () => {
    const cardStart = source.indexOf("className={cn('flex flex-col rounded-xl'");
    const sshHostList = source.indexOf('{sshConfigHosts.map(', cardStart);
    const cindyHostList = source.indexOf('{cindyHosts.map(', sshHostList);
    const manualAdd = source.indexOf("t('settings.remote.button.manualAdd')", cindyHostList);
    const addForm = source.indexOf('{adding && (', manualAdd);

    expect(cardStart).toBeGreaterThanOrEqual(0);
    expect(sshHostList).toBeGreaterThan(cardStart);
    expect(cindyHostList).toBeGreaterThan(sshHostList);
    expect(manualAdd).toBeGreaterThan(cindyHostList);
    expect(addForm).toBeGreaterThan(manualAdd);
  });
});
