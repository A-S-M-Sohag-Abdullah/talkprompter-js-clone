// Tracks where a speaker is in a known script by fuzzily aligning the most
// recent spoken words against a small window of script just ahead of the last
// matched position (the "anchor").
//
// The behavior the app needs falls out of one rule: advance the anchor only
// when recent speech matches the script near it. If the reader pauses or goes
// off-script, nothing matches, the anchor holds, and scrolling stops. When
// they resume, matches reappear near the anchor and it advances again. If the
// hold persists, re-acquisition scans further ahead (or back) to catch a
// skipped paragraph or a re-read sentence.
//
// Deterministic and free of timers or audio, so it is unit-testable with strings.

import { toMatchWords } from './text.mjs';

export const TrackingState = Object.freeze({
  Idle: 'idle',         // no speech processed yet, or reset
  Tracking: 'tracking', // speech matched; the anchor is advancing
  Paused: 'paused',     // no match near the anchor; holding position
  Lost: 'lost'          // held long enough that re-acquisition is active
});

export const DEFAULT_OPTIONS = Object.freeze({
  tailWords: 7,              // most recent spoken words aligned per update
  forwardWindow: 14,         // extra script words searched ahead of the anchor
  backTolerance: 2,          // how far behind the anchor small slips are corrected
  maxJump: 18,               // max words the anchor may advance per update
  acceptThreshold: 0.42,     // min similarity to accept a match
  minMatchedWords: 2,        // min spoken words before a match is trusted
  lostThreshold: 8,          // non-matching hypotheses before re-acquisition
  reacquireThreshold: 0.7,   // stricter similarity for re-acquisition jumps
  reacquireWindow: 400,      // how far ahead re-acquisition scans
  reacquireBackWindow: 80,   // how far behind re-acquisition scans (re-reads)
  reacquireBackMinWords: 4   // min spoken words for a backward re-acquisition
});

/** Sensitivity slider (0..1) → options. Higher follows through more mistakes. */
export function optionsForSensitivity(sensitivity) {
  const s = Math.min(1, Math.max(0, sensitivity));
  return { ...DEFAULT_OPTIONS, acceptThreshold: 0.60 - 0.34 * s };
}

/** Word-level Levenshtein distance (each word is an atomic symbol). */
export function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Similarity in [0, 1]: 1 − distance / max(lengths). */
export function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

export class ScriptMatcher {
  constructor(script, options = DEFAULT_OPTIONS) {
    this.script = script;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.anchor = 0; // index into matchWords of the next expected word
    this.noMatchCount = 0;
    this.state = TrackingState.Idle;
  }

  /** The display token the reader is currently on, or -1 before any match. */
  get currentTokenIndex() {
    return this.anchor > 0 ? this.script.tokenIndexForMatchWord(this.anchor - 1) : -1;
  }

  /** Feeds a speech hypothesis (partial or final) and returns the updated position. */
  process(hypothesis) {
    const o = this.options;
    const s = this.script;
    const words = toMatchWords(hypothesis, s.rules);
    if (words.length === 0 || s.matchWordCount === 0) return this.#snapshot(false);

    const tail = Math.min(words.length, o.tailWords);
    const spoken = words.slice(words.length - tail);

    // Fast path: a lone word that is exactly the next expected script word
    // advances immediately, so the first word after a pause isn't laggy.
    if (spoken.length < o.minMatchedWords && spoken.length === 1
      && this.anchor < s.matchWordCount && spoken[0] === s.matchWords[this.anchor]) {
      return this.#accept({ accepted: true, newAnchor: this.anchor + 1, confidence: 1, advanced: true });
    }

    // Not enough evidence yet: hold rather than risk a spurious jump.
    if (spoken.length < o.minMatchedWords) return this.#snapshot(false);

    // The window looks back far enough to cover the whole spoken tail (a
    // streaming partial grows from the utterance start) and ahead by forwardWindow.
    const local = this.#search(
      spoken,
      Math.max(0, this.anchor - spoken.length - o.backTolerance),
      Math.min(s.matchWordCount, this.anchor + spoken.length + o.forwardWindow),
      o.acceptThreshold);

    if (local.accepted && local.newAnchor <= this.anchor + spoken.length + o.maxJump) {
      return this.#accept(local);
    }

    this.noMatchCount++;

    if (this.noMatchCount >= o.lostThreshold) {
      const forward = this.#search(
        spoken, this.anchor,
        Math.min(s.matchWordCount, this.anchor + o.reacquireWindow),
        o.reacquireThreshold);

      // A flubbed take usually means re-reading an EARLIER sentence, so scan
      // a window behind the anchor too and take the better match.
      let backward = { accepted: false, confidence: -1 };
      if (spoken.length >= o.reacquireBackMinWords && this.anchor > 0) {
        backward = this.#search(
          spoken, Math.max(0, this.anchor - o.reacquireBackWindow), this.anchor,
          o.reacquireThreshold, true);
      }

      const best = backward.accepted && (!forward.accepted || backward.confidence > forward.confidence)
        ? backward : forward;
      if (best.accepted) return this.#accept(best);

      this.state = TrackingState.Lost;
      return this.#snapshot(false);
    }

    this.state = TrackingState.Paused;
    return this.#snapshot(false);
  }

  /** Manually re-anchor so `tokenIndex` becomes the current (just-read) word. */
  seekToToken(tokenIndex) {
    const s = this.script;
    if (tokenIndex < 0 || s.tokenCount === 0) {
      this.reset();
      return;
    }
    const clamped = Math.min(tokenIndex, s.tokenCount - 1);
    this.anchor = clamped + 1 < s.tokenCount ? s.firstMatchWordForToken(clamped + 1) : s.matchWordCount;
    this.noMatchCount = 0;
    this.state = TrackingState.Idle;
  }

  reset() {
    this.anchor = 0;
    this.noMatchCount = 0;
    this.state = TrackingState.Idle;
  }

  #accept(result) {
    this.anchor = result.newAnchor;
    this.noMatchCount = 0;
    this.state = TrackingState.Tracking;
    return {
      state: TrackingState.Tracking,
      tokenIndex: this.currentTokenIndex,
      matchWordIndex: this.anchor,
      confidence: result.confidence,
      advanced: result.advanced
    };
  }

  #snapshot(advanced) {
    return {
      state: this.state,
      tokenIndex: this.currentTokenIndex,
      matchWordIndex: this.anchor,
      confidence: 0,
      advanced
    };
  }

  // Slides the spoken words across the [from, to) window and returns the
  // best-aligned position. The new anchor points just past the aligned region.
  #search(spoken, from, to, threshold, allowBehind = false) {
    const mw = this.script.matchWords;
    let bestSim = -1;
    let bestEnd = this.anchor;
    for (let start = from; start < to; start++) {
      const length = Math.min(spoken.length, mw.length - start);
      if (length <= 0) break;
      const sim = similarity(spoken, mw.slice(start, start + length));
      if (sim > bestSim) {
        bestSim = sim;
        bestEnd = start + length;
      }
    }
    const accepted = bestSim >= threshold
      && (allowBehind || bestEnd >= this.anchor - this.options.backTolerance);
    return { accepted, newAnchor: bestEnd, confidence: bestSim, advanced: bestEnd > this.anchor };
  }
}
