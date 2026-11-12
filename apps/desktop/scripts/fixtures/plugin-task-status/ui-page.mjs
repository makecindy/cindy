export default {
  name: 'plugin-task-status',
  entry: './plugin-task-status-fixture.tsx',
  viewport: { width: 760, height: 180 },
  real: 'PluginTaskStatus, native Button, tooltip, installed roster and owner guards, themes',
  notCovered:
    'Electron sandbox IPC, plugin wake and full composer footer; host replies are scenario data. Navigation has unit coverage.',
  cases: {
    default: { about: 'Native plugin status launcher' },
    narrow: {
      about: 'A long plugin label remains within a narrow window',
      viewport: { width: 320, height: 180 },
    },
  },
  async ready(page) {
    await page.getByRole('button', { name: /^Quota:/ }).waitFor();
  },
};
