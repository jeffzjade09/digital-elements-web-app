// Fixed-window rate limiting for the public (unauthenticated) endpoints: license
// validation, the plugin manifest/download, and plugin history. Those are the only
// routes reachable without a session, so they are the only ones an outsider can
// hammer — for enumeration attempts against license keys in particular.
//
// State is in-process, which matches how the app runs today (the sweep lock in
// scheduler.js assumes a single instance too). If this is ever scaled out,
// replace the Map with Redis or a Postgres-backed counter.

const buckets = new Map(); // `${name}:${ip}` -> { count, resetAt }

export function rateLimit({ windowMs = 60_000, max = 30, name = "public" } = {}) {
  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const key = `${name}:${req.ip}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: "Too many requests" });
    }
    return next();
  };
}

// Expire spent buckets so the map can't grow unbounded. unref() so this timer
// never holds the process open during shutdown.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000);
sweeper.unref();
