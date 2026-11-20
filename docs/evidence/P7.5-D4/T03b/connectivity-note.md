# Local advisor connectivity observation

Postmigration CLIadvisors --typeall --levelwarn --fail-onwarn exited1 with
DbConnectError/connectiontimeout to127.0.0.1:54322. This is NOT a clean advisor
result. Separate main TCPprobes connected to both54321and54322; Docker reports
54322forwarded; in-container SELECT schema_version(),count(pg_stat_activity)
returned20and35. The cause is not yetproven; no blind advisor retries or DB
restart performed. Carry diagnosis intoT03c, preserving failurelog/advisors.log.
