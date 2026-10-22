# Thread surveys

Relay's fixes come partly from reading how it is used. A survey reads every T3 Code thread on the
fleet (M1, M3 and the ThinkPad) and the M1 jobs home for relay trouble. The next survey starts where
the last one stopped: read only threads and jobs newer than its cutoff.

| Date | Cutoff (UTC) | Read | Release |
|---|---|---|---|
| 2026-10-22 | 2026-10-22 00:40 | every thread on M1, M3 and the ThinkPad (about 920), and `~/.relay-jobs` on M1 (471 jobs) | 2.2.0 |

Client threads are read for relay's own behavior only. Nothing from a client's brief, code or report
goes into this repository.
