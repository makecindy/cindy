import { useState } from 'react';
import { AppFrame, mountPage } from '../../ui-page/harness';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import { SessionContentHeaderRegistration, useSessionDagToggle } from '../../../src/renderer/features/cc-agent/SessionContentHeader';

const session = { id: 'task-dag-1', userId: 'fixture', title: '季度复盘与发布计划', workspaceKind: 'dialogue', status: 'active' } as Session;

function HeaderWithToggle() {
  const [enabled, setEnabled] = useState(true);
  const toggle = useSessionDagToggle(enabled ? session : null);
  return (
    <AppFrame>
      <SessionContentHeaderRegistration session={session} dagToggle={toggle} />
      <main className="p-6 text-sm text-muted-foreground" data-ui-page-subject>
        <p data-testid="dag-state">{toggle?.pressed ? '会话图' : '原生聊天'}</p>
        <button type="button" onClick={() => setEnabled(false)}>停用插件</button>
      </main>
    </AppFrame>
  );
}

mountPage({ route: '/cc-agent/task-dag-1', render: () => <HeaderWithToggle /> });
