import type { Routine, RoutineInput, RoutineRun, RoutineSource } from '@cindy/maker-scheduler';

/** Fixed desktop bridge; event publishing is reserved for authenticated host sources. */
export interface RoutinesAPI {
  list(botId: string): Promise<Routine[]>;
  save(botId: string, input: RoutineInput, id?: string): Promise<Routine>;
  remove(botId: string, id: string): Promise<void>;
  runNow(botId: string, id: string): Promise<void>;
  history(botId: string, id: string): Promise<RoutineRun[]>;
  sources(): Promise<RoutineSource[]>;
  onChanged(listener: () => void): () => void;
}
