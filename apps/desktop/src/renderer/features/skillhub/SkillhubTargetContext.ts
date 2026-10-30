import { createContext, useContext } from 'react';
import type { SkillhubState, SkillhubProject } from './hooks/useSkillhub';
import type { MarketSkill } from './hooks/useMarketList';
import type {
  RemoteSkillMutation,
  RemoteSkillProject,
  RemoteSkillReceipt,
} from '../../../shared/remoteSkills';

export type SkillhubBrowseApi = Pick<
  Window['electronAPI']['skillhub'],
  | 'listMarket'
  | 'listCategories'
  | 'info'
  | 'getPublishedFiles'
  | 'readPublishedFile'
  | 'getScanStatus'
  | 'listChildren'
  | 'readSkill'
  | 'readSiblingFile'
>;

/** A selected computer supplies data/executors to the existing Skill views. */
export interface SkillhubTarget {
  name: string;
  ready: boolean;
  writable: boolean;
  state: SkillhubState;
  api: SkillhubBrowseApi;
  projects: Array<SkillhubProject & { target: RemoteSkillProject }>;
  refresh(): Promise<SkillhubSkill[]>;
  current(): boolean;
  mutate(
    kind: RemoteSkillMutation,
    skill?: SkillhubSkill,
    market?: { name: string; catalogScope?: 'market' | 'team'; latestVersion: string },
    project?: RemoteSkillProject,
  ): Promise<RemoteSkillReceipt>;
  openLocal(skill: SkillhubSkill): void;
  openMarket(skill: MarketSkill): void;
  openMarketList(): void;
  back(): void;
  displayPath(path: string): string;
}

export const SkillhubTargetContext = createContext<SkillhubTarget | null>(null);
export const useSkillhubTarget = () => useContext(SkillhubTargetContext);
export function useSkillhubBrowseApi(): SkillhubBrowseApi {
  return useSkillhubTarget()?.api ?? window.electronAPI.skillhub;
}
