## agent-harness-runtime (6)
AnyAgentTool, NodeListNode, callGatewayTool, listNodes, resolveNodeIdFromList, selectDefaultNodeFromList

## browser-action-targets (1, local patch)
resolveActionTargetIds

## browser-config (3)
movePathToTrash, parseBrowserHttpUrl, redactCdpUrl

## cdp-locality (1, local patch)
isManagedLocalCdpConnection

## channel-actions (6)
imageResultFromFile, jsonResult, optionalStringEnum, readPositiveIntegerParam, readStringParam, stringEnum

## cli-runtime (6)
formatCliCommand, formatHelpExamples, inheritOptionFromParent, note, runCommandWithRuntime, theme

## config-contracts (3)
BrowserConfig, BrowserProfileConfig, OpenClawConfig

## config-mutation (2)
mutateConfigFile, replaceConfigFile

## core (1)
resolveGatewayPort

## error-runtime (1)
collectErrorGraphCandidates

## gateway-runtime (14)
ErrorCodes, GatewayRequestHandlers, GatewayRpcOpts, NodeSession, addGatewayClientOptions, callGatewayFromCli, ensureGatewayStartupAuth, errorShape, isLoopbackHost, isNodeCommandAllowed, resolveGatewayAuth, resolveNodeCommandAllowlist, respondUnavailableOnNodeInvokeError, safeParseJson

## json-store (2)
loadJsonFile, saveJsonFile

## logging-core (3)
createSubsystemLogger, redactSensitiveText, redactToolPayloadText

## media-mime (1)
detectMime

## media-runtime (7)
IMAGE_REDUCE_QUALITY_STEPS, buildImageResizeSideGrid, ensureMediaDir, getImageMetadata, isImageProcessorUnavailableError, resizeToJpeg, saveMediaBuffer

## media-understanding-runtime (1)
describeImageFile

## number-runtime (14)
MAX_TIMER_TIMEOUT_MS, addTimerTimeoutGraceMs, clampPositiveTimerTimeoutMs, clampTimerTimeoutMs, isFutureDateTimestampMs, parseFiniteNumber, parseStrictFiniteNumber, parseStrictInteger, parseStrictNonNegativeInteger, parseStrictPositiveInteger, resolveExpiresAtMsFromDurationMs, resolveIntegerOption, resolveNonNegativeIntegerOption, resolveTimerTimeoutMs

## plugin-config-runtime (2)
normalizePluginsConfig, resolveEffectiveEnableState

## plugin-entry (1)
OpenClawPluginService

## plugin-runtime (2)
LazyPluginServiceHandle, startLazyPluginServiceModule

## process-runtime (1)
prepareOomScoreAdjustedSpawn

## routing (3)
isAcpSessionKey, isCronSessionKey, isSubagentSessionKey

## runtime-config-snapshot (3)
getRuntimeConfig, getRuntimeConfigSnapshot, getRuntimeConfigSourceSnapshot

## runtime-env (4)
danger, defaultRuntime, info, registerUnhandledRejectionHandler

## security-runtime (28)
FsSafeError, LookupFn, SsrFBlockedError, SsrFPolicy, ensurePortAvailable, extractErrorCode, findExistingAncestor, formatErrorMessage, hasProxyEnvConfigured, isNotFoundPathError, isPathInside, isPrivateNetworkAllowedByPolicy, matchesHostnameAllowlist, normalizeHostname, pathScope, redactSensitiveText, resolveExistingPathsWithinRoot, resolvePathWithinRoot, resolvePathsWithinRoot, resolvePinnedHostnameWithPolicy, resolveStrictExistingPathsWithinRoot, resolveWritablePathWithinRoot, root, safeEqualSecret, sanitizeUntrustedFileName, wrapExternalContent, writeExternalFileWithinRoot, writeViaSiblingTempPath

## setup-tools (1)
formatDocsLink

## ssrf-runtime (1)
fetchWithSsrFGuard

## ssrf-runtime-internal (1)
registerManagedProxyBrowserCdpBypass

## string-coerce-runtime (10)
asNullableRecord, hasNonEmptyString, isRecord, normalizeLowercaseStringOrEmpty, normalizeOptionalLowercaseString, normalizeOptionalString, normalizeOptionalTrimmedStringList, readStringValue, uniqueStrings, uniqueValues

## temp-path (1)
resolvePreferredOpenClawTmpDir

## text-utility-runtime (4)
CONFIG_DIR, escapeRegExp, resolveUserPath, shortenHomePath
