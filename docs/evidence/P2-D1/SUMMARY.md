# P2-D1 — admin URL parity (A14)

Main-session verification, repository root, Node 26.13.1,
p2/d1@aa6425a plus preserved uncommitted work; LOCAL Postgres 019.

Added a browser-safe admin URL policy matching frozen migration 010 exactly:
ASCII hostname syntax, explicit HTTPS authority, ports 0–65535 with at most
five digits, forbidden controls/whitespace and 2048 UTF-16 code units.
Shared settings/public/contact schemas and widget config/contact rendering
use it. General evidence/embed URL policies retain their existing behavior.
This is syntax validation, not a DNS or IDNA validity guarantee.

23 new parity fixtures cover Unicode/IP hosts, unusual SQL-accepted hosts,
ports, credentials and UTF-16 boundaries. Shared red: 7 failed/257 controls.
Widget boundary red: 2 failed/2 controls (21 filtered).
Final shared+widget units: 1179 passed in 25 files, exit 0 (unit.log).
Root build exited 0 (build.log).
Actual SQL fixture suite: 264 passed, exit 0 (sql-parity-final.log).
Its first expanded run failed setup at the Windows argv limit; fixture JSON
now travels as base64 on stdin. Submitted text is never spliced into SQL.

Two independent static reviewers found no new URL blocker. Both flagged
pre-existing nullable public config and adjacent language/phone mismatches;
track those separately as P8-D11/A15. No SQL migration or hosted action.
Final integrated static/full-system gates remain open.
