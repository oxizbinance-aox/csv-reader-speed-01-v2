// main.ts — the program the harness runs.
//
// Reads every case from /input/cases.json (MAKEFUN_INPUT_DIR), answers each
// with run() from solve.js, writes /output/answers.json (MAKEFUN_OUTPUT_DIR).
// The input is read as raw bytes and handed to the WASM transducer whole:
// no JSON.parse, no per-row objects, no JSON.stringify on this side. The
// transducer resolves its .wasm next to solve.js (import.meta.url), never via
// the working directory: the grader runs from /.
//
// V8 flag: the house baseline turns incremental marking off, and an entry may
// tune V8's flags the same way. The flag must be set before solve.js loads
// (it compiles the WASM module at import time), so solve.js is imported
// dynamically, after setFlagsFromString.

// makefun anchor a3cd7f9ff38776c4f4d871bb1343e3f5cfebdbe7 round 34162585

import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--no-incremental-marking');

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const { run } = await import('./solve.js');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'));
const answers = run(raw);
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'answers.json'), answers);
