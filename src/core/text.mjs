// Turns raw text into normalized, matchable word sequences. The same
// normalization is applied to both the script and the live speech hypotheses
// so the matcher compares like with like.

import { isAllDigits, numberToWords } from './numbers.mjs';

/**
 * Language-specific rules. `locale` is used for lower-casing (Turkish has its
 * own dotted and dotless i); `expandNumbers` spells digits out as English words.
 * Number words exist only for English, so other languages keep a written number
 * as one word: the spoken number goes unmatched and the matcher steps over a
 * single word instead of several English ones that could never be heard.
 */
export function textRulesFor(code) {
  const c = (code || 'en').toLowerCase();
  if (c === 'en') return { locale: undefined, expandNumbers: true };
  if (c === 'tr') return { locale: 'tr-TR', expandNumbers: false };
  return { locale: undefined, expandNumbers: false };
}

export const ENGLISH = textRulesFor('en');

// A "word" is a run of letters, digits, combining accents and apostrophes.
const WORD_RUN = /[\p{L}\p{Nd}\p{M}'’]+/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;
const KEEP = /[\p{L}\p{Nd}\p{M}]/u;

function lower(s, rules) {
  return rules.locale ? s.toLocaleLowerCase(rules.locale) : s.toLowerCase();
}

/**
 * Normalizes a single raw word: lower-cased, keeping only letters, digits and
 * their accents (apostrophes and other punctuation are dropped), in composed
 * form so "e" + combining acute equals "é" as recognizers write it.
 */
export function normalizeWord(raw, rules = ENGLISH) {
  if (!LETTER_OR_DIGIT.test(raw)) return '';
  let kept = '';
  for (const ch of raw) {
    if (KEEP.test(ch)) kept += ch;
  }
  return lower(kept, rules).normalize('NFC');
}

function appendExpanded(normalized, out, rules) {
  if (rules.expandNumbers && isAllDigits(normalized)) {
    for (const w of numberToWords(normalized)) out.push(w);
  } else {
    out.push(normalized);
  }
}

/** Splits arbitrary text (e.g. a speech hypothesis) into normalized match words. */
export function toMatchWords(text, rules = ENGLISH) {
  const words = [];
  if (!text) return words;
  for (const m of text.matchAll(WORD_RUN)) {
    const normalized = normalizeWord(m[0], rules);
    if (normalized) appendExpanded(normalized, words, rules);
  }
  return words;
}

/**
 * Tokenizes display text, preserving each word's character span in the
 * original string for rendering and highlighting.
 */
export function tokenize(text, rules = ENGLISH) {
  const tokens = [];
  if (!text) return tokens;
  for (const m of text.matchAll(WORD_RUN)) {
    const normalized = normalizeWord(m[0], rules);
    if (!normalized) continue;
    tokens.push({ index: tokens.length, normalized, start: m.index, length: m[0].length });
  }
  return tokens;
}

/**
 * The matcher-ready representation of a script. It holds two parallel views:
 * `tokens` (one per displayed word, with character spans) and `matchWords`
 * (the flat sequence the matcher aligns against). A numeric token such as "25"
 * expands to several match words that all point back to the same token.
 */
export function buildScript(text, rules = ENGLISH) {
  text = text ?? '';
  const tokens = tokenize(text, rules);
  const matchWords = [];
  const matchWordToToken = [];
  const tokenToFirstMatchWord = new Array(tokens.length);

  for (const token of tokens) {
    tokenToFirstMatchWord[token.index] = matchWords.length;
    const expanded = [];
    appendExpanded(token.normalized, expanded, rules);
    for (const w of expanded) {
      matchWords.push(w);
      matchWordToToken.push(token.index);
    }
  }

  // A token starts a paragraph when the gap before it holds a blank line.
  const paragraphStarts = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i === 0) {
      paragraphStarts.push(0);
      continue;
    }
    const prevEnd = tokens[i - 1].start + tokens[i - 1].length;
    const gap = text.slice(prevEnd, tokens[i].start);
    if ((gap.match(/\n/g) || []).length >= 2) paragraphStarts.push(i);
  }

  return {
    text,
    rules,
    tokens,
    matchWords,
    paragraphStarts,
    get tokenCount() { return tokens.length; },
    get matchWordCount() { return matchWords.length; },
    tokenIndexForMatchWord(i) {
      return i >= 0 && i < matchWordToToken.length ? matchWordToToken[i] : -1;
    },
    firstMatchWordForToken(i) {
      return i >= 0 && i < tokenToFirstMatchWord.length ? tokenToFirstMatchWord[i] : 0;
    }
  };
}
