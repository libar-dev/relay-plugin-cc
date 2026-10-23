# Thread surveys

Relay's fixes come partly from reading how it is used. A survey reads every T3 Code thread on the
fleet (M1, M3 and the ThinkPad) and the M1 jobs home for relay trouble. The next survey starts where
the last one stopped: read only threads and jobs newer than its cutoff.

| Date | Cutoff (UTC) | Read | Release |
|---|---|---|---|
| 2026-10-22 | 2026-10-22 00:40 | every thread on M1, M3 and the ThinkPad (about 920), and `~/.relay-jobs` on M1 (471 jobs) | 2.2.0 |
| 2026-10-23 | 2026-10-23 15:30 | pass 1 of the 3.0 pre-release survey: threads active since the last cutoff (M1 62 top-level and 530 subagent threads, M3 46 and 653, the ThinkPad 124 and 566), the transcripts that ran a 3.0 build, the jobs homes on all three machines (M1 458 jobs, M3 284, the ThinkPad 506) and, counted apart, the end-to-end kit's run homes (M3 1,538 jobs, the ThinkPad 333) | 3.0.0-pre.1 to 3.0.0-pre.4 |

Client threads are read for relay's own behavior only. Nothing from a client's brief, code or report
goes into this repository.
