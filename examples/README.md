# Example log files

Four synthetic Zscaler-NSS-style proxy logs (DECISIONS.md §1, §13, §14a), generated
deterministically by `scripts/generate-logs/generate.ts` (`@faker-js/faker`, `faker.seed(42)`).
Regenerate with `npm run generate-logs` from the repo root — the output is byte-identical every
run given the same generator code. See `ANSWER_KEY.md` for exactly which rows are injected
anomalies and why; that file is a development-time validation artifact only, never read by the
detection code itself.

## `normal-traffic.log` (2414 rows)

The main "needle in a haystack" demo. Realistic mixed traffic from a pool of 24 synthetic
employees browsing believable per-user session bursts (mostly benign categories, business
hours, occasional light POST/PUT and rare blocks) across two full work weeks, with at least 2
injected instances of every one of the 7 v1 anomaly rules embedded among the noise. This is the
file that best demonstrates the detector separating real signal from a large, realistic
baseline rather than flagging everything.

## `quick-demo.log` (169 rows)

A small, dense file built for the screen-recording walkthrough: a thin two-day baseline against
the same 7 anomaly types, each still appearing at least twice, but packed close enough together
that every flagged row is visible without scrolling through thousands of benign lines on camera.

## `clean-traffic.log` (300 rows)

A pure negative control — ordinary baseline traffic only, zero injected anomalies, and verified
at generation time (`scripts/generate-logs/self-check.ts`) to never accidentally cross any rule
threshold on its own. Its purpose is to prove the detector's false-positive rate is actually
zero on this file, not just assumed to be.

## `malformed-edge-cases.log` (29 valid + 22 malformed lines)

Deliberately broken input: lines truncated mid-field, lines with a key entirely missing (not
just present-and-empty), lines with non-UTF-8 byte sequences spliced into a field value, and
lines with an unescaped tab character inside a value that shifts the tab-delimited field count.
Valid, well-formed lines are interspersed throughout, so a correct parser should come away with
some successfully parsed events *and* a set of per-line errors — proving graceful degradation
(and doubling as evidence for the file-upload input-validation security must-have, DECISIONS.md
§5) rather than the whole file failing to parse.
