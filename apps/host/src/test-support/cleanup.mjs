// node:test runs a test's t.after hooks in the order they were registered, and a hook that throws
// skips the ones after it. A test that registers the removal of its temporary directory first and
// closes what lives in it afterwards passes on POSIX, which deletes open files. Windows refuses
// (EBUSY), and the servers, databases and runtimes the later hooks would have closed keep the test
// process alive until the job times out.
//
// lifoCleanup(t) returns the same test context whose after() runs last-in, first-out: what was
// opened last is closed first and the directory registered first is removed last. Every step runs
// even when an earlier one fails; the first failure is reported once all of them have run.
// Fixtures that receive the returned context register their steps the same way.
export function lifoCleanup(t) {
  const steps = [];
  t.after(async () => {
    let failure;
    while (steps.length > 0) {
      const step = steps.pop();
      try {
        await step();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  });
  return new Proxy(t, {
    get(target, property) {
      if (property === 'after') return (step) => { steps.push(step); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
