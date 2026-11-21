// transducer.ts — WASM SIMD JSON-to-JSON CSV transducer for csv-reader-speed-01.
//
// Reads the raw bytes of /input/cases.json, answers every case exactly as
// csv-reader 1.0.0 does ({columns, rows, errors}), and emits the answers JSON
// bytes directly — no JS objects are built, no JSON.parse / JSON.stringify.
//
// Byte-level design ("escaped-byte transducer"): the input is JSON, so every
// CSV delimiter inside a text value arrives as a JSON escape (\" for a quote,
// \n for LF, \r for CR). Field content between those escapes is copied
// verbatim into the output JSON, because the input's escapes ARE the output's
// escapes for the same characters. Only csv-reader's own transforms change
// bytes: "" -> " inside quotes, CR/CRLF -> LF inside quotes, stray CRs
// dropped, a leading U+FEFF dropped. Delimiters are found with v128 SIMD
// (16 bytes at a time), content moves with memory.copy.
//
// makefun anchor a3cd7f9ff38776c4f4d871bb1343e3f5cfebdbe7 round 34162585

// ---------- memory layout (initial 1024 pages = 64 MiB, max 4096) ----------
// input:  [IN_BASE, IN_BASE + inLen)      (cases.json bytes, placed by JS)
//   The input must NOT start at offset 0: the module's data segment (string
//   literals, runtime statics) lives at the low addresses, and copying a
//   >1 KB input over it corrupts the literals (spanEquals('input') fails,
//   and the length fields of the outAscii literals turn to garbage, which
//   traps in outEnsure). IN_BASE = 1 MiB is far above the data segment
//   (the whole .wasm is ~13 KB) and stays below REC_BASE.
// REC:    16 MiB, cap 8 MiB              (one record's JSON)
// ERR:    24 MiB, cap 4 MiB              (errors JSON, comma separated)
// EXT:    28 MiB, cap 2 MiB              (long_row extra fields JSON)
// NUMBUF: 30 MiB, 32 bytes               (decimal scratch)
// OUT:    32 MiB ..                      (answers JSON, growable)
const IN_BASE: usize = 1 * 1024 * 1024;
const IN_CAP: i32 = 15 * 1024 * 1024; // IN_BASE + IN_CAP == REC_BASE
const REC_BASE: usize = 16 * 1024 * 1024;
const REC_CAP: i32 = 8 * 1024 * 1024;
const ERR_BASE: usize = 24 * 1024 * 1024;
const ERR_CAP: i32 = 4 * 1024 * 1024;
const EXT_BASE: usize = 28 * 1024 * 1024;
const EXT_CAP: i32 = 2 * 1024 * 1024;
const NUMBUF: usize = 30 * 1024 * 1024;
const OUT_BASE: usize = 32 * 1024 * 1024;

// ---------- buffer lengths ----------
let outLen: i32 = 0;
let recLen: i32 = 0;
let errLen: i32 = 0;
let extLen: i32 = 0;

// ---------- parser state (globals, one case at a time) ----------
let inPtr: usize = 0; // input start
let inEnd: usize = 0; // input end
let ts: usize = 0; // current case text span start (raw bytes)
let te: usize = 0; // current case text span end (raw bytes, excl. closing quote)
let pos: usize = 0; // raw byte cursor inside the text span
let line: i32 = 1; // current 1-based line
let recordLine: i32 = 1; // line the current record starts on
let recordRow: i32 = 0; // index the current record takes in rows (-1 = null, header)
let width: i32 = -1; // first record's field count
let rowsPushed: i32 = 0; // rows emitted so far in this case
let isFirstRecord: bool = true;
let headerFlag: bool = false;
let fieldCount: i32 = 0; // fields in the current record
let inExtra: bool = false; // current field goes to EXT, not REC
let fHasContent: bool = false; // current field has any content char
let lastFieldHasContent: bool = false;
let lastFieldQuoted: bool = false;
let charLen: i32 = 0; // raw byte length of the char peekKind just classified

// decoded-char kinds
const K_OTHER: i32 = 0;
const K_COMMA: i32 = 1;
const K_QUOTE: i32 = 2;
const K_LF: i32 = 3;
const K_CR: i32 = 4;
const K_END: i32 = 5;

// field end kinds
const F_COMMA: i32 = 0;
const F_LINE: i32 = 1;
const F_END: i32 = 2;

// ---------- buffer helpers ----------
function outEnsure(need: i32): void {
  const cap = memory.size() * 65536 - <i32>OUT_BASE;
  if (outLen + need > cap) {
    const pages = ((outLen + need - cap + 65535) / 65536) + 16;
    if (memory.grow(pages) < 0) unreachable();
  }
}

function outByte(b: i32): void {
  store<u8>(OUT_BASE + outLen, b);
  outLen++;
}

function outCopy(src: usize, n: i32): void {
  if (n <= 0) return;
  outEnsure(n);
  memory.copy(OUT_BASE + outLen, src, n);
  outLen += n;
}

function outAscii(s: string): void {
  outEnsure(s.length + 1);
  for (let i = 0; i < s.length; i++) {
    store<u8>(OUT_BASE + outLen, s.charCodeAt(i));
    outLen++;
  }
}

function recByte(b: i32): void {
  if (recLen >= REC_CAP) unreachable();
  store<u8>(REC_BASE + recLen, b);
  recLen++;
}

function recCopy(src: usize, n: i32): void {
  if (n <= 0) return;
  if (recLen + n > REC_CAP) unreachable();
  memory.copy(REC_BASE + recLen, src, n);
  recLen += n;
}

function recAscii(s: string): void {
  for (let i = 0; i < s.length; i++) recByte(s.charCodeAt(i));
}

function errByte(b: i32): void {
  if (errLen >= ERR_CAP) unreachable();
  store<u8>(ERR_BASE + errLen, b);
  errLen++;
}

function errCopy(src: usize, n: i32): void {
  if (n <= 0) return;
  if (errLen + n > ERR_CAP) unreachable();
  memory.copy(ERR_BASE + errLen, src, n);
  errLen += n;
}

function errAscii(s: string): void {
  for (let i = 0; i < s.length; i++) errByte(s.charCodeAt(i));
}

function extByte(b: i32): void {
  if (extLen >= EXT_CAP) unreachable();
  store<u8>(EXT_BASE + extLen, b);
  extLen++;
}

function extCopy(src: usize, n: i32): void {
  if (n <= 0) return;
  if (extLen + n > EXT_CAP) unreachable();
  memory.copy(EXT_BASE + extLen, src, n);
  extLen += n;
}

// field-content emission goes to REC or EXT depending on inExtra.
function fByte(b: i32): void {
  if (inExtra) extByte(b); else recByte(b);
}

function fCopy(src: usize, n: i32): void {
  if (inExtra) extCopy(src, n); else recCopy(src, n);
}

// decimal of a non-negative i32 appended to a buffer base+len; returns new len.
function appendNum(base: usize, len: i32, n: i32): i32 {
  if (n == 0) {
    store<u8>(base + len, 48);
    return len + 1;
  }
  let v = n;
  let d = 0;
  while (v > 0) {
    store<u8>(NUMBUF + d, 48 + (v % 10));
    v = v / 10;
    d++;
  }
  for (let i = d - 1; i >= 0; i--) {
    store<u8>(base + len, load<u8>(NUMBUF + i));
    len++;
  }
  return len;
}

function outNum(n: i32): void {
  outEnsure(12);
  outLen = appendNum(OUT_BASE, outLen, n);
}

function errNum(n: i32): void {
  errLen = appendNum(ERR_BASE, errLen, n);
}

// ---------- hex ----------
function hexVal(b: i32): i32 {
  if (b >= 48 && b <= 57) return b - 48;
  if (b >= 97 && b <= 102) return b - 97 + 10;
  if (b >= 65 && b <= 70) return b - 65 + 10;
  return -1;
}

function decodeHex4(p: usize): i32 {
  const a = hexVal(load<u8>(p));
  const b = hexVal(load<u8>(p + 1));
  const c = hexVal(load<u8>(p + 2));
  const d = hexVal(load<u8>(p + 3));
  if (a < 0 || b < 0 || c < 0 || d < 0) return -1;
  return (a << 12) | (b << 8) | (c << 4) | d;
}

// ---------- SIMD scanners ----------
// Next byte in {',', '\\', '"'} in [p, end); returns end when none.
function scan3(p: usize, end: usize): usize {
  const comma = v128.splat<i8>(44);
  const bs = v128.splat<i8>(92);
  const q = v128.splat<i8>(34);
  let cur = p;
  while (cur + 16 <= end) {
    const v = v128.load(cur);
    let m = i8x16.bitmask(i8x16.eq(v, comma));
    m |= i8x16.bitmask(i8x16.eq(v, bs));
    m |= i8x16.bitmask(i8x16.eq(v, q));
    if (m != 0) return cur + ctz(m);
    cur += 16;
  }
  while (cur < end) {
    const b = load<u8>(cur);
    if (b == 44 || b == 92 || b == 34) return cur;
    cur++;
  }
  return end;
}

// Next backslash in [p, end); returns end when none.
function scanBS(p: usize, end: usize): usize {
  const bs = v128.splat<i8>(92);
  let cur = p;
  while (cur + 16 <= end) {
    const v = v128.load(cur);
    const m = i8x16.bitmask(i8x16.eq(v, bs));
    if (m != 0) return cur + ctz(m);
    cur += 16;
  }
  while (cur < end) {
    if (load<u8>(cur) == 92) return cur;
    cur++;
  }
  return end;
}

// Next byte in {'"', '\\'} in [p, end); returns end when none (JSON string scan).
function scanStr(p: usize, end: usize): usize {
  const q = v128.splat<i8>(34);
  const bs = v128.splat<i8>(92);
  let cur = p;
  while (cur + 16 <= end) {
    const v = v128.load(cur);
    let m = i8x16.bitmask(i8x16.eq(v, q));
    m |= i8x16.bitmask(i8x16.eq(v, bs));
    if (m != 0) return cur + ctz(m);
    cur += 16;
  }
  while (cur < end) {
    const b = load<u8>(cur);
    if (b == 34 || b == 92) return cur;
    cur++;
  }
  return end;
}

// Classify the decoded char at raw position p (p < te, inside a text span).
// Sets charLen (raw bytes: 1, 2, or 6). A bare '"' means end of the JSON
// string value, so it reports K_END.
function peekKind(p: usize): i32 {
  if (p >= te) {
    charLen = 0;
    return K_END;
  }
  const b = load<u8>(p);
  if (b == 44) {
    charLen = 1;
    return K_COMMA;
  }
  if (b == 34) {
    charLen = 1;
    return K_END;
  }
  if (b != 92) {
    charLen = 1;
    return K_OTHER;
  }
  if (p + 1 >= te) {
    charLen = 1;
    return K_OTHER;
  }
  const b2 = load<u8>(p + 1);
  if (b2 == 34) {
    charLen = 2;
    return K_QUOTE;
  }
  if (b2 == 110) {
    charLen = 2;
    return K_LF;
  }
  if (b2 == 114) {
    charLen = 2;
    return K_CR;
  }
  if (b2 == 117) {
    if (p + 5 >= te) {
      charLen = 2;
      return K_OTHER;
    }
    const u = decodeHex4(p + 2);
    charLen = 6;
    if (u == 44) return K_COMMA;
    if (u == 34) return K_QUOTE;
    if (u == 10) return K_LF;
    if (u == 13) return K_CR;
    return K_OTHER;
  }
  charLen = 2;
  return K_OTHER;
}

// ---------- error emitters (append to ERR) ----------
function errSep(): void {
  if (errLen > 0) errByte(44);
}

function errRow(r: i32): void {
  if (r < 0) errAscii('null');
  else errNum(r);
}

function errStrayCr(): void {
  errSep();
  errAscii('{"code":"stray_cr","line":');
  errNum(recordLine);
  errAscii(',"row":');
  errRow(recordRow);
  errByte(125);
}

function errUnterminated(): void {
  errSep();
  errAscii('{"code":"unterminated_quote","line":');
  errNum(recordLine);
  errAscii(',"row":');
  errRow(recordRow);
  errByte(125);
}

function errQuoteJunk(): void {
  errSep();
  errAscii('{"code":"quote_junk","line":');
  errNum(recordLine);
  errAscii(',"row":');
  errRow(recordRow);
  errByte(125);
}

function errShortRow(n: i32): void {
  errSep();
  errAscii('{"code":"short_row","line":');
  errNum(recordLine);
  errAscii(',"row":');
  errRow(recordRow);
  errAscii(',"fields":');
  errNum(n);
  errByte(125);
}

function errLongRow(): void {
  errSep();
  errAscii('{"code":"long_row","line":');
  errNum(recordLine);
  errAscii(',"row":');
  errRow(recordRow);
  errAscii(',"extra":[');
  errCopy(EXT_BASE, extLen);
  errAscii(']}');
}

// ---------- field parsers ----------
// Parse an unquoted field (or post-quote junk when inJunk). The field's
// opening '"' is already in the field buffer. Emits content plus the closing
// '"'. Returns F_COMMA, F_LINE or F_END.
function parseUnquoted(inJunk: bool): i32 {
  let junkHas = false;
  while (true) {
    const hit = scan3(pos, te);
    if (hit > pos) {
      fCopy(pos, <i32>(hit - pos));
      fHasContent = true;
      if (inJunk) junkHas = true;
      pos = hit;
    }
    if (pos >= te) {
      fByte(34);
      if (inJunk && junkHas) errQuoteJunk();
      return F_END;
    }
    const b = load<u8>(pos);
    if (b == 44) {
      fByte(34);
      if (inJunk && junkHas) errQuoteJunk();
      pos += 1;
      return F_COMMA;
    }
    if (b == 34) {
      // bare quote: end of the JSON string value (defensive; never mid-span)
      fByte(34);
      if (inJunk && junkHas) errQuoteJunk();
      return F_END;
    }
    // b == 92: an escape
    const b2 = load<u8>(pos + 1);
    if (b2 == 34) {
      // \" : a literal quote char in the field
      fCopy(pos, 2);
      fHasContent = true;
      if (inJunk) junkHas = true;
      pos += 2;
      continue;
    }
    if (b2 == 110) {
      // \n : line break, record ends
      fByte(34);
      if (inJunk && junkHas) errQuoteJunk();
      pos += 2;
      line += 1;
      return F_LINE;
    }
    if (b2 == 114) {
      // \r : CRLF ends the record, lone CR is stray (dropped)
      const nk = peekKind(pos + 2);
      if (nk == K_LF) {
        fByte(34);
        if (inJunk && junkHas) errQuoteJunk();
        pos += 2 + charLen;
        line += 1;
        return F_LINE;
      }
      errStrayCr();
      pos += 2;
      continue;
    }
    if (b2 == 92 || b2 == 116 || b2 == 98 || b2 == 102) {
      // \\ \t \b \f : content, escapes copy verbatim
      fCopy(pos, 2);
      fHasContent = true;
      if (inJunk) junkHas = true;
      pos += 2;
      continue;
    }
    if (b2 == 47) {
      // \/ : a '/' char (JSON.stringify writes '/' bare)
      fByte(47);
      fHasContent = true;
      if (inJunk) junkHas = true;
      pos += 2;
      continue;
    }
    if (b2 == 117) {
      // \uXXXX
      const u = decodeHex4(pos + 2);
      if (u == 44) {
        fByte(34);
        if (inJunk && junkHas) errQuoteJunk();
        pos += 6;
        return F_COMMA;
      }
      if (u == 34) {
        fByte(92);
        fByte(34);
        fHasContent = true;
        if (inJunk) junkHas = true;
        pos += 6;
        continue;
      }
      if (u == 10) {
        fByte(34);
        if (inJunk && junkHas) errQuoteJunk();
        pos += 6;
        line += 1;
        return F_LINE;
      }
      if (u == 13) {
        const nk = peekKind(pos + 6);
        if (nk == K_LF) {
          fByte(34);
          if (inJunk && junkHas) errQuoteJunk();
          pos += 6 + charLen;
          line += 1;
          return F_LINE;
        }
        errStrayCr();
        pos += 6;
        continue;
      }
      fCopy(pos, 6);
      fHasContent = true;
      if (inJunk) junkHas = true;
      pos += 6;
      continue;
    }
    // any other escape: content, copy the two raw bytes
    fCopy(pos, 2);
    fHasContent = true;
    if (inJunk) junkHas = true;
    pos += 2;
  }
}

// Parse a quoted field. The opening quote escape has been consumed and the
// field's opening '"' is already in the field buffer. openRaw is the raw
// position of the opening quote escape, openCharLen its length (2 or 6),
// rollbackLen the field buffer length just after the opening '"' (for the
// unterminated-quote rewind). Returns F_COMMA, F_LINE or F_END.
function parseQuoted(openRaw: usize, openCharLen: i32, openLine: i32, rollbackLen: i32): i32 {
  while (true) {
    const hit = scanBS(pos, te);
    if (hit > pos) {
      fCopy(pos, <i32>(hit - pos));
      fHasContent = true;
      pos = hit;
    }
    if (pos >= te) {
      // unterminated quote: the opening quote is a literal char, and the
      // text after it is read again as unquoted.
      if (inExtra) extLen = rollbackLen;
      else recLen = rollbackLen;
      fByte(92);
      fByte(34);
      fHasContent = true;
      line = openLine;
      pos = openRaw + openCharLen;
      errUnterminated();
      return parseUnquoted(false);
    }
    const b2 = load<u8>(pos + 1);
    if (b2 == 34) {
      // \" : doubled quote, or the closing quote
      const nk = peekKind(pos + 2);
      if (nk == K_QUOTE) {
        // doubled: one quote char in the value
        fByte(92);
        fByte(34);
        fHasContent = true;
        pos += 2 + charLen;
        continue;
      }
      // closing quote: what follows is junk (read as unquoted)
      pos += 2;
      return parseUnquoted(true);
    }
    if (b2 == 110) {
      // \n inside quotes: one LF in the value (raw bytes copy verbatim)
      fCopy(pos, 2);
      fHasContent = true;
      line += 1;
      pos += 2;
      continue;
    }
    if (b2 == 114) {
      // \r inside quotes: CRLF or lone CR, each one LF in the value
      const nk = peekKind(pos + 2);
      if (nk == K_LF) {
        fByte(92);
        fByte(110);
        fHasContent = true;
        line += 1;
        pos += 2 + charLen;
        continue;
      }
      fByte(92);
      fByte(110);
      fHasContent = true;
      line += 1;
      pos += 2;
      continue;
    }
    if (b2 == 92 || b2 == 116 || b2 == 98 || b2 == 102) {
      fCopy(pos, 2);
      fHasContent = true;
      pos += 2;
      continue;
    }
    if (b2 == 47) {
      fByte(47);
      fHasContent = true;
      pos += 2;
      continue;
    }
    if (b2 == 117) {
      const u = decodeHex4(pos + 2);
      if (u == 34) {
        const nk = peekKind(pos + 6);
        if (nk == K_QUOTE) {
          fByte(92);
          fByte(34);
          fHasContent = true;
          pos += 6 + charLen;
          continue;
        }
        pos += 6;
        return parseUnquoted(true);
      }
      if (u == 10) {
        fByte(92);
        fByte(110);
        fHasContent = true;
        line += 1;
        pos += 6;
        continue;
      }
      if (u == 13) {
        const nk = peekKind(pos + 6);
        if (nk == K_LF) {
          fByte(92);
          fByte(110);
          fHasContent = true;
          line += 1;
          pos += 6 + charLen;
          continue;
        }
        fByte(92);
        fByte(110);
        fHasContent = true;
        line += 1;
        pos += 6;
        continue;
      }
      // other \uXXXX (incl. comma): content, copy verbatim
      fCopy(pos, 6);
      fHasContent = true;
      pos += 6;
      continue;
    }
    fCopy(pos, 2);
    fHasContent = true;
    pos += 2;
  }
}

// ---------- record parsing ----------
function parseRecord(): bool {
  while (true) {
    // skip empty lines (LF or CRLF only; a lone CR starts a record)
    while (true) {
      if (pos >= te) return false;
      const k = peekKind(pos);
      if (k == K_LF) {
        pos += charLen;
        line += 1;
        continue;
      }
      if (k == K_CR) {
        const k2 = peekKind(pos + charLen);
        if (k2 == K_LF) {
          pos += charLen + charLen;
          line += 1;
          continue;
        }
        break;
      }
      break;
    }
    if (pos >= te) return false;

    recordLine = line;
    recordRow = headerFlag && isFirstRecord ? -1 : rowsPushed;
    recLen = 0;
    extLen = 0;
    recByte(91); // '['
    fieldCount = 0;

    while (true) {
      fieldCount++;
      const idx = fieldCount;
      inExtra = width >= 0 && idx > width;
      if (inExtra) {
        if (idx > width + 1) extByte(44);
      } else {
        if (idx > 1) recByte(44);
      }
      fHasContent = false;

      const k0 = peekKind(pos);
      let ended: i32;
      if (k0 == K_QUOTE) {
        lastFieldQuoted = true;
        const openRaw = pos;
        const openCharLen = charLen;
        const openLine = line;
        fByte(34); // field opening '"'
        const rollbackLen = inExtra ? extLen : recLen;
        pos += openCharLen;
        ended = parseQuoted(openRaw, openCharLen, openLine, rollbackLen);
      } else {
        lastFieldQuoted = false;
        fByte(34); // field opening '"'
        ended = parseUnquoted(false);
      }
      lastFieldHasContent = fHasContent;
      if (ended == F_COMMA) continue;
      break; // record ends (LINE or END)
    }

    // a line that held only stray CRs / one empty unquoted field is no record
    if (fieldCount == 1 && !lastFieldHasContent && !lastFieldQuoted) {
      continue;
    }

    if (width < 0) width = fieldCount;
    if (!isFirstRecord) {
      if (fieldCount < width) {
        errShortRow(fieldCount);
        for (let i = fieldCount; i < width; i++) recAscii(',""');
      } else if (fieldCount > width) {
        errLongRow();
      }
    }
    recByte(93); // ']'
    if (!(isFirstRecord && headerFlag)) rowsPushed++;
    isFirstRecord = false;
    return true;
  }
}

// ---------- one case ----------
function parseCase(): void {
  pos = ts;
  line = 1;
  // a U+FEFF at the very start is dropped (literal UTF-8, or the \ufeff escape)
  if (
    pos + 2 < te &&
    load<u8>(pos) == 0xef &&
    load<u8>(pos + 1) == 0xbb &&
    load<u8>(pos + 2) == 0xbf
  ) {
    pos += 3;
  } else if (
    pos + 5 < te &&
    load<u8>(pos) == 92 &&
    load<u8>(pos + 1) == 117 &&
    load<u8>(pos + 2) == 102 &&
    load<u8>(pos + 3) == 101 &&
    load<u8>(pos + 4) == 102 &&
    load<u8>(pos + 5) == 102
  ) {
    pos += 6;
  }
  width = -1;
  rowsPushed = 0;
  isFirstRecord = true;
  errLen = 0;

  const hasRec = parseRecord();
  outAscii('{"columns":');
  if (!hasRec) {
    // no records, but errors from skipped lines (e.g. stray CRs) still count
    outAscii(headerFlag ? '[]' : 'null');
    outAscii(',"rows":[],"errors":[');
    outCopy(ERR_BASE, errLen);
    outAscii(']}');
    return;
  }
  if (headerFlag) outCopy(REC_BASE, recLen);
  else outAscii('null');
  outAscii(',"rows":[');
  let firstRowDone = false;
  if (!headerFlag) {
    outCopy(REC_BASE, recLen);
    firstRowDone = true;
  }
  while (parseRecord()) {
    if (firstRowDone) outByte(44);
    outCopy(REC_BASE, recLen);
    firstRowDone = true;
  }
  outAscii('],"errors":[');
  outCopy(ERR_BASE, errLen);
  outAscii(']}');
}

// ---------- JSON wrapper ----------
function skipWs(p: usize, end: usize): usize {
  while (p < end) {
    const b = load<u8>(p);
    if (b == 32 || b == 9 || b == 10 || b == 13) p++;
    else break;
  }
  return p;
}

// position just past the closing quote of the string starting at p (p at '"')
function skipString(p: usize, end: usize): usize {
  let cur = scanStr(p + 1, end);
  while (cur < end) {
    const b = load<u8>(cur);
    if (b == 92) {
      cur = scanStr(cur + 2, end);
      continue;
    }
    return cur + 1; // closing quote
  }
  return end;
}

// position just past the JSON value starting at p
function skipValue(p: usize, end: usize): usize {
  p = skipWs(p, end);
  if (p >= end) return p;
  const b = load<u8>(p);
  if (b == 34) return skipString(p, end);
  if (b == 123) {
    let cur = p + 1;
    while (true) {
      cur = skipWs(cur, end);
      if (cur >= end) return cur;
      if (load<u8>(cur) == 125) return cur + 1;
      cur = skipString(cur, end); // key
      cur = skipWs(cur, end);
      if (cur < end && load<u8>(cur) == 58) cur++;
      cur = skipValue(cur, end);
      cur = skipWs(cur, end);
      if (cur < end && load<u8>(cur) == 44) {
        cur++;
        continue;
      }
      if (cur < end && load<u8>(cur) == 125) return cur + 1;
      return cur;
    }
  }
  if (b == 91) {
    let cur = p + 1;
    while (true) {
      cur = skipWs(cur, end);
      if (cur >= end) return cur;
      if (load<u8>(cur) == 93) return cur + 1;
      cur = skipValue(cur, end);
      cur = skipWs(cur, end);
      if (cur < end && load<u8>(cur) == 44) {
        cur++;
        continue;
      }
      if (cur < end && load<u8>(cur) == 93) return cur + 1;
      return cur;
    }
  }
  let cur = p;
  while (cur < end) {
    const c = load<u8>(cur);
    if (c == 44 || c == 125 || c == 93 || c == 32 || c == 9 || c == 10 || c == 13) break;
    cur++;
  }
  return cur;
}

// does the raw span [s, e) equal the ASCII literal?
function spanEquals(s: usize, e: usize, lit: string): bool {
  if (e - s != lit.length) return false;
  for (let i = 0; i < lit.length; i++) {
    if (load<u8>(s + i) != lit.charCodeAt(i)) return false;
  }
  return true;
}

// parse the input object starting at p (p at '{'); sets ts/te/headerFlag.
// returns the position just past the object.
function parseInputObject(p: usize, end: usize): usize {
  let cur = p + 1;
  while (true) {
    cur = skipWs(cur, end);
    if (cur >= end) return cur;
    if (load<u8>(cur) == 125) return cur + 1;
    const ks = cur + 1; // key content start
    cur = skipString(cur, end); // past closing quote
    const ke = cur - 1; // key content end
    cur = skipWs(cur, end);
    if (cur < end && load<u8>(cur) == 58) cur++;
    cur = skipWs(cur, end);
    if (spanEquals(ks, ke, 'text')) {
      // value is a string: record its content span
      ts = cur + 1;
      const close = skipString(cur, end);
      te = close - 1;
      cur = close;
    } else if (spanEquals(ks, ke, 'header')) {
      headerFlag = load<u8>(cur) == 116; // 't' of true
      cur = skipValue(cur, end);
    } else {
      cur = skipValue(cur, end);
    }
    cur = skipWs(cur, end);
    if (cur < end && load<u8>(cur) == 44) {
      cur++;
      continue;
    }
    if (cur < end && load<u8>(cur) == 125) return cur + 1;
    return cur;
  }
}

// parse one case object starting at p (p at '{'); sets ts/te/headerFlag.
// returns the position just past the object.
function parseCaseObject(p: usize, end: usize): usize {
  let cur = p + 1;
  ts = 0;
  te = 0;
  headerFlag = false;
  while (true) {
    cur = skipWs(cur, end);
    if (cur >= end) return cur;
    if (load<u8>(cur) == 125) return cur + 1;
    const ks = cur + 1;
    cur = skipString(cur, end);
    const ke = cur - 1;
    cur = skipWs(cur, end);
    if (cur < end && load<u8>(cur) == 58) cur++;
    cur = skipWs(cur, end);
    if (spanEquals(ks, ke, 'input')) {
      cur = parseInputObject(cur, end);
    } else {
      cur = skipValue(cur, end);
    }
    cur = skipWs(cur, end);
    if (cur < end && load<u8>(cur) == 44) {
      cur++;
      continue;
    }
    if (cur < end && load<u8>(cur) == 125) return cur + 1;
    return cur;
  }
}

// ---------- entry ----------
export function getInPtr(): usize {
  return IN_BASE;
}

export function getOutPtr(): usize {
  return OUT_BASE;
}

// Transduce the raw cases.json bytes at [ptr, ptr+len): answers JSON lands at
// OUT_BASE. Returns its byte length, or -1 on a malformed/oversize input.
// The caller must place the input at getInPtr() (never at 0: the module's
// data segment lives at the low addresses).
export function transduce(ptr: usize, len: i32): i32 {
  if (ptr < IN_BASE || len < 0 || len >= IN_CAP) return -1;
  inPtr = ptr;
  inEnd = ptr + <usize>len;
  outLen = 0;

  let p = skipWs(inPtr, inEnd);
  outByte(91); // '['
  if (p >= inEnd || load<u8>(p) != 91) {
    outByte(93);
    return outLen;
  }
  p++;
  let firstCase = true;
  while (true) {
    p = skipWs(p, inEnd);
    if (p >= inEnd) break;
    if (load<u8>(p) == 93) {
      p++;
      break;
    }
    if (load<u8>(p) == 44) {
      p++;
      continue;
    }
    const caseEnd = parseCaseObject(p, inEnd);
    if (!firstCase) outByte(44);
    firstCase = false;
    parseCase();
    p = caseEnd;
  }
  outByte(93); // ']'
  return outLen;
}

