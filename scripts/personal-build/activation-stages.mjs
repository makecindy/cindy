/** Production handover phases shared with process-level fault rehearsals. */
export async function activatePreparedCandidate(store, release, {databasePlan, migrate, launch, verifyRetry, record}) {
  try {
    if (databasePlan) {
      record('database-preflight');
      store.markDatabaseUpgrade(databasePlan.backupDir);
      record('database-applying');
      await migrate(databasePlan);
      record('database-applied');
    }
    record('launching');
    let current;
    try { current = await launch(release); }
    catch (error) {
      if (!databasePlan || !verifyRetry || error.cleanedStartupFailure !== true) throw error;
      await verifyRetry(databasePlan);
      store.retryMigratedStartup(release, databasePlan.backupDir);
      record('retrying-startup', {firstFailure:error.message});
      current = await launch(release);
    }
    record('healthy');
    return current;
  } catch (error) {
    try { record('failed', {error:error.message}); }
    catch (recordError) { error.recordingError = recordError.message; }
    if (store.read().phase === 'trial') store.reject(error.message);
    throw error;
  }
}
