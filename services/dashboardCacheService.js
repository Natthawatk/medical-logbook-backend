const DEFAULT_TTL_MS = Number(process.env.DASHBOARD_CACHE_TTL_MS) || 60 * 1000;
const MAX_CACHE_ENTRIES = Number(process.env.DASHBOARD_CACHE_MAX_ENTRIES) || 1000;

const dashboardCache = new Map();
const inFlightComputations = new Map();

/**
 * Retrieve a cached entry if it exists and has not expired.
 * Refreshes key insertion order for LRU behavior.
 */
const getCached = (key) => {
  const normalizedKey = String(key || '');
  if (!normalizedKey) return { hit: false, value: undefined };

  const entry = dashboardCache.get(normalizedKey);
  if (!entry) return { hit: false, value: undefined };

  if (entry.expiresAt <= Date.now()) {
    dashboardCache.delete(normalizedKey);
    return { hit: false, value: undefined };
  }

  // Refresh LRU order
  dashboardCache.delete(normalizedKey);
  dashboardCache.set(normalizedKey, entry);
  return { hit: true, value: entry.value };
};

/**
 * Store a value in the dashboard cache with TTL and LRU eviction.
 */
const setCached = (key, value, ttlMs = DEFAULT_TTL_MS) => {
  const normalizedKey = String(key || '');
  if (!normalizedKey) return value;

  if (dashboardCache.has(normalizedKey)) {
    dashboardCache.delete(normalizedKey);
  } else if (dashboardCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = dashboardCache.keys().next().value;
    if (oldestKey !== undefined) {
      dashboardCache.delete(oldestKey);
    }
  }

  dashboardCache.set(normalizedKey, {
    value,
    expiresAt: Date.now() + Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS),
  });

  return value;
};

/**
 * Get value from cache or compute it once (deduplicating concurrent in-flight requests).
 */
const getOrCompute = async (key, computeFn, ttlMs = DEFAULT_TTL_MS) => {
  const normalizedKey = String(key || '');
  if (!normalizedKey) {
    const value = await computeFn();
    return { value, hit: false };
  }

  const cached = getCached(normalizedKey);
  if (cached.hit) {
    return { value: cached.value, hit: true };
  }

  const existingPromise = inFlightComputations.get(normalizedKey);
  if (existingPromise) {
    const value = await existingPromise;
    return { value, hit: true };
  }

  const computePromise = (async () => {
    try {
      const result = await computeFn();
      setCached(normalizedKey, result, ttlMs);
      return result;
    } finally {
      inFlightComputations.delete(normalizedKey);
    }
  })();

  inFlightComputations.set(normalizedKey, computePromise);
  const value = await computePromise;
  return { value, hit: false };
};

/**
 * Invalidate cache entries by prefix(es) or clear the entire dashboard cache.
 */
const invalidateDashboardCache = (options = {}) => {
  const prefixes = Array.isArray(options?.prefixes)
    ? options.prefixes.map((p) => String(p || '')).filter(Boolean)
    : [];

  if (prefixes.length === 0) {
    dashboardCache.clear();
    inFlightComputations.clear();
    return;
  }

  for (const key of [...dashboardCache.keys()]) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      dashboardCache.delete(key);
    }
  }
  for (const key of [...inFlightComputations.keys()]) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      inFlightComputations.delete(key);
    }
  }
};

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const NON_DASHBOARD_MUTATION_PREFIXES = [
  '/api/auth',
  '/api/otp',
  '/api/notifications',
];

/**
 * Express middleware that automatically invalidates the dashboard cache
 * whenever a mutating API request on domain resources succeeds (2xx).
 */
const dashboardCacheAutoInvalidateMiddleware = (req, res, next) => {
  if (!MUTATION_METHODS.has(req.method)) {
    return next();
  }

  const url = String(req.originalUrl || req.url || '').split('?')[0];
  if (NON_DASHBOARD_MUTATION_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return next();
  }

  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      invalidateDashboardCache();
    }
  });

  return next();
};

module.exports = {
  DEFAULT_TTL_MS,
  getCached,
  setCached,
  getOrCompute,
  invalidateDashboardCache,
  dashboardCacheAutoInvalidateMiddleware,
};
