import { defineConfig } from "vitest/config";

/**
 * Unit tests only (`npm run test`). `./e2e` is Playwright's directory
 * (`playwright.config.ts`'s `testDir`, run via `npm run test:e2e`) — its
 * specs use Playwright's own `test`/`test.describe` globals, which throw
 * when collected by vitest, so it must stay excluded here.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "e2e/**"],
  },
});
