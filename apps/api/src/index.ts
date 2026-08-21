import "dotenv/config";
import express from "express";
import cors from "cors";
import { LlmStatusSchema } from "@tenex/shared";

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 4000;

app.use(cors());
app.use(express.json());

// Minimal health-check entrypoint for Phase 0. Real routes (upload, list,
// detail — DECISIONS.md §9/§10) are built in a later phase.
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

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${port}`);
});
