import assert from 'node:assert/strict';

export default {
  name: 'chat-plugin-package',
  entry: './fixture.tsx',
  viewport: { width: 760, height: 320 },
  real: 'The chat package install row and the existing rich-answer send button.',
  notCovered: 'File inspection and installation IPC are supplied by the fixture.',
  stubs: {
    'src/renderer/contexts/AuthContext':
      'export const useAuth = () => ({user:{id:"fixture"}}); export const useOptionalDataOwnerGeneration = () => 0; export const useOptionalAuthUser = () => null; export const useOptionalAuthDeviceId = () => null;',
  },
  cases: {
    default: { about: 'Install action tied to the generated package.' },
    before: { about: 'The original full-width send action for the same package.' },
  },
  async check(page, ui) {
    const button = page.getByRole('button');
    await button.waitFor();
    const box = await button.boundingBox();
    assert.ok(box && (ui.case === 'before' ? box.width > 400 : box.width < 150));
  },
};
