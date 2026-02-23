import "server-only";
import { cache as reactCache } from "react";
import { z } from "zod";
import { createCacheKey } from "@formbricks/cache";
import { logger } from "@formbricks/logger";
import { cache } from "@/lib/cache";
import { env } from "@/lib/env";
import { hashString } from "@/lib/hash-string";
import {
  TEnterpriseLicenseDetails,
  TEnterpriseLicenseFeatures,
  TEnterpriseLicenseStatusReturn,
} from "@/modules/ee/license-check/types/enterprise-license";

// Configuration
const CONFIG = {
  CACHE: {
    FETCH_LICENSE_TTL_MS: 24 * 60 * 60 * 1000, // 24 hours
    FAILED_FETCH_TTL_MS: 10 * 60 * 1000, // 10 minutes for failed/null results
    PREVIOUS_RESULT_TTL_MS: 4 * 24 * 60 * 60 * 1000, // 4 days
    GRACE_PERIOD_MS: 3 * 24 * 60 * 60 * 1000, // 3 days
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000,
  },
  API: {
    ENDPOINT:
      env.ENVIRONMENT === "staging"
        ? "https://staging.ee.formbricks.com/api/licenses/check"
        : "https://ee.formbricks.com/api/licenses/check",
    TIMEOUT_MS: 5000,
  },
} as const;

export const GRACE_PERIOD_MS = CONFIG.CACHE.GRACE_PERIOD_MS;

/** TTL in ms for successful license fetch results (24h). Re-export for use in actions. */
export const FETCH_LICENSE_TTL_MS = CONFIG.CACHE.FETCH_LICENSE_TTL_MS;
/** TTL in ms for failed license fetch results (10 min). Re-export for use in actions. */
export const FAILED_FETCH_TTL_MS = CONFIG.CACHE.FAILED_FETCH_TTL_MS;

// Types
type FallbackLevel = "live" | "cached" | "grace" | "default";

type TEnterpriseLicenseResult = {
  active: boolean;
  features: TEnterpriseLicenseFeatures | null;
  lastChecked: Date;
  isPendingDowngrade: boolean;
  fallbackLevel: FallbackLevel;
  status: TEnterpriseLicenseStatusReturn;
};

type TPreviousResult = {
  active: boolean;
  lastChecked: Date;
  features: TEnterpriseLicenseFeatures | null;
};

// Wrapper type for cached license fetch results.
// Storing { value: <result> } instead of <result> directly lets us distinguish
// "key not in cache" (get returns null) from "key exists with a null value"
// ({ value: null }) in a single cache.get call, eliminating the TOCTOU race
// that existed between separate get + exists calls.
type TCachedFetchResult = { value: TEnterpriseLicenseDetails | null };

// Validation schemas
const LicenseFeaturesSchema = z.object({
  isMultiOrgEnabled: z.boolean(),
  projects: z.number().nullable(),
  twoFactorAuth: z.boolean(),
  sso: z.boolean(),
  whitelabel: z.boolean(),
  removeBranding: z.boolean(),
  contacts: z.boolean(),
  ai: z.boolean(),
  saml: z.boolean(),
  spamProtection: z.boolean(),
  auditLogs: z.boolean(),
  multiLanguageSurveys: z.boolean(),
  accessControl: z.boolean(),
  quotas: z.boolean(),
});

const LicenseDetailsSchema = z.object({
  status: z.enum(["active", "expired"]),
  features: LicenseFeaturesSchema,
});

// Error types
class LicenseError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "LicenseError";
  }
}

export class LicenseApiError extends LicenseError {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message, "API_ERROR");
    this.name = "LicenseApiError";
  }
}

// Cache keys using enterprise-grade hierarchical patterns
const getCacheIdentifier = () => {
  if (globalThis.window !== undefined) {
    return "browser"; // Browser environment
  }
  if (!env.ENTERPRISE_LICENSE_KEY) {
    return "no-license"; // No license key provided
  }
  return hashString(env.ENTERPRISE_LICENSE_KEY); // Valid license key
};

const LICENSE_FETCH_LOCK_TTL_MS = 90 * 1000; // 90s lock so only one process fetches when cache is cold
const LICENSE_FETCH_POLL_MS = 2 * 1000; // Wait up to 2s for another process to populate cache
const LICENSE_FETCH_POLL_INTERVAL_MS = 400;

export const getCacheKeys = () => {
  const identifier = getCacheIdentifier();
  return {
    FETCH_LICENSE_CACHE_KEY: createCacheKey.license.status(identifier),
    PREVIOUS_RESULT_CACHE_KEY: createCacheKey.license.previous_result(identifier),
    FETCH_LOCK_CACHE_KEY: createCacheKey.license.fetch_lock(identifier),
  };
};

// Default features — all enterprise capabilities enabled unconditionally.
// This intentionally bypasses license enforcement so all features are available.
const DEFAULT_FEATURES: TEnterpriseLicenseFeatures = {
  isMultiOrgEnabled: true,
  projects: null,
  twoFactorAuth: true,
  sso: true,
  whitelabel: true,
  removeBranding: true,
  contacts: true,
  ai: true,
  saml: true,
  spamProtection: true,
  auditLogs: true,
  multiLanguageSurveys: true,
  accessControl: true,
  quotas: true,
};

// Helper functions
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const validateConfig = () => {
  const errors: string[] = [];
  if (CONFIG.CACHE.GRACE_PERIOD_MS >= CONFIG.CACHE.PREVIOUS_RESULT_TTL_MS) {
    errors.push("Grace period must be shorter than previous result TTL");
  }
  if (CONFIG.CACHE.MAX_RETRIES < 0) {
    errors.push("Max retries must be non-negative");
  }
  if (errors.length > 0) {
    throw new LicenseError(errors.join(", "), "CONFIG_ERROR");
  }
};

// Cache functions with async pattern
let getPreviousResultPromise: Promise<TPreviousResult> | null = null;

const getPreviousResult = async (): Promise<TPreviousResult> => {
  if (getPreviousResultPromise) return getPreviousResultPromise;

  getPreviousResultPromise = (async () => {
    if (globalThis.window !== undefined) {
      return {
        active: false,
        lastChecked: new Date(0),
        features: DEFAULT_FEATURES,
      };
    }

    try {
      const result = await cache.get<TPreviousResult>(getCacheKeys().PREVIOUS_RESULT_CACHE_KEY);
      if (result.ok && result.data) {
        return {
          ...result.data,
          lastChecked: new Date(result.data.lastChecked),
        };
      }
    } catch (error) {
      logger.error({ error }, "Failed to get previous result from cache");
    }

    return {
      active: false,
      lastChecked: new Date(0),
      features: DEFAULT_FEATURES,
    };
  })();

  getPreviousResultPromise
    .finally(() => {
      getPreviousResultPromise = null;
    })
    .catch(() => {});

  return getPreviousResultPromise;
};

const setPreviousResult = async (previousResult: TPreviousResult) => {
  if (globalThis.window !== undefined) return;

  try {
    const result = await cache.set(
      getCacheKeys().PREVIOUS_RESULT_CACHE_KEY,
      previousResult,
      CONFIG.CACHE.PREVIOUS_RESULT_TTL_MS
    );
    if (!result.ok) {
      logger.warn({ error: result.error }, "Failed to cache previous result");
    }
  } catch (error) {
    logger.error({ error }, "Failed to set previous result in cache");
  }
};

// Monitoring functions
const trackFallbackUsage = (level: FallbackLevel) => {
  logger.info(
    {
      fallbackLevel: level,
      timestamp: new Date().toISOString(),
    },
    `Using license fallback level: ${level}`
  );
};

const trackApiError = (error: LicenseApiError) => {
  logger.error(
    {
      status: error.status,
      code: error.code,
      timestamp: new Date().toISOString(),
    },
    `License API error: ${error.message}`
  );
};

// Validation functions
const validateFallback = (previousResult: TPreviousResult): boolean => {
  if (!previousResult.features) return false;
  if (previousResult.lastChecked.getTime() === new Date(0).getTime()) return false;
  return true;
};

const validateLicenseDetails = (data: unknown): TEnterpriseLicenseDetails => {
  return LicenseDetailsSchema.parse(data);
};

// Fallback functions
let memoryCache: {
  data: TEnterpriseLicenseResult;
  timestamp: number;
} | null = null;

const MEMORY_CACHE_TTL_MS = 60 * 1000; // 1 minute memory cache to avoid stampedes and reduce load when Redis is slow

let getEnterpriseLicensePromise: Promise<TEnterpriseLicenseResult> | null = null;

const getFallbackLevel = (
  liveLicense: TEnterpriseLicenseDetails | null,
  previousResult: TPreviousResult,
  currentTime: Date
): FallbackLevel => {
  if (liveLicense?.status === "active") return "live";
  if (previousResult.active) {
    const elapsedTime = currentTime.getTime() - previousResult.lastChecked.getTime();
    return elapsedTime < CONFIG.CACHE.GRACE_PERIOD_MS ? "grace" : "default";
  }
  return "default";
};

const handleInitialFailure = async (currentTime: Date): Promise<TEnterpriseLicenseResult> => {
  const initialFailResult: TPreviousResult = {
    active: false,
    features: DEFAULT_FEATURES,
    lastChecked: currentTime,
  };
  await setPreviousResult(initialFailResult);
  return {
    active: false,
    features: DEFAULT_FEATURES,
    lastChecked: currentTime,
    isPendingDowngrade: false,
    fallbackLevel: "default" as const,
    status: "unreachable" as const,
  };
};

/**
 * Try to read cached license from Redis. Returns undefined on miss or error.
 */
const getCachedLicense = async (): Promise<TEnterpriseLicenseDetails | null | undefined> => {
  const keys = getCacheKeys();
  const result = await cache.get<TCachedFetchResult>(keys.FETCH_LICENSE_CACHE_KEY);
  if (!result.ok) return undefined;
  if (result.data !== null && result.data !== undefined && "value" in result.data) {
    return result.data.value;
  }
  return undefined;
};

// API functions
let fetchLicensePromise: Promise<TEnterpriseLicenseDetails | null> | null = null;

const fetchLicenseFromServerInternal = async (): Promise<TEnterpriseLicenseDetails | null> => {
  // Skip license checks during build time
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- NEXT_PHASE is a next.js env variable
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return null;
  }
  return { status: "active", features: DEFAULT_FEATURES };
};

export const fetchLicense = async (): Promise<TEnterpriseLicenseDetails | null> => {
  // Skip license checks during build time - check before cache access
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- NEXT_PHASE is a next.js env variable
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return null;
  }

  if (fetchLicensePromise) {
    return fetchLicensePromise;
  }

  fetchLicensePromise = (async () => {
    const keys = getCacheKeys();
    const cached = await getCachedLicense();
    if (cached !== undefined) return cached;

    const lockResult = await cache.tryLock(keys.FETCH_LOCK_CACHE_KEY, "1", LICENSE_FETCH_LOCK_TTL_MS);
    const acquired = lockResult.ok && lockResult.data === true;
    const redisError = !lockResult.ok;

    if (acquired) {
      try {
        const fresh = await fetchLicenseFromServerInternal();
        const ttl = fresh ? CONFIG.CACHE.FETCH_LICENSE_TTL_MS : CONFIG.CACHE.FAILED_FETCH_TTL_MS;

        if (!fresh) {
          logger.warn(
            {
              ttlMinutes: Math.floor(ttl / 60000),
              timestamp: new Date().toISOString(),
            },
            "License fetch failed, caching null result with short TTL for faster retry"
          );
        }

        await cache.set(keys.FETCH_LICENSE_CACHE_KEY, { value: fresh }, ttl);
        return fresh;
      } finally {
        // Lock expires automatically; no need to release
      }
    }

    // If Redis itself is down, skip the polling loop (it would just fail repeatedly)
    // and go directly to fetching from the server.
    if (redisError) {
      logger.warn("Redis unavailable during license fetch lock; skipping poll and fetching directly");
      return await fetchLicenseFromServerInternal();
    }

    // Another process holds the lock — poll until the cache is populated or timeout
    const deadline = Date.now() + LICENSE_FETCH_POLL_MS;
    while (Date.now() < deadline) {
      await sleep(LICENSE_FETCH_POLL_INTERVAL_MS);
      const value = await getCachedLicense();
      if (value !== undefined) return value;
    }

    logger.warn(
      { pollMs: LICENSE_FETCH_POLL_MS },
      "License cache not populated by holder within poll window; fetching in this process"
    );
    const fallback = await fetchLicenseFromServerInternal();
    const fallbackTtl = fallback ? CONFIG.CACHE.FETCH_LICENSE_TTL_MS : CONFIG.CACHE.FAILED_FETCH_TTL_MS;
    await cache.set(keys.FETCH_LICENSE_CACHE_KEY, { value: fallback }, fallbackTtl);
    return fallback;
  })();

  fetchLicensePromise
    .finally(() => {
      fetchLicensePromise = null;
    })
    .catch(() => {});

  return fetchLicensePromise;
};

/**
 * Core license state evaluation logic.
 * Accepts pre-fetched license details and applies fallback / grace-period rules.
 * Sets the in-process memoryCache as a side effect so subsequent requests benefit.
 */
const computeLicenseState = async (
  liveLicenseDetails: TEnterpriseLicenseDetails | null
): Promise<TEnterpriseLicenseResult> => {
  validateConfig();

  if (!env.ENTERPRISE_LICENSE_KEY || env.ENTERPRISE_LICENSE_KEY.length === 0) {
    return {
      active: false,
      features: null,
      lastChecked: new Date(),
      isPendingDowngrade: false,
      fallbackLevel: "default" as const,
      status: "no-license" as const,
    };
  }

  const currentTime = new Date();
  const previousResult = await getPreviousResult();
  const fallbackLevel = getFallbackLevel(liveLicenseDetails, previousResult, currentTime);
  trackFallbackUsage(fallbackLevel);

  let currentLicenseState: TPreviousResult | undefined;

  switch (fallbackLevel) {
    case "live": {
      if (!liveLicenseDetails) throw new Error("Invalid state: live license expected");
      currentLicenseState = {
        active: liveLicenseDetails.status === "active",
        features: liveLicenseDetails.features,
        lastChecked: currentTime,
      };

      // Only update previous result if it's actually different or if it's old (1 hour)
      // This prevents hammering Redis on every request when the license is active
      if (
        !previousResult.active ||
        previousResult.active !== currentLicenseState.active ||
        currentTime.getTime() - previousResult.lastChecked.getTime() > 60 * 60 * 1000
      ) {
        await setPreviousResult(currentLicenseState);
      }

      const liveResult: TEnterpriseLicenseResult = {
        active: currentLicenseState.active,
        features: currentLicenseState.features,
        lastChecked: currentTime,
        isPendingDowngrade: false,
        fallbackLevel: "live" as const,
        status: liveLicenseDetails.status,
      };
      memoryCache = { data: liveResult, timestamp: Date.now() };
      return liveResult;
    }

    case "grace": {
      if (!validateFallback(previousResult)) {
        return await handleInitialFailure(currentTime);
      }
      logger.warn(
        {
          lastChecked: previousResult.lastChecked.toISOString(),
          gracePeriodEnds: new Date(
            previousResult.lastChecked.getTime() + CONFIG.CACHE.GRACE_PERIOD_MS
          ).toISOString(),
          timestamp: new Date().toISOString(),
        },
        "License server unreachable, using grace period. Will retry in ~10 minutes."
      );
      const graceResult: TEnterpriseLicenseResult = {
        active: previousResult.active,
        features: previousResult.features,
        lastChecked: previousResult.lastChecked,
        isPendingDowngrade: true,
        fallbackLevel: "grace" as const,
        status: (liveLicenseDetails?.status as TEnterpriseLicenseStatusReturn) ?? "unreachable",
      };
      memoryCache = { data: graceResult, timestamp: Date.now() };
      return graceResult;
    }

    case "default": {
      if (liveLicenseDetails?.status === "expired") {
        const expiredResult: TEnterpriseLicenseResult = {
          active: false,
          features: DEFAULT_FEATURES,
          lastChecked: currentTime,
          isPendingDowngrade: false,
          fallbackLevel: "default" as const,
          status: "expired" as const,
        };
        memoryCache = { data: expiredResult, timestamp: Date.now() };
        return expiredResult;
      }
      const failResult = await handleInitialFailure(currentTime);
      memoryCache = { data: failResult, timestamp: Date.now() };
      return failResult;
    }
  }

  const finalFailResult = await handleInitialFailure(currentTime);
  memoryCache = { data: finalFailResult, timestamp: Date.now() };
  return finalFailResult;
};

export const getEnterpriseLicense = reactCache(async (): Promise<TEnterpriseLicenseResult> => {
  return {
    active: true,
    features: DEFAULT_FEATURES,
    lastChecked: new Date(),
    isPendingDowngrade: false,
    fallbackLevel: "live" as const,
    status: "active" as const,
  };
});

export const getLicenseFeatures = async (): Promise<TEnterpriseLicenseFeatures | null> => {
  try {
    const licenseState = await getEnterpriseLicense();
    return licenseState.active ? licenseState.features : null;
  } catch (e) {
    logger.error(e, "Error getting license features");
    return null;
  }
};

/**
 * Clear license fetch cache (but preserve previous result cache for grace period)
 * Used by the recheck license action to force a fresh fetch without losing grace period
 */
export const clearLicenseCache = async (): Promise<void> => {
  memoryCache = null;
  const cacheKeys = getCacheKeys();
  // Only clear the main fetch cache, NOT the previous result cache
  // This preserves the grace period fallback if the server is unreachable
  const delResult = await cache.del([cacheKeys.FETCH_LICENSE_CACHE_KEY]);
  if (!delResult.ok) {
    logger.warn({ error: delResult.error }, "Failed to delete license cache");
  }
};

/**
 * Fetch license directly from server without using cache.
 * Used by the recheck license action for a fresh check.
 * Concurrent callers share a single in-flight request to avoid
 * hammering the license server (e.g. multiple managers rechecking).
 */
let fetchLicenseFreshPromise: Promise<TEnterpriseLicenseDetails | null> | null = null;

export const fetchLicenseFresh = async (): Promise<TEnterpriseLicenseDetails | null> => {
  if (fetchLicenseFreshPromise) return fetchLicenseFreshPromise;

  fetchLicenseFreshPromise = fetchLicenseFromServerInternal();

  fetchLicenseFreshPromise
    .finally(() => {
      fetchLicenseFreshPromise = null;
    })
    .catch(() => {});

  return fetchLicenseFreshPromise;
};

/**
 * Compute license state from pre-fetched license data, bypassing React cache
 * and the in-process memory cache. Used by the recheck action to guarantee
 * fresh evaluation after clearing caches and fetching new data.
 * Refreshes the in-process memory cache as a side effect so subsequent
 * requests benefit from the fresh result.
 */
export const computeFreshLicenseState = async (
  freshLicense: TEnterpriseLicenseDetails | null
): Promise<TEnterpriseLicenseResult> => {
  memoryCache = null;
  return computeLicenseState(freshLicense);
};

// All permission checking functions and their helpers have been moved to utils.ts
