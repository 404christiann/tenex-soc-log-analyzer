import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseLogFile } from "../parser/parse-log";
import { runRuleEngine } from "../rules/engine";
import { getAnthropicClient, isAnthropicConfigured } from "./client";
import { judge } from "./judge";
import { streamSummary } from "./summary";

/**
 * Real end-to-end smoke test against the live Anthropic API (no mocking).
 *
 * Per the claude-api skill's auth-resolution guidance, an unset
 * `ANTHROPIC_API_KEY` doesn't by itself prove no credential is reachable —
 * an `ant auth login` profile could still resolve one via the SDK's full
 * credential chain. This repo's own graceful-degradation gate
 * (`isAnthropicConfigured()` in client.ts) is deliberately narrower than
 * that chain, keyed specifically to `ANTHROPIC_API_KEY` (DECISIONS.md §14a,
 * `.env.example`) — so that's the flag this smoke test gates on too: it's
 * the same condition the shipped app itself uses to decide whether the LLM
 * layer is reachable at all. (`ant auth status` was also checked directly
 * while writing this test: the `ant` CLI is not installed in this
 * environment, so it could not have supplied a credential here either.)
 */
const hasCredential = isAnthropicConfigured();

describe.skipIf(!hasCredential)("live Anthropic API smoke test (real network calls)", () => {
  it(
    "judge() and streamSummary() succeed against real anomalies from normal-traffic.log",
    async () => {
      const EXAMPLES_DIR = path.resolve(__dirname, "../../../../examples");
      const buf = fs.readFileSync(path.join(EXAMPLES_DIR, "normal-traffic.log"));
      const { events, errors, fileLevelError } = parseLogFile(buf);
      expect(fileLevelError).toBeUndefined();
      expect(errors).toEqual([]);

      const allAnomalies = runRuleEngine(events);
      expect(allAnomalies.length).toBeGreaterThan(0);
      // A small real slice — 2-3 candidates, per the phase brief — keeps
      // this smoke test cheap while still exercising a real batched call.
      const anomalies = allAnomalies.slice(0, 3);

      // Spy on the real client's messages.create to capture the JUDGE call's
      // usage for the report below, while still letting the real network
      // call through. The spy is restored BEFORE streamSummary runs: the
      // SDK's `messages.stream()` drives `messages.create` internally via
      // its APIPromise machinery, and the plain-Promise wrapper this spy
      // returns breaks that — discovered live when the streaming call
      // failed only under the spy.
      const client = getAnthropicClient();
      const originalCreate = client.messages.create.bind(client.messages);
      const usageLog: unknown[] = [];
      const spy = vi.spyOn(client.messages, "create").mockImplementation(((...args: any[]) => {
        return (originalCreate as any)(...args).then((response: any) => {
          usageLog.push({ model: response.model, usage: response.usage });
          return response;
        });
      }) as typeof client.messages.create);

      try {
        const judgeResult = await judge(anomalies, events);
        expect(judgeResult.status.status).toBe("ok");
        expect(judgeResult.candidateCount).toBe(anomalies.length);
        for (const a of judgeResult.anomalies) {
          expect(a.llmExplanation).toBeTruthy();
          expect(a.llmAdjustedConfidence).not.toBeNull();
        }
        // eslint-disable-next-line no-console
        console.log(
          "[live smoke test] judge() anomalies:\n" +
            judgeResult.anomalies
              .map((a) => `  - ${a.id}: base=${a.baseConfidence} adjusted=${a.llmAdjustedConfidence} -> ${a.llmExplanation}`)
              .join("\n"),
        );

        // Judge usage captured — restore the spy so the streaming call
        // below runs against the unwrapped SDK client (see comment above).
        spy.mockRestore();
        // eslint-disable-next-line no-console
        console.log("[live smoke test] judge token usage:\n" + JSON.stringify(usageLog, null, 2));

        // §14c: real streaming with adaptive thinking (display: summarized).
        // Thinking deltas are adaptive — the model decides whether/how much
        // to think — so their presence is logged, not hard-asserted; the
        // text deltas ARE asserted to reassemble into the final markdown.
        let thinkingText = "";
        let streamedText = "";
        const summaryResult = await streamSummary(events, judgeResult.anomalies, {
          onThinkingDelta: (delta) => {
            thinkingText += delta;
          },
          onTextDelta: (delta) => {
            streamedText += delta;
          },
        });
        expect(summaryResult.status.status).toBe("ok");
        expect(summaryResult.markdown.length).toBeGreaterThan(0);
        expect(streamedText.trim()).toBe(summaryResult.markdown);
        // eslint-disable-next-line no-console
        console.log(
          `[live smoke test] streamSummary() thinking (${thinkingText.length} chars):\n` +
            (thinkingText || "(model chose not to emit visible thinking on this run)"),
        );
        // eslint-disable-next-line no-console
        console.log("[live smoke test] streamSummary() markdown:\n" + summaryResult.markdown);
      } finally {
        // Safe no-op if the happy path already restored it above.
        spy.mockRestore();
      }
    },
    60_000,
  );
});

if (!hasCredential) {
  // eslint-disable-next-line no-console
  console.log(
    "[llm live smoke test] SKIPPED — no ANTHROPIC_API_KEY configured in this environment (and no `ant` CLI credential either). " +
      "Set ANTHROPIC_API_KEY and re-run `npm test --workspace=apps/api` to exercise the real judge()/streamSummary() integration.",
  );
}
