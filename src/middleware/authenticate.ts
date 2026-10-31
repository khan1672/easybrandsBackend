import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../config/env.js';

export const APP_KEY_HEADER = 'x-app-key';
export const APP_SECRET_HEADER = 'x-app-secret';

function matches(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Requires both client keys on every request; anything else is unauthenticated.
 *
 * This is a client gate, not real authentication: a value bundled with a mobile
 * app can always be extracted. It stops casual scraping and direct browser or
 * bookmark access to the API, which is all it is meant to do.
 */
export function authenticate(env: Env) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.get(APP_KEY_HEADER) ?? '';
    const secret = req.get(APP_SECRET_HEADER) ?? '';
    if (!matches(key, env.appKey) || !matches(secret, env.appSecret)) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    next();
  };
}

export default authenticate;
