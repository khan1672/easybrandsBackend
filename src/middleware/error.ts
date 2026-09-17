import type { Request, Response, NextFunction } from 'express';

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'Not found' });
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  const status = (err as { status?: number }).status ?? 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: status === 404 ? 'Not found' : err.message || 'Internal Server Error' });
}

export default { notFound, errorHandler };
