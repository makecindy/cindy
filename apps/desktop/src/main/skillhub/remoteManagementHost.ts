import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isSharedTaskPeer, isProviderSharePeer } from '@cindy/device-link';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap';
import { readDeviceLinkSettings } from '../device-link/settings-store';
import { capturePluginOauthPeer } from '../plugin-oauth/runtime';
import { RemoteSkillsManagement, type RemoteSkillRecord } from './remoteManagement';
import {
  scanAllSkills,
  readSkillContent,
  readSkillSiblingFile,
  listSkillFolderChildren,
  type Skill,
} from './scanner';
import {
  setCindySkillEnabled,
  isCindySkillEnabled,
  snapshotSkillActivation,
} from './activationPreferences';
import {
  inspectLocalSkillTarget,
  isLocalSkillTargetCurrent,
  isPluginManagedSkillPath,
} from './localSkillTarget';
import { tryAcquireSkillInstallLock } from './installLock';
import * as installService from './installService';
import type { SkillhubMarketService } from './marketService';
import type { RegisterSkillhubIpcOptions } from './registerIpc';
import type { RemoteSkillMarketItem, RemoteSkillProject } from '../../shared/remoteSkills';
import { readRemoteSkillCatalog } from './remoteCatalog';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function physicalRevision(skill: Skill): string {
  const files = [
    skill.absolutePath,
    skill.mdPath,
    ...(skill.discoveryPaths ?? [skill.discoveredPath]),
  ];
  return digest([
    files.map((file) => {
      const stat = fs.statSync(file);
      const link = fs.lstatSync(file);
      return [
        fs.realpathSync.native(file),
        stat.dev,
        stat.ino,
        stat.mtimeMs,
        stat.ctimeMs,
        stat.size,
        link.dev,
        link.ino,
      ];
    }),
    isCindySkillEnabled(skill.absolutePath),
    snapshotSkillActivation(skill.absolutePath),
  ]);
}
interface Target {
  skill: Skill;
  physical: string;
  uninstall: ReturnType<typeof inspectLocalSkillTarget>;
}

/** Adapt existing SkillHub services, preserving their locks, backups and trash semantics. */
export function createRemoteSkillsHost(
  options: RegisterSkillhubIpcOptions,
  marketService: SkillhubMarketService,
  changed: () => void,
  refresh: (workingDir?: string) => Promise<void>,
) {
  const projectTargets = async () =>
    (await options.getAllowedProjectRoots()).flatMap((root) => {
      try {
        const stat = fs.statSync(root);
        if (!stat.isDirectory()) return [];
        const real = fs.realpathSync.native(root);
        const identity =
          process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
        return [
          {
            root,
            view: {
              id: digest(identity),
              revision: digest([real, stat.dev, stat.ino]),
              name: path.basename(root),
            },
          },
        ];
      } catch {
        return [];
      }
    });
  const resolveProject = async (project: RemoteSkillProject) => {
    const match = (await projectTargets()).find(
      ({ view }) => view.id === project.id && view.revision === project.revision,
    );
    if (!match) throw new Error('Skill project changed');
    return match.root;
  };
  const scan = async (): Promise<RemoteSkillRecord<Target>[]> => {
    const targets = await projectTargets();
    const projects = targets.map(({ root, view }) => ({
      projectRoot: root,
      hash: view.id,
    }));
    const result = await scanAllSkills(
      { projects },
      options.getMaker(),
      options.getManagedSkillRoots(),
      options.getBuiltInSkills?.() ?? [],
    );
    if (!result.skills.length && result.sources.some((source) => source.status.state === 'error'))
      throw new Error('Skill discovery unavailable');
    return result.skills.flatMap((skill) => {
      try {
        const physical = physicalRevision(skill);
        const uninstall = inspectLocalSkillTarget(
          skill.absolutePath,
          skill.discoveryPaths ?? [skill.discoveredPath],
          options.getManagedSkillRoots(),
        );
        const managedByPlugin =
          skill.managedByPlugin === true ||
          isPluginManagedSkillPath(skill.absolutePath, options.getManagedSkillRoots());
        return [
          {
            target: { skill, physical, uninstall },
            linkOnly: uninstall?.linkOnly,
            view: {
              id: digest([skill.id, skill.absolutePath, skill.scope, skill.projectRoot]),
              revision: digest([physical, uninstall, skill.registryEntry]),
              name: skill.name,
              description: skill.description ?? '',
              kind: skill.kind,
              scope: skill.scope,
              project: skill.projectRoot ? path.basename(skill.projectRoot) : undefined,
              projectId: targets.find(({ root }) => root === skill.projectRoot)?.view.id,
              entryFile: path.basename(skill.mdPath),
              engines: skill.linkedEngines.map((engine) => engine.label),
              enabled: skill.cindyEnabled !== false,
              managedByPlugin,
              builtIn: skill.builtIn === true,
              canUninstall: !skill.builtIn && !managedByPlugin && uninstall !== null,
              version: skill.registryEntry?.version,
              market: skill.registryEntry
                ? {
                    name: skill.registrySkillName ?? skill.name,
                    catalogScope: skill.registryEntry.catalogScope,
                    origin: skill.registryEntry.origin,
                    authorId: skill.registryEntry.authorId,
                  }
                : undefined,
            },
          },
        ];
      } catch {
        return [];
      }
    });
  };
  const projectMarket = (item: {
    name: string;
    displayName: string;
    description: string;
    latestVersion: string;
    catalogScope?: 'market' | 'team';
  }): RemoteSkillMarketItem => ({
    name: item.name,
    displayName: item.displayName,
    description: item.description,
    version: item.latestVersion,
    catalogScope: item.catalogScope ?? 'market',
  });
  return new RemoteSkillsManagement<Target>({
    capture: (peer) => {
      const scope = captureDataOwnerBroadcastScope(),
        checkPeer = capturePluginOauthPeer(peer);
      const visible = () => {
        const settings = readDeviceLinkSettings();
        return (
          !isSharedTaskPeer(peer) &&
          !isProviderSharePeer(peer) &&
          settings.remoteControlEnabled &&
          !settings.revokedControllers.includes(peer) &&
          isDataOwnerBroadcastScopeCurrent(scope)
        );
      };
      return {
        visible,
        current: () => {
          try {
            checkPeer();
            return options.remoteIsRelayOnline?.() === true && visible();
          } catch {
            return false;
          }
        },
      };
    },
    scan,
    projects: async () => (await projectTargets()).map(({ view }) => view),
    catalog: (input) => readRemoteSkillCatalog(marketService, input),
    readFile: async (record, relativePath, children) => {
      const skill = record.target.skill;
      const root = skill.kind === 'skill' ? skill.absolutePath : path.dirname(skill.mdPath);
      const candidate = path.resolve(root, relativePath);
      const relative = path.relative(
        fs.realpathSync.native(root),
        fs.realpathSync.native(candidate),
      );
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        (skill.kind !== 'skill' && (children || candidate !== skill.mdPath))
      )
        throw new Error('Skill file unavailable');
      if (!children && fs.statSync(candidate).size > 1024 * 1024)
        throw new Error('Skill file too large');
      if (physicalRevision(skill) !== record.target.physical) throw new Error('Skill changed');
      const attestedRoot = skill.builtIn ? root : undefined;
      const result = children
        ? await listSkillFolderChildren({ dirPath: candidate, attestedRoot })
        : candidate.toLowerCase().endsWith('.md')
          ? await readSkillContent({ mdPath: candidate, attestedRoot })
          : await readSkillSiblingFile({ filePath: candidate, attestedRoot });
      if (!result.success || physicalRevision(skill) !== record.target.physical)
        throw new Error('Skill file unavailable');
      return result;
    },
    market: async (query, cursor) => {
      const result = await marketService.listMarket({ q: query, cursor, limit: 24, scope: 'all' });
      return { items: result.items.map(projectMarket), nextCursor: result.nextCursor };
    },
    latest: async (name, scope) => {
      const result = await marketService.info(name, scope);
      return 'info' in result && result.info ? projectMarket(result.info) : null;
    },
    detail: async (record) => {
      const result = await readSkillContent({
        mdPath: record.target.skill.mdPath,
        ...(record.view.builtIn ? { attestedRoot: record.target.skill.absolutePath } : {}),
      });
      if (!result.success || !('content' in result)) throw new Error('Skill detail unavailable');
      if (physicalRevision(record.target.skill) !== record.target.physical)
        throw new Error('Skill changed');
      return String(result.content).slice(0, 1024 * 1024);
    },
    mutate: async (kind, record, market, current, project) => {
      const projectRoot = project ? await resolveProject(project) : undefined;
      const allowed = async () =>
        (!project || (await resolveProject(project)) === projectRoot) &&
        (!record?.target.skill.projectRoot ||
          (await options.getAllowedProjectRoots()).some((root) => {
            const normalize = (value: string) =>
              process.platform === 'win32'
                ? path.resolve(value).toLowerCase()
                : path.resolve(value);
            return normalize(root) === normalize(record.target.skill.projectRoot!);
          }));
      const valid = () => {
        try {
          return (
            current() &&
            (!record ||
              (physicalRevision(record.target.skill) === record.target.physical &&
                !isPluginManagedSkillPath(
                  record.target.skill.absolutePath,
                  options.getManagedSkillRoots(),
                )))
          );
        } catch {
          return false;
        }
      };
      if (!valid() || !(await allowed()) || !valid()) throw new Error('Skill target changed');
      let workingDir: string | undefined;
      if (kind === 'enable' || kind === 'disable') {
        const release = tryAcquireSkillInstallLock(record!.target.skill.name, 'market-uninstall');
        if (!release) throw new Error('Skill busy');
        try {
          await setCindySkillEnabled(
            record!.target.skill.absolutePath,
            kind === 'enable',
            valid,
            record!.target.skill.discoveryPaths ?? [record!.target.skill.discoveredPath],
          );
        } finally {
          release();
        }
      } else if (kind === 'uninstall') {
        const target = record!.target.uninstall;
        if (!target || !isLocalSkillTargetCurrent(target)) throw new Error('Skill target changed');
        const result = await installService.uninstall(
          record!.target.skill.absolutePath,
          target,
          () =>
            current() &&
            !isPluginManagedSkillPath(target.sourcePath, options.getManagedSkillRoots()),
          async () => valid() && (await allowed()) && valid(),
        );
        if (!result.success) throw new Error('Skill uninstall failed');
        workingDir = result.projectWorkingDir;
      } else {
        const result = await installService.install(
          {
            name: market!.name,
            version: market!.version,
            catalogScope: market!.catalogScope,
            ...(projectRoot
              ? { installPath: path.join(projectRoot, '.agents', 'skills', market!.name) }
              : {}),
            ...(kind === 'update'
              ? { force: true, installPath: record!.target.skill.absolutePath }
              : {}),
          },
          () => {},
          { current, beforeCommit: async () => valid() && (await allowed()) && valid() },
        );
        if (!result.success) throw new Error('Skill install failed');
        workingDir = result.projectWorkingDir;
      }
      changed();
      await refresh(workingDir);
    },
  });
}
