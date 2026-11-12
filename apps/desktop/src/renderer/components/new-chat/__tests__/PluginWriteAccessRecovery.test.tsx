/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginWriteAccessRecovery } from '../PluginWriteAccessRecovery';
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('@/lib/toast',()=>({toast:{error:vi.fn()}}));
afterEach(cleanup);
function setup(available=true){
 const read=vi.fn(async()=>({available}));
 const retry=vi.fn(async()=>({granted:true,mode:'auto' as const}));
 Object.defineProperty(window,'electronAPI',{configurable:true,value:{maker:{getPluginWriteAccessRecovery:read,retryPluginWriteAccess:retry}}});
 const granted=vi.fn();render(<PluginWriteAccessRecovery sessionId="task" onGranted={granted}/>);
 return {read,retry,granted};
}
it('does not automatically retry and exposes no action without a refused request',async()=>{
 const f=setup(false);await waitFor(()=>expect(f.read).toHaveBeenCalledWith('task'));
 expect(screen.queryByRole('button')).toBeNull();expect(f.retry).not.toHaveBeenCalled();
});
it('only an explicit click retries and a confirmed result refreshes the task permission',async()=>{
 const f=setup();const button=await screen.findByRole('button');expect(f.retry).not.toHaveBeenCalled();
 fireEvent.click(button);await waitFor(()=>expect(f.granted).toHaveBeenCalledWith('auto'));
 expect(f.retry).toHaveBeenCalledOnce();expect(screen.queryByRole('button')).toBeNull();
});
