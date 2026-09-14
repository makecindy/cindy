import { describe, expect, it } from 'vitest';
import fixture from './fixtures/cua-driver-0.23.2.json';
import { adaptComputerDriverArgs, type ComputerDriverToolSchema } from '../computer-contract.js';

const schemas = new Map(
  fixture.tools.map((tool) => [tool.name, tool.inputSchema as ComputerDriverToolSchema]),
);
describe('installed Computer Use contract', () => {
  it('preserves driver credentials and rejects missing observation provenance', () => {
    const args = {
      pid: 1,
      window_id: 2,
      element_index: 3,
      snapshot_id: 's01234567',
      element_token: 'opaque:untouched',
      delivery_mode: 'background',
    };
    expect(adaptComputerDriverArgs('click', args, schemas)).toEqual(args);
    expect(() => adaptComputerDriverArgs('click', { pid: 1, element_index: 3 }, schemas)).toThrow(
      'fresh driver snapshot_id',
    );
  });
  it('uses the real screenshot switch and bounded traversal without mutating caller input', () => {
    const args = { pid: 1, window_id: 2, capture_mode: 'ax' };
    expect(adaptComputerDriverArgs('get_window_state', args, schemas)).toEqual({
      pid: 1,
      window_id: 2,
      include_screenshot: false,
      max_elements: 200,
      max_depth: 15,
    });
    expect(args.capture_mode).toBe('ax');
    expect(
      adaptComputerDriverArgs(
        'get_window_state',
        { ...args, include_screenshot: true, max_elements: 500 },
        schemas,
      ),
    ).toMatchObject({ include_screenshot: true, max_elements: 500 });
  });
  it('preserves legacy SOM and maps an explicit new screenshot flag for old drivers', () => {
    const legacy = new Map([['get_window_state', { properties: { capture_mode: {} } }]]);
    expect(adaptComputerDriverArgs('get_window_state', { capture_mode: 'som' }, legacy)).toEqual({
      capture_mode: 'som',
    });
    expect(
      adaptComputerDriverArgs('get_window_state', { include_screenshot: false }, legacy),
    ).toEqual({ capture_mode: 'ax' });
  });
  it('rejects unavailable tools and incompatible arguments before dispatch', () => {
    expect(() => adaptComputerDriverArgs('missing', {}, schemas)).toThrow('does not advertise');
    expect(() => adaptComputerDriverArgs('click', { pid: 1, unsupported: true }, schemas)).toThrow(
      'does not accept unsupported',
    );
    expect(() =>
      adaptComputerDriverArgs('verify_state', { pid: 1, window_id: 2 }, schemas),
    ).toThrow('requires expect');
  });
});
