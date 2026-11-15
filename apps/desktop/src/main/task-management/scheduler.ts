import { TASK_ARCHIVE_DAY_MS } from '../../shared/taskManagement.js';

/** Background maintenance starts only after the mounted UI has had time to settle. */
export function createTaskArchiveScheduler(ports: {
  check(force: boolean): Promise<void>;
  settled(): Promise<void>;
  invalidate(): void;
  warn(): void;
}) {
  let ready = false;
  let notBefore = 0;
  let generation = 0;
  let forced = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    generation++;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = (delay: number) => {
    cancel();
    const version = generation;
    timer = setTimeout(() => {
      timer = null;
      void ports
        .settled()
        .then(async () => {
          if (!ready || version !== generation) return;
          const force = forced;
          forced = false;
          await ports.check(force);
        })
        .catch(ports.warn)
        .finally(() => {
          if (ready && version === generation) arm(TASK_ARCHIVE_DAY_MS);
        });
    }, delay);
    timer.unref?.();
  };
  return {
    setReady(value: boolean) {
      if (ready === value) return;
      ready = value;
      cancel();
      ports.invalidate();
      forced = false;
      if (ready) {
        notBefore = Date.now() + 30_000;
        arm(30_000);
      }
    },
    request(force = true) {
      forced ||= force;
      if (ready) arm(Math.max(0, notBefore - Date.now()));
    },
  };
}
