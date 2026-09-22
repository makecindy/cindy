// Shared with Mobile so paired sampling and freshness use one contract.
export {
  emptyRateHistory,
  recordRunningTokenRate,
  loadCachedRateHistory,
  saveCachedRateHistory,
  clearRateHistoryCache,
  RATE_SAMPLE_FRESH_MS,
  type RateHistory,
  type RateSample,
} from '@cindy/maker-shared';
