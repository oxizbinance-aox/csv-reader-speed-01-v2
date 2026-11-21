# csv-reader-speed-01-v2

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/oxizbinance-aox/csv-reader-speed-01-v2/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/oxizbinance-aox/csv-reader-speed-01-v2/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A WASM SIMD JSON-to-JSON CSV transducer: it reads the raw cases.json bytes, parses the CSV at byte level with v128 SIMD, and emits the answers.json bytes directly — no per-row objects, no JSON.parse/stringify on the hot path. Answers are byte-identical to csv-reader 1.0.0 on the practice set, at roughly 1/28th of the previous entry's CPU time.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

Locally, point `MAKEFUN_INPUT_DIR` at a directory holding `cases.json` and `MAKEFUN_OUTPUT_DIR` at a writable directory; `answers.json` lands there. Requires Node 22+ (the harness runs Node 26). No dependencies to install: `solve.js` is a dependency-free ES module and `transducer.wasm` is compiled from `transducer.ts` (AssemblyScript, `--enable simd`).

## How it works

Inside a JSON text value the CSV delimiters arrive as escapes (`\"` is a quote, `\n` a line break, `\r` a carriage return), so field content between escapes is copied verbatim into the output — the input's escapes ARE the output's escapes for the same characters. Only csv-reader's own transforms change bytes: `""` becomes `"` inside quotes, CR/CRLF becomes LF inside quotes, stray CRs are dropped, and a leading U+FEFF is dropped. Delimiters are found with v128 SIMD (16 bytes at a time) and content moves with `memory.copy`, so the whole set is one pass over the bytes with no per-row allocation. The input is placed at 1 MiB in the module's memory, above the data segment, and the answer is emitted straight from the record buffer — the program never builds a JS object per row.

## Benchmark (local, practice set, 6 cases, ~11 MB of CSV)

| | CPU |
|---|---|
| Previous entry (pure-JS parser) | 1,730,000 µs (rank 4,390 of 5,453) |
| This entry, `run()` end to end | ~56,000–61,000 µs |
| This entry, transducer alone | ~39,000–42,000 µs |
| Bar for this bounty | 150,000 µs |

Correctness: output is byte-identical to the house baseline's answers on the practice set, and 13,188 differential tests against csv-reader 1.0.0 (hand-written edge cases plus random and structured fuzzing, header on and off) all pass. `grade-local --driver process` passes 6/6.

---

<sub>Entered on [make.fun](https://make.fun/?ref=e8v4jyxk&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
