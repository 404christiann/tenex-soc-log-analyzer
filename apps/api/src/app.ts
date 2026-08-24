import express, { type Express } from "express";
import cors from "cors";
import { LlmStatusSchema } from "@tenex/shared";
import { logsRouter } from "./routes/logs";
import { errorHandler } from "./middleware/error-handler";

/**
 * Builds the Express app without binding a port — kept separate from
 * `index.ts` so tests can `import { createApp }` and drive it with
 * supertest/fetch directly, no real listening socket required.
 */
export function createApp(): Express {
  const app = express();

  // Basic functional CORS (DECISIONS.md's deferred-hardening note: this is
  // NOT the full per-environment origin-allowlist stretch item, just enough
  // for local dev to work without a wildcard silently undercutting the auth
  // model). Configured via env var, defaulting to the Next.js dev server.
  const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
  app.use(cors({ origin: frontendOrigin, credentials: true }));

  app.use(express.json());

  app.get("/health", (_req, res) => {
    // Parses through the shared Zod schema at runtime (not just type-checked)
    // to confirm @tenex/shared is wired up correctly end-to-end.
    const exampleLlmStatus = LlmStatusSchema.parse({ status: "not_configured" });

    res.json({
      status: "ok",
      service: "tenex-soc-log-analyzer-api",
      timestamp: new Date().toISOString(),
      sharedSchemaCheck: exampleLlmStatus,
    });
  });

  app.use("/api/logs", logsRouter);

  // Must be registered last — Express only routes an error to a
  // 4-arg middleware once every other route/middleware has been tried.
  app.use(errorHandler);

  return app;
}
