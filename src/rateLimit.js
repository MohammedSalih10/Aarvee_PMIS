// In-memory failed-attempt limiter. The app runs as a single Node process
// (SQLite/WAL), so there's no shared store to worry about; counters reset on
// restart, which is acceptable for brute-force throttling.
function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs);
  sweep.unref();

  return {
    // Seconds until `key` may try again, or 0 if it isn't blocked.
    retryAfter(key) {
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= Date.now() || entry.count < max) return 0;
      return Math.ceil((entry.resetAt - Date.now()) / 1000);
    },
    fail(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) hits.set(key, { count: 1, resetAt: now + windowMs });
      else entry.count += 1;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

module.exports = { createLimiter };
