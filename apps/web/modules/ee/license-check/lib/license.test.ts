import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  TEnterpriseLicenseDetails,
  TEnterpriseLicenseFeatures,
} from "@/modules/ee/license-check/types/enterprise-license";

// Mock declarations must be at the top level
vi.mock("@/lib/env", () => ({
  env: {
    ENTERPRISE_LICENSE_KEY: "test-license-key",
    ENVIRONMENT: "production",
    VERCEL_URL: "some.vercel.url",
    FORMBRICKS_COM_URL: "https://app.formbricks.com",
    HTTPS_PROXY: undefined,
    HTTP_PROXY: undefined,
  },
}));

const mockCache = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  exists: vi.fn(),
  tryLock: vi.fn(),
  withCache: vi.fn(),
  getRedisClient: vi.fn(),
};

vi.mock("@/lib/cache", () => ({
  cache: mockCache,
}));

// Mock the createCacheKey functions
vi.mock("@formbricks/cache", () => ({
  createCacheKey: {
    license: {
      status: (identifier: string) => `fb:license:${identifier}:status`,
      previous_result: (identifier: string) => `fb:license:${identifier}:previous_result`,
      fetch_lock: (identifier: string) => `fb:license:${identifier}:fetch_lock`,
    },
    custom: (namespace: string, identifier: string, subResource?: string) => {
      const base = `fb:${namespace}:${identifier}`;
      return subResource ? `${base}:${subResource}` : base;
    },
  },
}));

const mockLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

vi.mock("@formbricks/logger", () => ({
  logger: mockLogger,
}));

// Mock constants as they are used in the original license.ts indirectly
vi.mock("@/lib/constants", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(typeof actual === "object" && actual !== null ? actual : {}),
    IS_FORMBRICKS_CLOUD: false,
    REVALIDATION_INTERVAL: 3600,
    ENTERPRISE_LICENSE_KEY: "test-license-key",
  };
});

/** All enterprise features enabled — matches DEFAULT_FEATURES in license.ts */
const ALL_ENABLED_FEATURES: TEnterpriseLicenseFeatures = {
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

describe("License Core Logic", () => {
  let originalProcessEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalProcessEnv = { ...process.env };
    vi.resetAllMocks();
    mockCache.get.mockReset();
    mockCache.set.mockReset();
    mockCache.del.mockReset();
    mockCache.exists.mockReset();
    mockCache.tryLock.mockReset();
    mockCache.withCache.mockReset();
    mockLogger.error.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.info.mockReset();
    mockLogger.debug.mockReset();

    // Set up default mock implementations for Result types
    mockCache.get.mockResolvedValue({ ok: true, data: null });
    mockCache.exists.mockResolvedValue({ ok: true, data: false });
    mockCache.tryLock.mockResolvedValue({ ok: true, data: true });
    mockCache.set.mockResolvedValue({ ok: true });

    vi.clearAllMocks();
    // Mock window to be undefined for server-side tests
    vi.stubGlobal("window", undefined);
  });

  afterEach(() => {
    process.env = originalProcessEnv;
    vi.unstubAllGlobals();
  });

  describe("getEnterpriseLicense", () => {
    test("should always return active license with all enterprise features enabled", async () => {
      const { getEnterpriseLicense } = await import("./license");

      const license = await getEnterpriseLicense();

      expect(license).toEqual({
        active: true,
        features: ALL_ENABLED_FEATURES,
        lastChecked: expect.any(Date),
        isPendingDowngrade: false,
        fallbackLevel: "live" as const,
        status: "active" as const,
      });
    });

    test("should return active even when ENTERPRISE_LICENSE_KEY is not set", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      const { getEnterpriseLicense } = await import("./license");
      const license = await getEnterpriseLicense();

      expect(license.active).toBe(true);
      expect(license.status).toBe("active");
      expect(license.features).toEqual(ALL_ENABLED_FEATURES);
    });

    test("should return null during build time (NEXT_PHASE = phase-production-build)", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      // eslint-disable-next-line turbo/no-undeclared-env-vars -- NEXT_PHASE is a Next.js env variable
      process.env.NEXT_PHASE = "phase-production-build";

      const { fetchLicense } = await import("./license");
      const result = await fetchLicense();

      expect(result).toBeNull();
    });
  });

  describe("getLicenseFeatures", () => {
    test("should return all features enabled since license is always active", async () => {
      vi.resetModules();
      vi.stubGlobal("window", undefined);

      const { getLicenseFeatures } = await import("./license");
      const features = await getLicenseFeatures();

      expect(features).toEqual(ALL_ENABLED_FEATURES);
    });
  });

  describe("fetchLicense cache behaviour", () => {
    test("should return cached license from FETCH_LICENSE_CACHE_KEY if available and valid", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      const cachedLicense: TEnterpriseLicenseDetails = {
        status: "active",
        features: ALL_ENABLED_FEATURES,
      };

      mockCache.get.mockImplementation(async (key: string) => {
        if (key.includes(":previous_result")) return { ok: true, data: null };
        if (key.includes(":status")) return { ok: true, data: { value: cachedLicense } };
        return { ok: true, data: null };
      });

      const { fetchLicense } = await import("./license");
      const result = await fetchLicense();

      expect(result).toEqual(cachedLicense);
      // Should have checked cache but NOT acquired lock
      expect(mockCache.tryLock).not.toHaveBeenCalled();
    });

    test("should acquire lock and populate cache when cache is cold", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      mockCache.get.mockResolvedValue({ ok: true, data: null });
      mockCache.tryLock.mockResolvedValue({ ok: true, data: true });
      mockCache.set.mockResolvedValue({ ok: true });

      const { fetchLicense } = await import("./license");
      const result = await fetchLicense();

      expect(mockCache.tryLock).toHaveBeenCalled();
      expect(mockCache.set).toHaveBeenCalledWith(
        expect.stringContaining("fb:license:"),
        { value: expect.objectContaining({ status: "active" }) },
        expect.any(Number)
      );
      expect(result).toEqual(expect.objectContaining({ status: "active" }));
    });

    test("should skip polling and fetch directly when Redis is unavailable (tryLock error)", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      // Redis is down: cache.get returns error, tryLock returns error
      mockCache.get.mockResolvedValue({ ok: false, error: { code: "redis_connection_error" } });
      mockCache.tryLock.mockResolvedValue({ ok: false, error: { code: "redis_connection_error" } });

      const startTime = Date.now();
      const { fetchLicense } = await import("./license");
      const result = await fetchLicense();
      const elapsed = Date.now() - startTime;

      // Should NOT have waited for polling — should complete quickly
      expect(elapsed).toBeLessThan(5000);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Redis unavailable during license fetch lock; skipping poll and fetching directly"
      );
      expect(result).toEqual(expect.objectContaining({ status: "active" }));
    });

    test("should poll and return cached value when another process holds the lock", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      const mockLicense: TEnterpriseLicenseDetails = {
        status: "active",
        features: ALL_ENABLED_FEATURES,
      };

      // Lock held by another process (ok: true, data: false)
      mockCache.tryLock.mockResolvedValue({ ok: true, data: false });

      // First get returns cache miss, subsequent gets return the populated license
      let getCalls = 0;
      mockCache.get.mockImplementation(async (key: string) => {
        if (key.includes(":status")) {
          getCalls++;
          if (getCalls <= 1) return { ok: true, data: null };
          return { ok: true, data: { value: mockLicense } };
        }
        return { ok: true, data: null };
      });

      const { fetchLicense } = await import("./license");
      const result = await fetchLicense();

      expect(result).toEqual(mockLicense);
    });

    test("should fall back to direct fetch after poll timeout when lock is held", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      // Lock held, cache never gets populated
      mockCache.tryLock.mockResolvedValue({ ok: true, data: false });
      mockCache.get.mockResolvedValue({ ok: true, data: null });
      mockCache.set.mockResolvedValue({ ok: true });

      const { fetchLicense } = await import("./license");
      const result = await fetchLicense();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ pollMs: expect.any(Number) }),
        "License cache not populated by holder within poll window; fetching in this process"
      );
      expect(result).toEqual(expect.objectContaining({ status: "active" }));
    });

    test("should return null during build time (NEXT_PHASE = phase-production-build)", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      // eslint-disable-next-line turbo/no-undeclared-env-vars -- NEXT_PHASE is a Next.js env variable
      process.env.NEXT_PHASE = "phase-production-build";

      const { fetchLicense } = await import("./license");
      const result = await fetchLicense();

      expect(result).toBeNull();
      expect(mockCache.get).not.toHaveBeenCalled();
    });
  });

  describe("Cache Key Generation", () => {
    beforeEach(() => {
      vi.resetAllMocks();
      mockCache.get.mockReset();
      mockCache.set.mockReset();
      mockCache.del.mockReset();
      mockCache.exists.mockReset();
      vi.resetModules();
    });

    test("should use 'browser' as cache key in browser environment", async () => {
      vi.stubGlobal("window", {});

      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      mockCache.get.mockResolvedValue({ ok: true, data: null });
      mockCache.tryLock.mockResolvedValue({ ok: true, data: true });
      mockCache.set.mockResolvedValue({ ok: true });

      const { fetchLicense } = await import("./license");
      await fetchLicense();
      expect(mockCache.get).toHaveBeenCalledWith(expect.stringContaining("fb:license:browser:status"));
    });

    test("should use 'no-license' identifier in cache key when ENTERPRISE_LICENSE_KEY is not set", async () => {
      vi.resetModules();
      vi.stubGlobal("window", undefined);
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: undefined,
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      const { getCacheKeys } = await import("./license");
      const keys = getCacheKeys();
      // When no license key is set, the identifier should be 'no-license'
      expect(keys.FETCH_LICENSE_CACHE_KEY).toContain("no-license");
    });

    test("should use hashed license key as cache key when ENTERPRISE_LICENSE_KEY is set", async () => {
      vi.resetModules();
      const testLicenseKey = "test-license-key";
      vi.stubGlobal("window", undefined);

      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: testLicenseKey,
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      mockCache.get.mockResolvedValue({ ok: true, data: null });
      mockCache.tryLock.mockResolvedValue({ ok: true, data: true });
      mockCache.set.mockResolvedValue({ ok: true });

      const { hashString } = await import("@/lib/hash-string");
      const expectedHash = hashString(testLicenseKey);
      const { fetchLicense } = await import("./license");
      await fetchLicense();
      expect(mockCache.get).toHaveBeenCalledWith(
        expect.stringContaining(`fb:license:${expectedHash}:status`)
      );
    });
  });

  describe("Error and Warning Logging", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    test("should log warning when setPreviousResult cache.set fails", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      const activeLicense: TEnterpriseLicenseDetails = {
        status: "active",
        features: ALL_ENABLED_FEATURES,
      };

      // Cache hit - fetchLicense returns wrapped cached license
      mockCache.get.mockImplementation(async (key: string) => {
        if (key.includes(":previous_result")) return { ok: true, data: null };
        if (key.includes(":status")) return { ok: true, data: { value: activeLicense } };
        return { ok: true, data: null };
      });

      // cache.set fails when setPreviousResult tries to save
      mockCache.set.mockResolvedValue({
        ok: false,
        error: new Error("Redis connection failed"),
      });

      const { computeFreshLicenseState } = await import("./license");
      await computeFreshLicenseState(activeLicense);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { error: new Error("Redis connection failed") },
        "Failed to cache previous result"
      );
    });
  });

  describe("computeFreshLicenseState", () => {
    const mockActiveLicenseDetails: TEnterpriseLicenseDetails = {
      status: "active",
      features: ALL_ENABLED_FEATURES,
    };

    beforeEach(() => {
      vi.resetModules();
      vi.resetAllMocks();
      mockCache.get.mockResolvedValue({ ok: true, data: null });
      mockCache.exists.mockResolvedValue({ ok: true, data: false });
      mockCache.set.mockResolvedValue({ ok: true });
    });

    test("should return active license state from pre-fetched active license", async () => {
      const { computeFreshLicenseState } = await import("./license");

      const result = await computeFreshLicenseState(mockActiveLicenseDetails);

      expect(result).toEqual({
        active: true,
        features: mockActiveLicenseDetails.features,
        lastChecked: expect.any(Date),
        isPendingDowngrade: false,
        fallbackLevel: "live",
        status: "active",
      });
    });

    test("should apply grace period fallback when freshLicense is null and previous result exists within grace", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      const previousTime = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
      const mockPreviousResult = {
        active: true,
        features: { removeBranding: true, projects: 5 },
        lastChecked: previousTime,
      };

      mockCache.get.mockImplementation(async (key: string) => {
        if (key.includes(":previous_result")) return { ok: true, data: mockPreviousResult };
        return { ok: true, data: null };
      });
      mockCache.set.mockResolvedValue({ ok: true });

      const { computeFreshLicenseState } = await import("./license");
      const result = await computeFreshLicenseState(null);

      expect(result).toEqual({
        active: true,
        features: mockPreviousResult.features,
        lastChecked: previousTime,
        isPendingDowngrade: true,
        fallbackLevel: "grace",
        status: "unreachable",
      });
    });

    test("should return inactive default when freshLicense is null and no previous result", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      mockCache.get.mockResolvedValue({ ok: true, data: null });
      mockCache.set.mockResolvedValue({ ok: true });

      const { computeFreshLicenseState } = await import("./license");
      const result = await computeFreshLicenseState(null);

      expect(result).toEqual({
        active: false,
        features: ALL_ENABLED_FEATURES,
        lastChecked: expect.any(Date),
        isPendingDowngrade: false,
        fallbackLevel: "default",
        status: "unreachable",
      });
    });

    test("should return expired state when freshLicense has expired status", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      mockCache.get.mockResolvedValue({ ok: true, data: null });
      mockCache.set.mockResolvedValue({ ok: true });

      const expiredLicense: TEnterpriseLicenseDetails = {
        status: "expired",
        features: ALL_ENABLED_FEATURES,
      };

      const { computeFreshLicenseState } = await import("./license");
      const result = await computeFreshLicenseState(expiredLicense);

      expect(result).toEqual({
        active: false,
        features: ALL_ENABLED_FEATURES,
        lastChecked: expect.any(Date),
        isPendingDowngrade: false,
        fallbackLevel: "default",
        status: "expired",
      });
    });
  });

  describe("clearLicenseCache", () => {
    test("should clear memory cache and delete FETCH_LICENSE_CACHE_KEY", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      mockCache.del.mockResolvedValue({ ok: true });

      const { clearLicenseCache } = await import("./license");
      await clearLicenseCache();

      expect(mockCache.del).toHaveBeenCalledWith(
        expect.arrayContaining([expect.stringContaining("fb:license:")])
      );
    });

    test("should log warning when cache.del fails", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      const { clearLicenseCache } = await import("./license");
      mockCache.del.mockResolvedValue({ ok: false, error: new Error("Redis error") });

      await clearLicenseCache();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { error: new Error("Redis error") },
        "Failed to delete license cache"
      );
    });
  });

  describe("fetchLicenseFresh", () => {
    test("should return active license with all features enabled without HTTP call", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      const { fetchLicenseFresh } = await import("./license");
      const result = await fetchLicenseFresh();

      expect(result).toEqual({
        status: "active",
        features: ALL_ENABLED_FEATURES,
      });
      // Cache should not be involved (fetchLicenseFresh bypasses cache)
      expect(mockCache.get).not.toHaveBeenCalled();
    });

    test("should return null during build time", async () => {
      vi.resetModules();
      vi.doMock("@/lib/env", () => ({
        env: {
          ENTERPRISE_LICENSE_KEY: "test-license-key",
          ENVIRONMENT: "production",
          VERCEL_URL: "some.vercel.url",
          FORMBRICKS_COM_URL: "https://app.formbricks.com",
          HTTPS_PROXY: undefined,
          HTTP_PROXY: undefined,
        },
      }));

      // eslint-disable-next-line turbo/no-undeclared-env-vars -- NEXT_PHASE is a Next.js env variable
      process.env.NEXT_PHASE = "phase-production-build";

      const { fetchLicenseFresh } = await import("./license");
      const result = await fetchLicenseFresh();

      expect(result).toBeNull();
    });
  });
});
