import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 does not catch rejected promises from async handlers: a rejected
 * handler escapes as an unhandled rejection and takes the whole process down
 * instead of producing a 500. Every read path here is async (a Mongo query
 * that can fail), so handlers are wrapped once at registration rather than
 * repeating a try/catch in each controller.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export default { asyncHandler };
