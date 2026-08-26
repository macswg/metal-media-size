/**
 * HTTP error shape shared by every route.
 *
 * The contract fixes this as `{ error: { code, message } }` with a sensible
 * status. Throwing `HttpError` from anywhere inside a handler is turned into
 * exactly that by the error handler installed in `app.ts`.
 */

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(code: string, message: string, details?: unknown): HttpError {
  return new HttpError(400, code, message, details);
}

export function notFound(code: string, message: string): HttpError {
  return new HttpError(404, code, message);
}

export function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

export function unavailable(code: string, message: string): HttpError {
  return new HttpError(503, code, message);
}

/** Narrow an unknown thrown value to something with an HTTP status attached. */
export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}

/**
 * A thrown value that carries a numeric `statusCode`, which is how Fastify
 * reports its own failures (bad JSON body, payload too large, and so on).
 */
export function hasStatusCode(err: unknown): err is { statusCode: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof (err as { statusCode: unknown }).statusCode === 'number'
  );
}

/** The message of an unknown thrown value, when it has a usable one. */
export function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string' &&
    (err as { message: string }).message !== ''
  ) {
    return (err as { message: string }).message;
  }
  return 'Unexpected error';
}
