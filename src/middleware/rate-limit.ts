import type { Request, Response, NextFunction } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window limiter, in memory.
 *
 * The chat endpoint forwards to a paid provider, so an unauthenticated caller
 * must not be able to spend arbitrary money by looping. Single-process state is
 * enough here: it is a guard rail against casual abuse, not a quota system.
 */
export function rateLimit(limit: number, windowMs: number) {
  const buckets = new Map<string, Bucket>();

  // Keep the map from growing without bound on a long-lived process.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs);
  sweep.unref?.();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (bucket.count >= limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('retry-after', String(retryAfter));
      res.status(429).json({
        error: 'Too many messages. Please wait a moment before asking again.',
        code: 'rate_limited',
      });
      return;
    }

    bucket.count += 1;
    next();
  };
}

export default { rateLimit };
