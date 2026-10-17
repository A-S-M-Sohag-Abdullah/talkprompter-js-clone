// Ported from the original Teleprompter.Core.Tests (ScriptMatcherTests et al.).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScript, toMatchWords, textRulesFor, normalizeWord } from '../src/core/text.mjs';
import { ScriptMatcher, TrackingState, levenshtein } from '../src/core/matcher.mjs';
import { numberToWords } from '../src/core/numbers.mjs';
import { smoothDamp } from '../src/core/smoothDamp.mjs';

const FOX = 'The quick brown fox jumps over the lazy dog.';
const NATO = 'alpha bravo charlie delta echo. foxtrot golf hotel india juliet. kilo lima mike november oscar.';
const wordAt = (model, i) => (i >= 0 ? model.tokens[i].normalized : '<none>');

function feedGrowing(matcher, utterance) {
  const words = utterance.split(' ').filter(Boolean);
  let update;
  for (let i = 1; i <= words.length; i++) update = matcher.process(words.slice(0, i).join(' '));
  return update;
}

test('first spoken word advances immediately when expected', () => {
  const model = buildScript(FOX);
  const u = new ScriptMatcher(model).process('the');
  assert.equal(u.state, TrackingState.Tracking);
  assert.equal(wordAt(model, u.tokenIndex), 'the');
});

test('lone off-script word does not advance', () => {
  assert.equal(new ScriptMatcher(buildScript(FOX)).process('banana').tokenIndex, -1);
});

test('first word after pause advances immediately', () => {
  const m = new ScriptMatcher(buildScript(FOX));
  feedGrowing(m, 'the quick brown fox');
  const before = m.currentTokenIndex;
  const u = m.process('jumps');
  assert.equal(u.state, TrackingState.Tracking);
  assert.equal(u.tokenIndex, before + 1);
});

test('clean read advances to end monotonically', () => {
  const model = buildScript(FOX);
  const m = new ScriptMatcher(model);
  let last = -1;
  for (const p of ['the quick brown', 'the quick brown fox jumps', 'the quick brown fox jumps over the lazy dog']) {
    const u = m.process(p);
    assert.ok(u.tokenIndex >= last);
    last = u.tokenIndex;
  }
  assert.equal(wordAt(model, m.currentTokenIndex), 'dog');
});

test('pause holds position', () => {
  const m = new ScriptMatcher(buildScript(FOX));
  m.process('the quick brown');
  const held = m.currentTokenIndex;
  m.process('um');
  const u = m.process('um well');
  assert.equal(u.advanced, false);
  assert.equal(m.currentTokenIndex, held);
  assert.equal(m.state, TrackingState.Paused);
});

test('off-script then resume continues tracking', () => {
  const model = buildScript(FOX);
  const m = new ScriptMatcher(model);
  m.process('the quick brown');
  const before = m.currentTokenIndex;
  m.process('so anyway let me think');
  assert.equal(m.currentTokenIndex, before);
  const u = m.process('brown fox jumps over');
  assert.equal(u.state, TrackingState.Tracking);
  assert.ok(['jumps', 'over'].includes(wordAt(model, m.currentTokenIndex)));
});

test('repeated words track the correct occurrence', () => {
  const model = buildScript('the cat and the dog and the bird');
  const m = new ScriptMatcher(model);
  feedGrowing(m, 'the cat and the dog');
  assert.equal(wordAt(model, m.currentTokenIndex), 'dog');
  m.process('and the bird');
  assert.equal(m.currentTokenIndex, 7);
});

test('skip ahead re-acquires after holding', () => {
  const script = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const m = new ScriptMatcher(buildScript(script));
  m.process('word0 word1 word2 word3 word4');
  assert.equal(m.currentTokenIndex, 4);
  let u;
  for (let i = 0; i < 8; i++) u = m.process('word25 word26 word27');
  assert.equal(u.state, TrackingState.Tracking);
  assert.ok(m.currentTokenIndex >= 25 && m.currentTokenIndex <= 27);
});

test('going lost reports lost state', () => {
  const script = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const m = new ScriptMatcher(buildScript(script));
  m.process('word0 word1 word2');
  let u;
  for (let i = 0; i < 8; i++) u = m.process('completely different nonsense phrase here');
  assert.equal(u.state, TrackingState.Lost);
});

test('numbers in script match spoken words', () => {
  const model = buildScript('we raised 25 million dollars last year');
  const m = new ScriptMatcher(model);
  m.process('we raised twenty five million');
  assert.equal(wordAt(model, m.currentTokenIndex), 'million');
});

test('seek and reset', () => {
  const model = buildScript(FOX);
  const m = new ScriptMatcher(model);
  m.seekToToken(4);
  assert.equal(wordAt(model, m.currentTokenIndex), 'jumps');
  m.reset();
  assert.equal(m.currentTokenIndex, -1);
  assert.equal(m.state, TrackingState.Idle);
});

test('re-read of earlier sentence re-acquires backward', () => {
  const model = buildScript(NATO);
  const m = new ScriptMatcher(model);
  feedGrowing(m, NATO.replace(/\./g, ''));
  assert.equal(wordAt(model, m.currentTokenIndex), 'oscar');
  let u;
  for (let r = 0; r < 3; r++) u = feedGrowing(m, 'alpha bravo charlie delta echo');
  assert.equal(u.state, TrackingState.Tracking);
  assert.equal(wordAt(model, u.tokenIndex), 'echo');
});

test('short backward echo does not yank position back', () => {
  const m = new ScriptMatcher(buildScript(NATO));
  feedGrowing(m, NATO.replace(/\./g, ''));
  const atEnd = m.currentTokenIndex;
  for (let i = 0; i < 12; i++) m.process('alpha bravo');
  assert.equal(m.currentTokenIndex, atEnd);
});

test('text normalization', () => {
  assert.deepEqual(toMatchWords("Don't stop, it's 2024!"), ['dont', 'stop', 'its', 'two', 'thousand', 'twenty', 'four']);
  assert.equal(normalizeWord('Café'), 'café');
  assert.equal(normalizeWord('İSTANBUL', textRulesFor('tr')), 'istanbul');
  assert.deepEqual(toMatchWords('25', textRulesFor('de')), ['25']);
  assert.deepEqual(numberToWords('1000001'), ['one', 'million', 'one']);
  assert.equal(levenshtein(['a', 'b', 'c'], ['a', 'c']), 1);
});

test('paragraph starts', () => {
  assert.deepEqual(buildScript('one two\n\nthree four\nfive\n\n\nsix').paragraphStarts, [0, 2, 5]);
});

test('smoothDamp converges without overshoot', () => {
  const st = { velocity: 0 };
  let v = 0;
  for (let i = 0; i < 120; i++) {
    v = smoothDamp(v, 100, st, 0.3, 1 / 60);
    assert.ok(v <= 100);
  }
  assert.ok(v > 99);
});
