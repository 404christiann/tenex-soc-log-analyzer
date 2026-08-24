/**
 * A single typed HTTP error shared by every middleware/route in this phase.
 * Thrown (or passed to `next()`) from anywhere in the request pipeline and
 * caught by `middleware/error-handler.ts`, which is the ONLY place that
 * turns it into a JSON response — so every rejection path (validation,
 * auth, not-found, upstream failures) produces the same consistent shape
 * and never leaks internals to the client.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
