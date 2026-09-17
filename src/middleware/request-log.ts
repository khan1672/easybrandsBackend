import type { Request, Response, NextFunction } from 'express';

export function requestLog(enabled: boolean) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (enabled) console.log(`[req] ${req.method} ${req.originalUrl}`);
    next();
  };
}

export default requestLog;
