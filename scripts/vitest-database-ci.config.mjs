// Restrict Vitest related to the existing DB tier. Without this boundary an
// import of schema.ts could pull ordinary UI tests into the database CI step.
import desktopConfig from '../apps/desktop/vitest.config.ts';
import manifest from './test-workspaces.config.mjs';

const db = manifest.workspaces.find(workspace => workspace.name === 'desktop').tiers.db;
export default {
  ...desktopConfig,
  test: {
    ...desktopConfig.test,
    projects: [{
      extends: true,
      test: { name: 'db-related', include: db.include, exclude: db.exclude },
    }],
  },
};
