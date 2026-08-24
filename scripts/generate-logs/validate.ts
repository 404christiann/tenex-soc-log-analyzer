/**
 * Verification script for the Phase 3 brief: parses each well-formed
 * example file back into a candidate object per DECISIONS.md §14a's wire
 * format (split on tab, then split each token on the *first* `=` only) and
 * validates it against the real `LogEventSchema` from `@tenex/shared` — the
 * same schema the parser/rule-engine phases will consume. Not a substitute
 * for the real parser (a later phase); just a schema-conformance spot check
 * so "every field validates" isn't taken on eyeball faith.
 *
 * Run with `npm run validate-logs` from the repo root.
 */
import fs from "node:fs";
import path from "node:path";
import { LogEventSchema } from "@tenex/shared";

const EXAMPLES_DIR = path.resolve(process.cwd(), "examples");
const FILES_TO_CHECK = ["normal-traffic.log", "quick-demo.log", "clean-traffic.log"];

function parseLineToCandidate(line: string): Record<string, unknown> | { __error: string } {
  const tokens = line.split("\t");
  const record: Record<string, string> = {};
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq === -1) return { __error: `token with no "=": "${tok}"` };
    const key = tok.slice(0, eq);
    const value = tok.slice(eq + 1);
    record[key] = value;
  }

  const required = ["datetime", "cip", "login", "url", "action", "urlcat", "threatname", "respcode", "bytes_out", "bytes_in", "useragent", "reqmethod"];
  for (const key of required) {
    if (!(key in record)) return { __error: `missing key "${key}"` };
  }

  return {
    datetime: record.datetime,
    cip: record.cip,
    login: record.login,
    url: record.url,
    action: record.action,
    urlcat: record.urlcat,
    threatname: record.threatname === "" ? null : record.threatname,
    respcode: Number(record.respcode),
    bytes_out: Number(record.bytes_out),
    bytes_in: Number(record.bytes_in),
    useragent: record.useragent,
    reqmethod: record.reqmethod,
  };
}

function checkFile(filename: string): { total: number; ok: number; failures: string[] } {
  const fullPath = path.join(EXAMPLES_DIR, filename);
  const content = fs.readFileSync(fullPath, "utf8");
  const lines = content.split("\n").filter((l) => l.length > 0);

  let ok = 0;
  const failures: string[] = [];

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const candidate = parseLineToCandidate(line);
    if ("__error" in candidate) {
      failures.push(`line ${lineNo}: parse error — ${candidate.__error}`);
      return;
    }
    const result = LogEventSchema.safeParse(candidate);
    if (result.success) {
      ok++;
    } else {
      failures.push(`line ${lineNo}: schema validation failed — ${JSON.stringify(result.error.issues)}`);
    }
  });

  return { total: lines.length, ok, failures };
}

function main() {
  let anyFailures = false;
  for (const filename of FILES_TO_CHECK) {
    const { total, ok, failures } = checkFile(filename);
    console.log(`${filename}: ${ok}/${total} lines valid against LogEventSchema`);
    if (failures.length > 0) {
      anyFailures = true;
      console.log(`  ${failures.length} failure(s):`);
      for (const f of failures.slice(0, 20)) console.log(`    - ${f}`);
      if (failures.length > 20) console.log(`    ... and ${failures.length - 20} more`);
    }
  }
  if (anyFailures) {
    console.error("\nvalidate-logs FAILED: one or more lines did not validate against LogEventSchema.");
    process.exit(1);
  }
  console.log("\nvalidate-logs OK: every line in every well-formed example file validates against LogEventSchema.");
}

main();
