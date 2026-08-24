import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * DECISIONS.md §14b — whole-system E2E suite. Deliberately NOT a mocked or
 * component-test setup: `webServer` below starts the REAL Next.js dev
 * server and the REAL Express API dev server, and the specs in `./e2e`
 * drive an actual browser against them. The third leg of the stack — a
 * local Supabase (Postgres/Auth/Storage) instance — is NOT started here; it
 * must already be running before this suite runs (`supabase status` to
 * check, `supabase start` if not — see README.md's "Run the test suites").
 * That's a deliberate choice: the local stack is slow to boot and is shared
 * with `apps/api`'s own integration suite, so it's a precondition of this
 * config rather than something Playwright spins up and tears down itself.
 *
 * Ports: the web server runs on 3018, matching `apps/api/.env`'s
 * `FRONTEND_ORIGIN=http://localhost:3018` — the API's CORS check is a hard
 * allowlist of exactly that origin (`apps/api/src/app.ts`), so running the
 * web dev server on Next's default 3000 here would make every API call
 * fail CORS. The API server runs on 4000, matching `apps/api/.env`'s
 * `PORT=4000` (also `apps/web/.env.local`'s `NEXT_PUBLIC_API_URL`).
 */
const WEB_PORT = 3018;
const API_PORT = 4000;
const WEB_DIR = __dirname;
const API_DIR = path.resolve(__dirname, "../api");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `npx next dev -p ${WEB_PORT}`,
      cwd: WEB_DIR,
      url: `http://localhost:${WEB_PORT}`,
      // Reuse an already-running dev server (e.g. from `npm run dev:web`)
      // rather than always starting a redundant one.
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "npm run dev",
      cwd: API_DIR,
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
