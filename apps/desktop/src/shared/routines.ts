import type { Routine, RoutineInput, RoutineRun, RoutineSource, RoutineDeliveryTarget } from '@cindy/maker-scheduler';
import type { NightlyLearningFrequency, NightlyLearningView } from './botNightlyLearning';

/** Fixed desktop bridge; event publishing is reserved for authenticated host sources. */
export interface RoutinesAPI {
  list(botId: string): Promise<Routine[]>;
  save(botId: string, input: RoutineInput, id?: string): Promise<Routine>;
  remove(botId: string, id: string): Promise<void>;
  runNow(botId: string, id: string): Promise<void>;
  history(botId: string, id: string): Promise<RoutineRun[]>;
  sources(): Promise<RoutineSource[]>;
  deliveryTargets?(botId: string): Promise<RoutineDeliveryTarget[]>;
  /** 伙伴设置「例行任务 → 夜间学习」。 */
  nightlyLearning: {
    get(botId: string): Promise<NightlyLearningView>;
    setEnabled(botId: string, enabled: boolean): Promise<NightlyLearningView>;
    setFrequency(botId: string, frequency: NightlyLearningFrequency): Promise<NightlyLearningView>;
    runNow(botId: string): Promise<NightlyLearningView>;
    revert(botId: string, runId: string, itemId: string, redo: boolean): Promise<NightlyLearningView>;
    candidate(botId: string, candidateId: string, action: 'promote' | 'decline'): Promise<NightlyLearningView>;
  };
  onChanged(listener: () => void): () => void;
}
