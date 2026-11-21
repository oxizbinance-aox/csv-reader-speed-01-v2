// solve.js — WASM SIMD "escaped-byte" JSON-to-JSON CSV transducer.
//
// A dependency-free ES module. run() answers csv-reader 1.0.0's
// {columns, rows, errors} for every case, exactly, but without ever building
// a JS object per row: a WebAssembly module compiled from transducer.ts
// (AssemblyScript, SIMD v128) takes the raw cases.json bytes, parses the JSON
// wrapper minimally, parses the CSV at byte level, and emits the answers.json
// bytes directly. Inside a JSON text value the CSV delimiters arrive as
// escapes, so field content between escapes is copied verbatim into the
// output — the input's escapes ARE the output's escapes for the same
// characters. Only csv-reader's own transforms change bytes: "" -> " inside
// quotes, CR/CRLF -> LF inside quotes, stray CRs dropped, a leading U+FEFF
// dropped. Delimiters are found with v128 SIMD (16 bytes at a time) and
// content moves with memory.copy, so the whole set is one pass over the
// bytes with no per-row allocation.
//
// run(input):
//   - Buffer/Uint8Array holding the raw cases.json bytes
//       -> Buffer holding the answers.json bytes
//   - a JSON string of the cases array -> the answers JSON string
//   - a single case input {text, header}
//       -> the single answer object {columns, rows, errors}
//   - an array of case inputs [{text, header}, ...]
//       -> the array of answer objects
//
// The .wasm is resolved next to this file (import.meta.url), never via the
// working directory: the grader runs from /.
//
// makefun anchor a3cd7f9ff38776c4f4d871bb1343e3f5cfebdbe7 round 34162585

import { readFileSync } from 'node:fs';

const wasmBytes = readFileSync(new URL('./transducer.wasm', import.meta.url));
const wasmModule = new WebAssembly.Module(wasmBytes);

let instance = null;
let memory = null;

function ensureInstance() {
  if (instance) return;
  instance = new WebAssembly.Instance(wasmModule, {});
  memory = instance.exports.memory;
}

function transduceBytes(bytes) {
  ensureInstance();
  const inPtr = instance.exports.getInPtr();
  const outPtr = instance.exports.getOutPtr();
  if (bytes.length > 15 * 1024 * 1024) {
    throw new Error('csv-transducer: input over 15 MiB');
  }
  // Refresh the view: a memory.grow during transduce detaches the old buffer.
  let view = new Uint8Array(memory.buffer);
  view.set(bytes, inPtr);
  const outLen = instance.exports.transduce(inPtr, bytes.length);
  if (outLen < 0) throw new Error('csv-transducer: transduce failed');
  view = new Uint8Array(memory.buffer);
  return Buffer.from(view.subarray(outPtr, outPtr + outLen));
}

export function run(input) {
  if (input instanceof Uint8Array) return transduceBytes(input);
  if (typeof input === 'string') {
    return transduceBytes(Buffer.from(input, 'utf8')).toString('utf8');
  }
  if (Array.isArray(input)) {
    const wrapped = JSON.stringify(input.map((c) => ({ id: 'x', input: c })));
    return JSON.parse(
      transduceBytes(Buffer.from(wrapped, 'utf8')).toString('utf8'),
    );
  }
  if (input && typeof input === 'object' && typeof input.text === 'string') {
    const wrapped = JSON.stringify([{ id: 'x', input }]);
    return JSON.parse(
      transduceBytes(Buffer.from(wrapped, 'utf8')).toString('utf8'),
    )[0];
  }
  throw new TypeError(
    'csv-transducer: run() needs raw cases.json bytes, a JSON string, a case {text, header}, or an array of cases',
  );
}
