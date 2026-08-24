# Answer Key — synthetic anomaly ground truth

**This file is for the human developer's own validation while building the rule engine
(DECISIONS.md §13, §14a). Detection code must NEVER read this file at runtime** — doing so
would make anomaly detection circular (grading its own answer sheet) instead of an honest,
independently-verifiable pass over the raw log data. It exists so a developer implementing
Layer 1's deterministic rules can check "did my rule engine find exactly these rows, for
exactly these reasons" against known ground truth, instead of eyeballing results.

Generated deterministically by `scripts/generate-logs/generate.ts` (`faker.seed(42)`) — see
that script and `scripts/generate-logs/anomaly-injectors.ts` for exactly how each instance
below was constructed. Line numbers are 1-indexed and count every line in the file (there is no
header row). `malformed-edge-cases.log` deliberately has no answer key here — it's a parser
robustness test, not an anomaly-detection test; see `examples/README.md` for what it covers
instead.

---

## normal-traffic.log — main haystack demo (`examples/normal-traffic.log`, 2414 rows)

### Burst-per-IP — 2 instances

- **Burst-per-IP #1** — Lines 1882-1884, 1886-1893, 1895-1899, 1901: 17 GET requests from cip=10.9.201.163 (login=coralie_ritchie) within 48s, 2026-01-14T14:36:05Z through 2026-01-14T14:36:53Z — exceeds the absolute floor of ≥15 requests/60s for burst_per_ip (DECISIONS.md §14a).
- **Burst-per-IP #2** — Lines 166-181, 183-185: 19 GET requests from cip=10.9.220.112 (login=audra_kassulke) within 54s, 2026-01-05T16:39:01Z through 2026-01-05T16:39:55Z — exceeds the absolute floor of ≥15 requests/60s for burst_per_ip (DECISIONS.md §14a).

### Exfil (bytes_out z-score) — 2 instances

- **Exfil bytes_out #1 (moderate tier)** — Line 736: bytes_out=6000 on a POST event — z-score 4.16 against the file's own POST/PUT baseline (mean=1090.9, stddev=1178.9, n=720) — exceeds the z>3 bytes_out_exfil threshold.
- **Exfil bytes_out #2 (high tier)** — Line 18: bytes_out=30000 on a POST event — z-score 24.52 against the file's own POST/PUT baseline (mean=1090.9, stddev=1178.9, n=720) — exceeds the z>3 bytes_out_exfil threshold (z >= 6, high-confidence tier).

### threatname populated — 3 instances

- **threatname hit #1** — Line 1326: threatname="Win32.Trojan.Generic" is populated — direct signal for threatname_hit, independent of urlcat (here "Business", a benign category, to show the rule fires on threatname alone).
- **threatname hit #2** — Line 2186: threatname="Emotet.C2" is populated — direct signal for threatname_hit, independent of urlcat (here "Social Networking", a benign category, to show the rule fires on threatname alone).
- **threatname hit #3** — Line 1978: threatname="Cobalt.Strike.Beacon" is populated — direct signal for threatname_hit, independent of urlcat (here "Streaming Media", a benign category, to show the rule fires on threatname alone).

### Malware-category access — 3 instances

- **Malware-category access #1** — Line 2414: urlcat="Malware Sites" is one of the 4 locked high-risk categories (Malware Sites / Phishing / Botnet Callback / Spyware or Adware) — direct signal for malware_category (threatname empty, action allowed here, to show the rule fires on category alone).
- **Malware-category access #2** — Line 1307: urlcat="Phishing" is one of the 4 locked high-risk categories (Malware Sites / Phishing / Botnet Callback / Spyware or Adware) — direct signal for malware_category (threatname empty, action allowed here, to show the rule fires on category alone).
- **Malware-category access #3** — Line 1047: urlcat="Botnet Callback" is one of the 4 locked high-risk categories (Malware Sites / Phishing / Botnet Callback / Spyware or Adware) — direct signal for malware_category (threatname empty, action allowed here, to show the rule fires on category alone).

### Repeated-blocked — 2 instances

- **Repeated-blocked #1** — Lines 1355-1360: 6 blocked events for login=catalina50 (cip=10.9.29.141) against the same URL, within 400s (2026-01-12T15:39:04Z through 2026-01-12T15:45:44Z, under the 10-min window) — exceeds the ≥5-blocked-in-10-min repeated_blocked threshold.
- **Repeated-blocked #2** — Lines 333-339: 7 blocked events for login=keanu22 (cip=10.9.233.158) against the same URL, within 480s (2026-01-06T12:04:49Z through 2026-01-06T12:12:49Z, under the 10-min window) — exceeds the ≥5-blocked-in-10-min repeated_blocked threshold.

### Off-hours access — 3 instances

- **Off-hours access #1** — Line 1: datetime=2026-01-05T01:48:00Z hour (1:00 UTC) is before the 08:00 UTC business-hours start — outside the 08:00-18:00 UTC weekday business-hours window (off_hours rule).
- **Off-hours access #2** — Line 215: datetime=2026-01-05T22:30:00Z hour (22:00 UTC) is at/after the 18:00 UTC business-hours end — outside the 08:00-18:00 UTC weekday business-hours window (off_hours rule).
- **Off-hours access #3** — Line 1187: datetime=2026-01-10T18:16:00Z falls on a Saturday/Sunday (UTC) — outside the 08:00-18:00 UTC weekday business-hours window (off_hours rule).

### Rare/scripted user-agent — 4 instances

- **Rare/scripted UA #1** — Line 1589: useragent="curl/8.4.0" matches a known scripted/tooling signature (curl/python-requests/Wget/empty) — direct signature match for rare_scripted_user_agent.
- **Rare/scripted UA #2** — Line 2178: useragent="python-requests/2.31.0" matches a known scripted/tooling signature (curl/python-requests/Wget/empty) — direct signature match for rare_scripted_user_agent.
- **Rare/scripted UA #3** — Line 1125: useragent="Wget/1.21.3" matches a known scripted/tooling signature (curl/python-requests/Wget/empty) — direct signature match for rare_scripted_user_agent.
- **Rare/scripted UA #4** — Line 93: useragent="(empty string)" matches a known scripted/tooling signature (curl/python-requests/Wget/empty) — direct signature match for rare_scripted_user_agent.

---

## quick-demo.log — dense demo for the walkthrough recording (`examples/quick-demo.log`, 169 rows)

### Burst-per-IP — 2 instances

- **Burst-per-IP #1** — Lines 81-97: 17 GET requests from cip=10.9.190.252 (login=justina_gerlach) within 48s, 2026-02-02T16:38:50Z through 2026-02-02T16:39:38Z — exceeds the absolute floor of ≥15 requests/60s for burst_per_ip (DECISIONS.md §14a).
- **Burst-per-IP #2** — Lines 22-40: 19 GET requests from cip=10.9.100.150 (login=yesenia_kuvalis) within 54s, 2026-02-02T10:55:24Z through 2026-02-02T10:56:18Z — exceeds the absolute floor of ≥15 requests/60s for burst_per_ip (DECISIONS.md §14a).

### Exfil (bytes_out z-score) — 2 instances

- **Exfil bytes_out #1 (moderate tier)** — Line 141: bytes_out=96418 on a POST event — z-score 4.01 against the file's own POST/PUT baseline (mean=4899.5, stddev=22816.7, n=65) — exceeds the z>3 bytes_out_exfil threshold.
- **Exfil bytes_out #2 (high tier)** — Line 9: bytes_out=161347 on a POST event — z-score 6.86 against the file's own POST/PUT baseline (mean=4899.5, stddev=22816.7, n=65) — exceeds the z>3 bytes_out_exfil threshold (z >= 6, high-confidence tier).

### threatname populated — 2 instances

- **threatname hit #1** — Line 135: threatname="Win32.Trojan.Generic" is populated — direct signal for threatname_hit, independent of urlcat (here "Business", a benign category, to show the rule fires on threatname alone).
- **threatname hit #2** — Line 60: threatname="Emotet.C2" is populated — direct signal for threatname_hit, independent of urlcat (here "Social Networking", a benign category, to show the rule fires on threatname alone).

### Malware-category access — 2 instances

- **Malware-category access #1** — Line 128: urlcat="Malware Sites" is one of the 4 locked high-risk categories (Malware Sites / Phishing / Botnet Callback / Spyware or Adware) — direct signal for malware_category (threatname empty, action allowed here, to show the rule fires on category alone).
- **Malware-category access #2** — Line 59: urlcat="Phishing" is one of the 4 locked high-risk categories (Malware Sites / Phishing / Botnet Callback / Spyware or Adware) — direct signal for malware_category (threatname empty, action allowed here, to show the rule fires on category alone).

### Repeated-blocked — 2 instances

- **Repeated-blocked #1** — Lines 119-123, 125: 6 blocked events for login=demarco.kohler55 (cip=10.9.240.163) against the same URL, within 400s (2026-02-03T09:30:41Z through 2026-02-03T09:37:21Z, under the 10-min window) — exceeds the ≥5-blocked-in-10-min repeated_blocked threshold.
- **Repeated-blocked #2** — Lines 155-161: 7 blocked events for login=jordan.christiansen60 (cip=10.9.222.197) against the same URL, within 480s (2026-02-03T16:30:17Z through 2026-02-03T16:38:17Z, under the 10-min window) — exceeds the ≥5-blocked-in-10-min repeated_blocked threshold.

### Off-hours access — 2 instances

- **Off-hours access #1** — Line 1: datetime=2026-02-02T00:18:00Z hour (0:00 UTC) is before the 08:00 UTC business-hours start — outside the 08:00-18:00 UTC weekday business-hours window (off_hours rule).
- **Off-hours access #2** — Line 115: datetime=2026-02-02T20:14:00Z hour (20:00 UTC) is at/after the 18:00 UTC business-hours end — outside the 08:00-18:00 UTC weekday business-hours window (off_hours rule).

### Rare/scripted user-agent — 2 instances

- **Rare/scripted UA #1** — Line 167: useragent="curl/8.4.0" matches a known scripted/tooling signature (curl/python-requests/Wget/empty) — direct signature match for rare_scripted_user_agent.
- **Rare/scripted UA #2** — Line 118: useragent="python-requests/2.31.0" matches a known scripted/tooling signature (curl/python-requests/Wget/empty) — direct signature match for rare_scripted_user_agent.

---

## clean-traffic.log — negative control (`examples/clean-traffic.log`, 300 rows)

**Zero injected anomalies.** This file is the negative control (DECISIONS.md §13) — every row is ordinary baseline traffic. A correct detector should flag nothing here; if it does, that's a false positive.
