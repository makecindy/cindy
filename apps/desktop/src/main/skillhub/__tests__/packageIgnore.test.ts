import { describe, expect, it } from 'vitest';
import { isIgnoredSkillPackagePath } from '../packageIgnore';

describe('skillhub/packageIgnore', () => {
  it('excludes internal rename backups and staging files without hiding ordinary backup fixtures', () => {
    const backup = 'SKILL.md.xdt-rename-94a2109f-0344-4c8e-b61e-372140d20848';
    // Package paths accept both separators, independently of the host OS.
    for (const file of [backup, `nested/${backup}`, `nested\\${backup.toUpperCase()}`, 'SKILL.md.xdt-tmp', 'docs/example.json.xdt-tmp']) {
      expect(isIgnoredSkillPackagePath(file), file).toBe(true);
    }
    for (const file of ['SKILL.md', 'SKILL.md.bak', 'SKILL.md.xdt-rename-example', `${backup}.md`, 'docs/.backup/example.md']) {
      expect(isIgnoredSkillPackagePath(file), file).toBe(false);
    }
  });

  it('keeps declared dotfile fixtures and dot directories', () => {
    expect(isIgnoredSkillPackagePath('.cca-bindings.json')).toBe(false);
    expect(isIgnoredSkillPackagePath('.cca-state/task/current-goal.md')).toBe(false);
    expect(isIgnoredSkillPackagePath('examples/.fixtures/state.json')).toBe(false);
  });

  it('excludes clearly unsafe or generated package paths', () => {
    expect(isIgnoredSkillPackagePath('.git/HEAD')).toBe(true);
    expect(isIgnoredSkillPackagePath('nested/.git/config')).toBe(true);
    expect(isIgnoredSkillPackagePath('.env')).toBe(true);
    expect(isIgnoredSkillPackagePath('.env.local')).toBe(true);
    expect(isIgnoredSkillPackagePath('fixtures/.env.example')).toBe(true);
    expect(isIgnoredSkillPackagePath('.envrc')).toBe(true);
    expect(isIgnoredSkillPackagePath('.npmrc')).toBe(true);
    expect(isIgnoredSkillPackagePath('.netrc')).toBe(true);
    expect(isIgnoredSkillPackagePath('.pypirc')).toBe(true);
    expect(isIgnoredSkillPackagePath('.git-credentials')).toBe(true);
    expect(isIgnoredSkillPackagePath('.ssh/id_rsa')).toBe(true);
    expect(isIgnoredSkillPackagePath('nested/.aws/credentials')).toBe(true);
    expect(isIgnoredSkillPackagePath('.docker/config.json')).toBe(true);
    expect(isIgnoredSkillPackagePath('.gem/credentials')).toBe(true);
    expect(isIgnoredSkillPackagePath('.config/gcloud/application_default_credentials.json')).toBe(true);
    expect(isIgnoredSkillPackagePath('.pip/pip.conf')).toBe(true);
    expect(isIgnoredSkillPackagePath('.pip/pip.ini')).toBe(true);
    expect(isIgnoredSkillPackagePath('.config/pip/pip.conf')).toBe(true);
    expect(isIgnoredSkillPackagePath('.config/pip/pip.ini')).toBe(true);
    expect(isIgnoredSkillPackagePath('fixtures/.pip/pip.conf')).toBe(true);
    expect(isIgnoredSkillPackagePath('.config\\pip\\pip.ini')).toBe(true);
    expect(isIgnoredSkillPackagePath('.terraformrc')).toBe(true);
    expect(isIgnoredSkillPackagePath('terraform.rc')).toBe(true);
    expect(isIgnoredSkillPackagePath('credentials.tfrc.json')).toBe(true);
    expect(isIgnoredSkillPackagePath('fixtures/.terraformrc')).toBe(true);
    expect(isIgnoredSkillPackagePath('fixtures\\credentials.tfrc.json')).toBe(true);
    expect(isIgnoredSkillPackagePath('.m2/settings.xml')).toBe(true);
    expect(isIgnoredSkillPackagePath('.m2/settings-security.xml')).toBe(true);
    expect(isIgnoredSkillPackagePath('fixtures/.m2/settings.xml')).toBe(true);
    expect(isIgnoredSkillPackagePath('fixtures\\.m2\\settings-security.xml')).toBe(true);
    expect(isIgnoredSkillPackagePath('.venv/bin/python')).toBe(true);
    expect(isIgnoredSkillPackagePath('fixtures/.venv/pyvenv.cfg')).toBe(true);
    expect(isIgnoredSkillPackagePath('.hg/store/data')).toBe(true);
    expect(isIgnoredSkillPackagePath('fixtures\\.svn\\entries')).toBe(true);
    expect(isIgnoredSkillPackagePath('fixtures/.docker/config.json')).toBe(true);
    expect(isIgnoredSkillPackagePath('fixtures/.gem/credentials')).toBe(true);
    expect(isIgnoredSkillPackagePath('fixtures/.config/gcloud/application_default_credentials.json')).toBe(true);
    expect(isIgnoredSkillPackagePath('node_modules/pkg/index.js')).toBe(true);
    expect(isIgnoredSkillPackagePath('__MACOSX/._SKILL.md')).toBe(true);
    expect(isIgnoredSkillPackagePath('.DS_Store')).toBe(true);
    expect(isIgnoredSkillPackagePath('docs/._README.md')).toBe(true);
    expect(isIgnoredSkillPackagePath('.AWS/credentials')).toBe(true);
    expect(isIgnoredSkillPackagePath('.Docker/config.JSON')).toBe(true);
    expect(isIgnoredSkillPackagePath('.NPMRC')).toBe(true);
    expect(isIgnoredSkillPackagePath('docs/._Readme.md')).toBe(true);
    expect(isIgnoredSkillPackagePath('.kube/config')).toBe(true);
    expect(isIgnoredSkillPackagePath('.config/gh/hosts.yml')).toBe(true);
    expect(isIgnoredSkillPackagePath('.azure/accessTokens.json')).toBe(true);
    expect(isIgnoredSkillPackagePath('keys/id_ed25519')).toBe(true);
    expect(isIgnoredSkillPackagePath('certs/client.pem')).toBe(true);
    expect(isIgnoredSkillPackagePath('certs/client.key')).toBe(true);
    expect(isIgnoredSkillPackagePath('.ssh\\config')).toBe(true);
  });

  it('does not exclude arbitrary dot config fixtures', () => {
    expect(isIgnoredSkillPackagePath('.config/tool/settings.json')).toBe(false);
    expect(isIgnoredSkillPackagePath('.docker/example.json')).toBe(false);
    expect(isIgnoredSkillPackagePath('.terraform/modules.json')).toBe(false);
    expect(isIgnoredSkillPackagePath('docs/terraform.rc.md')).toBe(false);
    expect(isIgnoredSkillPackagePath('.m2/repository/index.properties')).toBe(false);
    expect(isIgnoredSkillPackagePath('settings.xml')).toBe(false);
    expect(isIgnoredSkillPackagePath('.cache/example.json')).toBe(false);
    expect(isIgnoredSkillPackagePath('.idea/inspectionProfiles/profile.xml')).toBe(false);
  });
});
