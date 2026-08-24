import type { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
import { ZodError } from "zod";
import { HttpError } from "../errors";

/**
 * Top-level Express error-handling middleware (must be registered LAST, per
 * Express convention — see `index.ts`). Every route/middleware in this app
 * either throws/`next()`s an `HttpError` or lets an unexpected error
 * propagate here. This is the ONLY place that turns an error into an HTTP
 * response, so every error path produces the same consistent JSON shape
 * (`{ error: string }`) and never leaks a stack trace or internal detail to
 * the client — the real error is always logged server-side first.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  // eslint-disable-next-line no-console
  console.error("[api] request error:", err);

  if (res.headersSent) {
    // A response already started streaming — nothing safe left to send.
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }

  if (err instanceof MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "File exceeds the upload size limit." });
      return;
    }
    res.status(400).json({ error: `Upload error: ${err.message}` });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: "Invalid request.", details: err.issues.map((issue) => issue.message) });
    return;
  }

  // multer's fileFilter rejection surfaces as a plain Error, not a MulterError.
  if (err instanceof Error && err.message.startsWith("Unsupported file extension")) {
    res.status(400).json({ error: err.message });
    return;
  }

  res.status(500).json({ error: "Internal server error." });
}
