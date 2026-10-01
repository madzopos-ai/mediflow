/**
 * Spoken Arabic numbers -> ASCII digits.
 *
 * Arabic speech recognition returns "مئة وأربعين" about as often as "١٤٠", and
 * an Arabic-Indic digit run is only half the problem: the shared vital parser
 * reads ASCII. This module locates runs of number words, reads them additively,
 * and rewrites just those runs as digits.
 *
 * Arabic composes numbers additively inside a phrase - "مئة وأربعين" is
 * 100 + 40, "ثلاثة وعشرون" is 3 + 20 - so summing the parts is both correct and
 * order-independent. Anything not fully recognised is left untouched rather
 * than mangled into a plausible-looking wrong number.
 */

/**
 * Any Unicode letter, Latin included: the six inside "ستritis" is still a word
 * fragment, not a reading. JS `\w` is ASCII-only, so `\b` is useless here too.
 */
const LETTER = /\p{L}/u;

/** The Arabic conjunction "and", which prefixes every following number word. */
const CONJUNCTION = '\u0648';

/** Marks dropped from the match probe; they carry no numeric meaning. */
const ARABIC_MARKS = /[\u064B-\u0652\u0670\u0640]/u;

/**
 * Maps one character onto its folded form, so folding is length-preserving and
 * match offsets stay valid against the original string. Alef variants, ى, ة,
 * ئ and ؤ all collapse: "مئة", "مائة" and "مئه" are the same word to a patient.
 */
function foldChar(ch: string): string {
  if (ch >= '\u0622' && ch <= '\u0625') return '\u0627';
  if (ch === '\u0671') return '\u0627';
  if (ch === '\u0649') return '\u064A';
  if (ch === '\u0629') return '\u0647';
  if (ch === '\u0626') return '\u064A';
  if (ch === '\u0624') return '\u0648';
  return ch;
}

/**
 * Number words in natural spelling, keyed in folded form below. This table is
 * the single source of truth: the matcher is derived from it, so teaching the
 * parser a new spelling is a one-line change here.
 */
const AR_VALUES: Record<string, number> = {
  // units 0-9
  'صفر': 0, 'واحد': 1, 'واحدة': 1, 'اثنان': 2, 'اثنين': 2,
  'ثلاثة': 3, 'ثلاث': 3, 'تلات': 3, 'أربعة': 4, 'أربع': 4,
  'خمسة': 5, 'خمس': 5, 'ستة': 6, 'ست': 6,
  'سبعة': 7, 'سبع': 7, 'ثمانية': 8, 'ثمان': 8, 'تسعة': 9, 'تسع': 9,
  // teens and tens
  'عشرة': 10, 'عشر': 10, 'عشرون': 20, 'شرين': 20,
  'ثلاثون': 30, 'ثلاثين': 30, 'أربعون': 40, 'أربعين': 40,
  'خمسون': 50, 'خمسين': 50, 'ستون': 60, 'ستين': 60,
  'سبعون': 70, 'سبعين': 70, 'ثمانون': 80, 'ثمانين': 80,
  'تسعون': 90, 'تسعين': 90,
  // hundreds
  'مئة': 100, 'مائة': 100,
  'مئتان': 200, 'مائتان': 200, 'مئتين': 200, 'مائتين': 200,
  'ثلاثمئة': 300, 'ثلاثمائة': 300,
  'أربعمئة': 400, 'خمسمئة': 500, 'ستمئة': 600,
  'سبعمئة': 700, 'ثمانمئة': 800, 'تسعمئة': 900,
};

/** Fold the table once so the matcher and the lookup agree by construction. */
const FOLDED_VALUES: Record<string, number> = {};
for (const [word, value] of Object.entries(AR_VALUES)) {
  let folded = '';
  for (const ch of word) {
    if (!ARABIC_MARKS.test(ch)) folded += foldChar(ch);
  }
  FOLDED_VALUES[folded] = value;
}

/** Longest first so a hundreds key wins over its own leading unit. */
const AR_WORD = Object.keys(FOLDED_VALUES)
  .sort((a, b) => b.length - a.length)
  .join('|');

const AR_RUN_RE = new RegExp(
  `(?:${CONJUNCTION}\\s*)?(?:${AR_WORD})(?:\\s*(?:${CONJUNCTION}\\s*)?(?:${AR_WORD}))*`,
  'g',
);

/**
 * Sums a run of number words, or null when any token is unrecognised so the
 * caller leaves the original text alone.
 *
 * Arabic glues the conjunction onto the front of the next word, so a run reads
 * "مئة وأربعين" as the tokens "مئة", "وأربعين" - not "و", "أربعين". The prefix
 * is therefore stripped per token, but only after a full-token lookup, since
 * "وحده" (one) is a real word that happens to start with the same letter.
 */
function evaluateArabicNumber(run: string): number | null {
  const parts = run.split(/\s+/u).filter((token) => token.length > 0 && token !== CONJUNCTION);
  if (parts.length === 0) return null;
  let total = 0;
  for (const part of parts) {
    let token = part;
    if (token.length > 1 && token.startsWith(CONJUNCTION)) token = token.slice(1);
    const value = FOLDED_VALUES[token];
    if (value === undefined) return null;
    total += value;
  }
  return total;
}

/**
 * Rewrites spoken Arabic numbers as ASCII digits, leaving everything else in
 * the input byte-for-byte intact.
 *
 * Only the number runs are replaced, never the spelling: callers feed the
 * result straight into the vital parser, whose Arabic label patterns are
 * written in natural spelling ("الحرارة"). Folding the whole string would
 * break exactly the labels this is meant to help read.
 */
export function arabicNumbersToDigits(input: string): string {
  // Match against a folded probe, keeping a map back to the original offsets.
  let probe = '';
  const sourceIndex: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charAt(i);
    if (ARABIC_MARKS.test(ch)) continue;
    probe += foldChar(ch);
    sourceIndex.push(i);
  }

  const edits: { start: number; end: number; text: string }[] = [];
  AR_RUN_RE.lastIndex = 0;
  let match = AR_RUN_RE.exec(probe);
  while (match !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const before = start > 0 ? probe.charAt(start - 1) : '';
    const after = probe.charAt(end);
    // Reject fragments: a number word glued to more letters is part of a word.
    if (!LETTER.test(before) && !LETTER.test(after)) {
      const value = evaluateArabicNumber(probe.slice(start, end));
      const from = sourceIndex[start];
      const to = sourceIndex[end - 1];
      if (value !== null && from !== undefined && to !== undefined) {
        edits.push({ start: from, end: to + 1, text: String(value) });
      }
    }
    match = AR_RUN_RE.exec(probe);
  }

  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    out += input.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + input.slice(cursor);
}
