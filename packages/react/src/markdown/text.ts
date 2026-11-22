// Text-level steps that run on the reply before it's parsed. Each is linear in
// the length of the text, as they run on every streamed token.

/** Turns `\r\n` and `\r` into `\n`. */
export function normalizeNewlines(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

// After any `>` and spaces: an optional bare number, then only marker, rule,
// fence, table-delimiter or heading characters. The two parts share no
// character, so the pattern can't backtrack quadratically on a long line.
const CONTAINER_PREFIX = /^[\s>]*/;
const PENDING_LINE = /^(?:\d{1,9}[.)]?)?[-*+_=•|:`~$#\s]*$/;

/**
 * While a reply streams in, leaves out its last line if that line is unfinished
 * and could still turn into something else: a bare list marker (`-`, `2.`), a
 * rule or setext underline still being typed (`-`, `--`, `* *`), a fence
 * (```` ``` ````, `$$`), a table's delimiter row (`| --- |`) or a bare `#`.
 * Shown as they are, each would flash as the wrong thing for a token or two: an
 * empty list item, a heading made of the line above, an empty heading.
 */
export function holdBackPendingLine(text: string): string {
  const start = text.lastIndexOf("\n") + 1;
  const line = text.slice(start).replace(CONTAINER_PREFIX, "");
  return PENDING_LINE.test(line) ? text.slice(0, start) : text;
}

// A fence line, after any container prefix (quote markers, list markers and
// indentation). A backtick fence's info string can't hold a backtick.
const FENCE_OPEN = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_CLOSE = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/;

/**
 * The ranges, `[start, end)`, of fenced code blocks and code spans: text that
 * Markdown leaves literal. It follows the Markdown rules closely enough for
 * rewriting text outside code, not for parsing.
 */
export function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let fence: { char: string; length: number; start: number } | null = null;
  // Where the current paragraph-ish run of lines began, for code spans.
  let runStart = -1;

  const spans = (start: number, end: number) => {
    let at = start;
    while (at < end) {
      const tick = text.indexOf("`", at);
      if (tick === -1 || tick >= end) break;
      let length = 1;
      while (text[tick + length] === "`") length++;
      // A backslash-escaped backtick can't open a span.
      let slashes = 0;
      while (text[tick - 1 - slashes] === "\\") slashes++;
      if (slashes % 2 === 1) {
        at = tick + 1;
        continue;
      }
      // The span closes on the next run of exactly as many backticks.
      let close = tick + length;
      let found = -1;
      while (close < end) {
        const next = text.indexOf("`", close);
        if (next === -1 || next >= end) break;
        let run = 1;
        while (text[next + run] === "`") run++;
        if (run === length) {
          found = next;
          break;
        }
        close = next + run;
      }
      if (found === -1) {
        at = tick + length;
      } else {
        ranges.push([tick, found + length]);
        at = found + length;
      }
    }
  };

  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);

    if (fence) {
      const closing = FENCE_CLOSE.exec(line)?.[1];
      if (closing && closing[0] === fence.char && closing.length >= fence.length) {
        ranges.push([fence.start, lineEnd]);
        fence = null;
      }
    } else {
      const opening = FENCE_OPEN.exec(line)?.[1];
      const blank = !line.trim();
      if (opening || blank) {
        if (runStart !== -1) spans(runStart, lineStart);
        runStart = -1;
      } else if (runStart === -1) {
        runStart = lineStart;
      }
      if (opening) fence = { char: opening[0]!, length: opening.length, start: lineStart };
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (fence) ranges.push([fence.start, text.length]);
  else if (runStart !== -1) spans(runStart, text.length);
  return ranges.sort((a, b) => a[0] - b[0]);
}

/**
 * Like `text.replace(pattern, replace)`, but leaves fenced code and code spans
 * alone: a match can't start or end inside one. `pattern` must be global.
 * `replace` gets the whole match, its offset and the text.
 */
export function replaceOutsideCode(
  text: string,
  pattern: RegExp,
  replace: (match: string, offset: number, text: string) => string,
): string {
  const ranges = codeRanges(text);
  if (ranges.length === 0) {
    return text.replace(pattern, (match: string, ...rest: unknown[]) => replace(match, rest.at(-2) as number, text));
  }
  // Blank out code with a character no pattern here matches, so matches line up
  // with the original text.
  let masked = "";
  let at = 0;
  for (const [start, end] of ranges) {
    masked += text.slice(at, start) + "\u0000".repeat(end - start);
    at = end;
  }
  masked += text.slice(at);

  let out = "";
  at = 0;
  for (const match of masked.matchAll(pattern)) {
    const start = match.index!;
    const end = start + match[0].length;
    out += text.slice(at, start) + replace(text.slice(start, end), start, text);
    at = end;
  }
  return out + text.slice(at);
}

// "•" isn't a Markdown list marker, but agents use it as one.
const BULLET = /^([ \t>]*)•(?=[ \t])/gm;

/** Turns a `•` at the start of a line, outside code, into a `-` list marker. */
export function normalizeBullets(text: string): string {
  return text.includes("•") ? replaceOutsideCode(text, BULLET, (match) => `${match.slice(0, -1)}-`) : text;
}

/**
 * Whether the text may hold a link reference definition (`[label]: url`) or a
 * footnote definition (`[^1]: note`), after any quote and list markers. Either
 * changes how text elsewhere in the reply renders, so a reply with one isn't
 * split into blocks.
 */
export const MAY_DEFINE = /^[ \t]*(?:(?:>|(?:[-*+]|\d{1,9}[.)])[ \t])[ \t]*)*\[(?:[^\\\]]|\\[\s\S]){1,999}\]:/m;
