# T02 - retry policy repair

Bounded task COMPLETE; phase acceptance open. Main real localSQL regression
red11FAIL/3PASS (23502 including validlimit3) -> final14PASS, exit0.
All transient020DDL and fixtures rolled back; actual local019 preserved.
020 now validates explicit JSON integer warm_max_attempts1..10 and inserts it
into jobs.max_attempts. No retry default. Root typecheck and targeted lint/format
pass. Same test assertions throughout. Evidence logs in this directory.
Two static reviews clear for retry fix; derived settings-version dispatch gap
remains forT03a before persistent020apply. See exactT02checkpoint for commands
and scope. No hosted/provider/commit/deploy actions.
