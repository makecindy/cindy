// Deliberately small, version-locked integration points. These are applied to a
// generated, self-host-only COPY of expo-updates, never to shared node_modules.
// Every replacement must match exactly once (or its explicit expected count).
const android = 'android/src/main/java/expo/modules/updates/';
const ios = 'ios/EXUpdates/';
const journal = 'expo.modules.updates.CindyOtaJournal';

function patches() {
  return [
    [android + 'UpdatesController.kt',
      '    val updatesConfiguration: UpdatesConfiguration? = overrideConfiguration ?: run {',
      '    try { overrideConfiguration = CindyOtaJournal.prepare(context) } catch (error: Exception) {\n' +
      '      logger.warn("Invalid self-host OTA native configuration")\n' +
      '      singletonInstance = DisabledUpdatesController(context, error)\n      return\n    }\n\n' +
      '    val updatesConfiguration: UpdatesConfiguration? = overrideConfiguration ?: run {'],
    [android + 'UpdatesModule.kt', '    Name("ExpoUpdates")',
      '    Name("ExpoUpdates")\n\n' +
      '    Function("cindySelfHostOtaCapabilities") { CindyOtaJournal.capabilities() }\n' +
      '    Function("cindyBeginSelfHostOtaRequest") { channel: String -> CindyOtaJournal.begin(channel) }\n' +
      '    Function("cindyFinishSelfHostOtaRequest") { token: String -> CindyOtaJournal.finish(token) }'],
    [android + 'EnabledUpdatesController.kt',
      '  override fun setUpdateRequestHeadersOverride(requestHeaders: Map<String, String>?) {',
      '  override fun setUpdateRequestHeadersOverride(requestHeaders: Map<String, String>?) {\n' +
      '    CindyOtaJournal.validateHeaders(requestHeaders)'],
    [android + 'loader/LoaderTask.kt',
      '      val launchableUpdate = launcher.getLaunchableUpdate(database)\n      val manifestFilters = ManifestMetadata.getManifestFilters(database, configuration)\n' +
      '      if (selectionPolicy.shouldLoadNewUpdate(\n          embeddedUpdate,\n          launchableUpdate,\n          manifestFilters\n        )\n      ) {',
      '      ' + journal + '.observeEmbedded(embeddedUpdate)\n' +
      '      // Register this signed binary even when old channel filters disagree.\n' +
      '      // Existing rows are reused by EmbeddedLoader; remote policy is unchanged.\n' +
      '      if (configuration.hasEmbeddedUpdate) {'],
    [android + 'procedures/FetchUpdateProcedure.kt',
      '    if (didRollBackToEmbedded) {',
      '    if (didRollBackToEmbedded) {\n      ' + journal + '.rolledBackToEmbedded()'],
    [android + 'procedures/FetchUpdateProcedure.kt',
      '        procedureContext.processStateEvent(UpdatesStateEvent.DownloadCompleteWithUpdate(availableUpdate.manifest))',
      '        val cindyStoredUpdate = checkNotNull(databaseHolder.database.updateDao().loadUpdateWithId(availableUpdate.id))\n' +
      '        ' + journal + '.downloaded(cindyStoredUpdate, updatesConfiguration)\n' +
      '        procedureContext.processStateEvent(UpdatesStateEvent.DownloadCompleteWithUpdate(availableUpdate.manifest))'],
    [android + 'selectionpolicy/LauncherSelectionPolicyFilterAware.kt',
      '  ): UpdateEntity? =\n    updates',
      '  ): UpdateEntity? {\n    ' + journal + '.select(updates, config)?.let { return it.update }\n    return updates'],
    [android + 'selectionpolicy/LauncherSelectionPolicyFilterAware.kt',
      '      .maxByOrNull { it.commitTime }\n}',
      '      .maxByOrNull { it.commitTime }\n  }\n}'],
    [android + 'selectionpolicy/ReaperSelectionPolicyFilterAware.kt',
      '    return updatesToDelete.filter { it.status != UpdateStatus.EMBEDDED }',
      '    return updatesToDelete.filter { it.status != UpdateStatus.EMBEDDED && !' + journal + '.pinned(it.id) }'],
    [android + 'launcher/DatabaseLauncher.kt',
      '  suspend fun launch(database: UpdatesDatabase) {',
      '  suspend fun launch(database: UpdatesDatabase) {\n' +
      '    try {\n      launchOnce(database)\n' +
      '    } catch (error: kotlinx.coroutines.CancellationException) {\n      throw error\n' +
      '    } catch (error: Exception) {\n' +
      '      if (!' + journal + '.failed(launchedUpdate)) throw error\n' +
      '      hasLaunched = false\n      launchAssetException = null\n      localAssetFiles = null\n' +
      '      launchAssetFile = null\n      launchOnce(database)\n    }\n  }\n\n' +
      '  private suspend fun launchOnce(database: UpdatesDatabase) {'],
    [android + 'launcher/DatabaseLauncher.kt',
      '    database.updateDao().markUpdateAccessed(launchedUpdate!!)',
      '    ' + journal + '.selected(launchedUpdate!!)\n    database.updateDao().markUpdateAccessed(launchedUpdate!!)'],
    [android + 'procedures/StartupProcedure.kt',
      '  private val errorRecovery = ErrorRecovery(logger)',
      '  private var errorRecovery = ErrorRecovery(logger)'],
    [android + 'procedures/StartupProcedure.kt',
      '  fun setLauncher(launcher: Launcher) {\n    this.launcher = launcher\n  }',
      '  fun setLauncher(launcher: Launcher) {\n' +
      '    errorRecovery = errorRecovery.cindyReplacement()\n' +
      '    this.launcher = launcher\n    initializeErrorRecovery()\n' +
      '    errorRecovery.cindyResumeMonitoring()\n  }'],
    [android + 'errorrecovery/ErrorRecoveryHandler.kt',
      '  private val pipeline = arrayListOf(',
      '  private val cindyEpochLock = Any()\n  private var cindyActive = true\n' +
      '  override fun dispatchMessage(msg: Message) {\n' +
      '    synchronized(cindyEpochLock) { if (cindyActive) super.dispatchMessage(msg) }\n  }\n' +
      '  internal fun cindyRetire() {\n' +
      '    synchronized(cindyEpochLock) { cindyActive = false; removeCallbacksAndMessages(null) }\n  }\n\n' +
      '  private val pipeline = arrayListOf('],
    [android + 'errorrecovery/ErrorRecovery.kt',
      '  private var shouldHandleReactInstanceException = false',
      '  private var shouldHandleReactInstanceException = false\n' +
      '  private var cindyDevSupportManager: DevSupportManager? = null\n' +
      '  internal fun cindyReplacement(): ErrorRecovery {\n' +
      '    unregisterContentAppearedListener()\n    unregisterErrorHandler()\n' +
      '    if (::handler.isInitialized) {\n' +
      '      (handler as ErrorRecoveryHandler).cindyRetire()\n      handlerThread.quitSafely()\n    }\n' +
      '    return ErrorRecovery(logger).also { it.cindyDevSupportManager = cindyDevSupportManager }\n  }\n' +
      '  internal fun cindyResumeMonitoring() { cindyDevSupportManager?.let { startMonitoring(it) } }'],
    [android + 'errorrecovery/ErrorRecovery.kt',
      '  fun startMonitoring(devSupportManager: DevSupportManager) {',
      '  fun startMonitoring(devSupportManager: DevSupportManager) {\n' +
      '    cindyDevSupportManager = devSupportManager\n    unregisterContentAppearedListener()'],
    [android + 'procedures/StartupProcedure.kt',
      '      override fun markFailedLaunchForLaunchedUpdate() {\n        if (emergencyLaunchException != null) {\n          return\n        }',
      '      override fun markFailedLaunchForLaunchedUpdate() {\n        if (emergencyLaunchException != null) {\n          return\n        }\n' +
      '        ' + journal + '.failed(launchedUpdate)'],
    [android + 'procedures/StartupProcedure.kt',
      '      override fun markSuccessfulLaunchForLaunchedUpdate() {\n        if (emergencyLaunchException != null) {\n          return\n        }',
      '      override fun markSuccessfulLaunchForLaunchedUpdate() {\n        if (emergencyLaunchException != null) {\n          return\n        }\n' +
      '        launchedUpdate?.let { ' + journal + '.confirmed(it) }'],

    [ios + 'UpdatesConfig.swift',
      '  public static func configWithExpoPlist(mergingOtherDictionary: [String: Any]?) throws -> UpdatesConfig {',
      '  internal static func cindyEmbeddedConfiguration() throws -> UpdatesConfig {\n' +
      '    let dictionary = try configDictionaryWithExpoPlist(mergingOtherDictionary: nil)\n' +
      '    return try config(fromDictionary: dictionary, configOverride: nil)\n  }\n\n' +
      '  public static func configWithExpoPlist(mergingOtherDictionary: [String: Any]?) throws -> UpdatesConfig {'],
    [ios + 'AppController.swift',
      '    let config = _overrideConfig != nil ? _overrideConfig : {',
      '    do { _overrideConfig = try CindyOtaJournal.prepare() } catch {\n' +
      '      UpdatesLogger().warn(message: "Invalid self-host OTA native configuration")\n' +
      '      _sharedInstance = DisabledAppController(error: UpdatesError.appControllerInitializationError(cause: error))\n      return\n    }\n\n' +
      '    let config = _overrideConfig != nil ? _overrideConfig : {'],
    [ios + 'UpdatesModule.swift', '    Name("ExpoUpdates")',
      '    Name("ExpoUpdates")\n\n' +
      '    Function("cindySelfHostOtaCapabilities") { CindyOtaJournal.capabilities() }\n' +
      '    Function("cindyBeginSelfHostOtaRequest") { (channel: String) throws -> String in try CindyOtaJournal.begin(channel) }\n' +
      '    Function("cindyFinishSelfHostOtaRequest") { (token: String) throws in try CindyOtaJournal.finish(token) }'],
    [ios + 'EnabledAppController.swift',
      '  public func setUpdateRequestHeadersOverride(_ requestHeaders: [String: String]?) throws {',
      '  public func setUpdateRequestHeadersOverride(_ requestHeaders: [String: String]?) throws {\n' +
      '    try CindyOtaJournal.validateHeaders(requestHeaders)'],
    [ios + 'AppLoader/AppLoaderTask.swift',
      '  private func loadEmbeddedUpdate(withCompletion completion: @escaping () -> Void) {',
      '  private func loadEmbeddedUpdate(withCompletion completion: @escaping () -> Void) {\n' +
      '    if let embedded = EmbeddedAppLoader.originalEmbeddedManifest(withConfig: config, database: database) {\n' +
      '      CindyOtaJournal.observeEmbedded(embedded)\n    }'],
    [ios + 'AppLoader/AppLoaderTask.swift',
      '          if self.config.hasEmbeddedUpdate && self.selectionPolicy.shouldLoadNewUpdate(\n' +
      '            EmbeddedAppLoader.embeddedManifest(withConfig: self.config, database: self.database),\n' +
      '            withLaunchedUpdate: launchableUpdate,\n            filters: manifestFilters\n          ) {',
      '          // Register only this signed binary; stale OTA filters must not hide it.\n' +
      '          if self.config.hasEmbeddedUpdate {'],
    [ios + 'Procedures/FetchUpdateProcedure.swift',
      '        if didRollBackToEmbedded {',
      '        if didRollBackToEmbedded {\n' +
      '          do { try CindyOtaJournal.rolledBackToEmbedded() } catch {\n' +
      '            self.successBlock(FetchUpdateResult.error(error: error))\n' +
      '            procedureContext.onComplete()\n            return\n          }'],
    [ios + 'Procedures/FetchUpdateProcedure.swift',
      '        if let update = updateToLaunch {\n          self.successBlock(FetchUpdateResult.success(manifest: update.manifest.rawManifestJSON()))',
      '        if let update = updateToLaunch {\n' +
      '          do {\n' +
      '            let stored = try self.database.databaseQueue.sync { try self.database.update(withId: update.updateId, config: self.config) }\n' +
      '            guard let stored else { throw NSError(domain: "CindySelfHostOTA", code: 2) }\n' +
      '            try CindyOtaJournal.downloaded(stored, config: self.config)\n' +
      '          } catch {\n' +
      '            self.successBlock(FetchUpdateResult.error(error: error))\n' +
      '            procedureContext.processStateEvent(.downloadError(errorMessage: "Self-host OTA journal commit failed"))\n' +
      '            procedureContext.onComplete()\n            return\n          }\n' +
      '          self.successBlock(FetchUpdateResult.success(manifest: update.manifest.rawManifestJSON()))'],
    [ios + 'SelectionPolicy/LauncherSelectionPolicyFilterAware.swift',
      '  public func launchableUpdate(fromUpdates updates: [Update], filters: [String: Any]?) -> Update? {\n    return updates',
      '  public func launchableUpdate(fromUpdates updates: [Update], filters: [String: Any]?) -> Update? {\n' +
      '    if let choice = CindyOtaJournal.select(updates, config: config) { return choice.update }\n    return updates'],
    [ios + 'SelectionPolicy/ReaperSelectionPolicyFilterAware.swift',
      '    return updatesToDelete\n',
      '    return updatesToDelete.filter { !CindyOtaJournal.pinned($0.updateId) }\n'],
    [ios + 'Procedures/StartupProcedure.swift',
      '  private let errorRecovery: ErrorRecovery',
      '  private var errorRecovery: ErrorRecovery'],
    [ios + 'Procedures/StartupProcedure.swift',
      '  internal func setLauncher(_ launcher: AppLauncher) {\n    self.launcher = launcher\n  }',
      '  internal func setLauncher(_ launcher: AppLauncher) {\n' +
      '    errorRecovery.cindyRetire()\n    self.launcher = launcher\n' +
      '    errorRecovery = ErrorRecovery(logger: logger)\n    errorRecovery.delegate = self\n  }'],
    [ios + 'ErrorRecovery.swift',
      '  private var pipeline: [ErrorRecoveryTask]',
      '  private var cindyActive = true\n  private var cindyInstalledHandlers = false\n' +
      '  internal func cindyRetire() {\n' +
      '    unregisterObservers()\n    errorRecoveryQueue.sync {\n' +
      '      self.cindyActive = false\n' +
      '      if self.cindyInstalledHandlers { self.unsetRCTErrorHandlers() }\n' +
      '      self.delegate = nil\n    }\n  }\n\n' +
      '  private var pipeline: [ErrorRecoveryTask]'],
    [ios + 'ErrorRecovery.swift',
      '    errorRecoveryQueue.async {',
      '    errorRecoveryQueue.async {\n      guard self.cindyActive else { return }', 4],
    [ios + 'ErrorRecovery.swift',
      '      self.errorRecoveryQueue.async {',
      '      self.errorRecoveryQueue.async {\n        guard self.cindyActive else { return }'],
    [ios + 'ErrorRecovery.swift',
      '      errorRecoveryQueue.asyncAfter(deadline: DispatchTime.now() + .milliseconds(remoteLoadTimeout)) {',
      '      errorRecoveryQueue.asyncAfter(deadline: DispatchTime.now() + .milliseconds(remoteLoadTimeout)) {\n' +
      '        guard self.cindyActive else { return }'],
    [ios + 'ErrorRecovery.swift',
      '    errorRecoveryQueue.asyncAfter(deadline: DispatchTime.now() + .seconds(10)) {',
      '    errorRecoveryQueue.asyncAfter(deadline: DispatchTime.now() + .seconds(10)) {\n' +
      '      guard self.cindyActive else { return }'],
    [ios + 'ErrorRecovery.swift',
      '    delegate?.markSuccessfulLaunchForLaunchedUpdate()\n    errorRecoveryQueue.async {\n      guard self.cindyActive else { return }',
      '    errorRecoveryQueue.async {\n      guard self.cindyActive else { return }\n' +
      '      self.delegate?.markSuccessfulLaunchForLaunchedUpdate()'],
    [ios + 'ErrorRecovery.swift',
      '    if previousFatalErrorHandler != nil || previousFatalExceptionHandler != nil {\n      return\n    }',
      '    if cindyInstalledHandlers { return }\n    cindyInstalledHandlers = true'],
    [ios + 'ErrorRecovery.swift',
      '  private func unsetRCTErrorHandlers() {',
      '  private func unsetRCTErrorHandlers() {\n' +
      '    guard cindyInstalledHandlers else { return }\n    cindyInstalledHandlers = false'],
    [ios + 'Procedures/StartupProcedure.swift',
      '  func markFailedLaunchForLaunchedUpdate() {\n    if emergencyLaunchException != nil {\n      return\n    }',
      '  func markFailedLaunchForLaunchedUpdate() {\n    if emergencyLaunchException != nil {\n      return\n    }\n' +
      '    CindyOtaJournal.failed(launchedUpdate())'],
    [ios + 'Procedures/StartupProcedure.swift',
      '  func markSuccessfulLaunchForLaunchedUpdate() {\n    if emergencyLaunchException != nil {\n      return\n    }',
      '  func markSuccessfulLaunchForLaunchedUpdate() {\n    if emergencyLaunchException != nil {\n      return\n    }\n' +
      '    if let update = launchedUpdate() { CindyOtaJournal.confirmed(update) }'],
    [ios + 'AppLauncher/AppLauncherWithDatabase.swift',
      '    self.completion = completion\n',
      '    self.completion = { [weak self] error, success in\n' +
      '      guard let self else { completion(error, success); return }\n' +
      '      if !success && CindyOtaJournal.failed(self.launchedUpdate) {\n' +
      '        self.completion = nil\n        self.launchedUpdate = nil\n        self.launchAssetUrl = nil\n' +
      '        self.launchAssetError = nil\n        self.assetFilesMap = nil\n        self.completedAssets = 0\n' +
      '        self.launchedFromEmbeddedBundle = false\n' +
      '        self.launchUpdate(withSelectionPolicy: selectionPolicy, completion: completion)\n' +
      '      } else { completion(error, success) }\n    }\n'],
    [ios + 'AppLauncher/AppLauncherWithDatabase.swift',
      '  private func finishLaunch() {\n    markUpdateAccessed()',
      '  private func finishLaunch() {\n' +
      '    if let update = launchedUpdate {\n' +
      '      do { try CindyOtaJournal.selected(update) } catch {\n' +
      '        let callback = self.completion\n        self.completion = nil\n' +
      '        callback?(UpdatesError.appLauncherNoLaunchableUpdates(cause: error), false)\n        return\n      }\n    }\n' +
      '    markUpdateAccessed()'],
    [ios + 'AppLauncher/AppLauncherWithDatabase.swift',
      'self.completion!(self.launchAssetError, self.launchAssetUrl != nil)\n        self.completion = nil',
      'let callback = self.completion\n        self.completion = nil\n        callback?(self.launchAssetError, self.launchAssetUrl != nil)'],
    [ios + 'AppLauncher/AppLauncherWithDatabase.swift',
      'self.completion!(self.launchAssetError, self.launchAssetUrl != nil)\n            self.completion = nil',
      'let callback = self.completion\n            self.completion = nil\n            callback?(self.launchAssetError, self.launchAssetUrl != nil)'],
    // Never silently select an unmodified prebuilt framework over the adapter.
    ['ios/EXUpdates.podspec',
      '  if !ex_updates_native_debug && !$ExpoUseSources&.include?(package[\'name\'])',
      '  if false && !ex_updates_native_debug && !$ExpoUseSources&.include?(package[\'name\'])'],
  ];
}

function replaceChecked(source, before, after, label, expected = 1) {
  if (source.split(before).length !== expected + 1) {
    throw new Error('Self-host OTA adapter anchor mismatch: ' + label);
  }
  return source.split(before).join(after);
}

function patchSources(readSource) {
  const result = new Map();
  for (const [file, before, after, expected] of patches()) {
    result.set(file, replaceChecked(result.get(file) ?? readSource(file), before, after, file, expected));
  }
  return result;
}

module.exports = { patchSources, replaceChecked, patches };
