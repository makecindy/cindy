import { beforeEach, expect, it, vi } from 'vitest';

// Unit: which app fills the cloud management call table.
const instance = vi.hoisted(() => ({ current: null as object | null }));
vi.mock('../../instance-runtime/config.js', () => ({ getInstanceConfig: () => instance.current }));
import {
  cloudManagementProviderRegistry,
  hasCloudManagementCall,
  registerCloudDomainCall,
  registerCloudImCall,
  registerPrivateCloudManagementCall,
} from '../managementCalls';

const names = [
  'maker:provider:list',
  'telegramBot:get-status',
  'maker:mcp:custom:list',
  'cloud:provider:key-replace',
];
const native = { handle: vi.fn() };
function registerAll() {
  cloudManagementProviderRegistry(native).handle(names[0]!, () => null);
  registerCloudImCall(names[1]!, () => null);
  registerCloudDomainCall(names[2]!, () => null);
  registerPrivateCloudManagementCall(names[3]!, () => null);
}
beforeEach(() => native.handle.mockClear());

it('an ordinary desktop registers its own IPC and captures no cloud management call', () => {
  instance.current = null;
  registerAll();
  expect(native.handle).toHaveBeenCalledTimes(1);
  expect(names.filter(hasCloudManagementCall)).toEqual([]);
});

it('a managed cloud instance captures the listed calls only', () => {
  instance.current = {};
  registerAll();
  registerCloudDomainCall('safe-storage-read', () => null);
  expect(names.filter(hasCloudManagementCall)).toEqual(names);
  expect(hasCloudManagementCall('safe-storage-read')).toBe(false);
});
