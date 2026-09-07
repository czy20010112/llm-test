'use strict';

const REPEATED_CHARACTER_MIN = 128;
const REPEATED_PATTERN_MIN_REPEATS = 8;
const REPEATED_PATTERN_MAX_UNIT = 16;
const REPEATED_PATTERN_MIN_LENGTH = 96;

function detectOutputLoop(text) {
  const value = String(text || '').trimEnd();
  if (!value) return null;

  // Check the meaningful suffix so line breaks between repeated punctuation do
  // not hide a generation loop.
  const compact = Array.from(value).filter((char) => !/\s/u.test(char));
  if (compact.length >= REPEATED_CHARACTER_MIN) {
    const last = compact[compact.length - 1];
    let run = 0;
    for (let i = compact.length - 1; i >= 0 && compact[i] === last; i--) run++;
    if (run >= REPEATED_CHARACTER_MIN) {
      return { kind: 'repeated-character', char: last, length: run };
    }
  }

  // Short exact patterns are a common failure mode for reasoning models. A
  // minimum total length and repetition count keep ordinary prose from being
  // classified as a loop.
  for (let unitLength = 2; unitLength <= REPEATED_PATTERN_MAX_UNIT; unitLength++) {
    if (value.length < unitLength * REPEATED_PATTERN_MIN_REPEATS) continue;
    const unit = value.slice(-unitLength);
    if (!unit || /^\s+$/u.test(unit) || new Set(Array.from(unit)).size === 1) continue;
    let repeats = 1;
    let cursor = value.length - unitLength;
    while (cursor >= unitLength && value.slice(cursor - unitLength, cursor) === unit) {
      repeats++;
      cursor -= unitLength;
    }
    const repeatedLength = repeats * unitLength;
    if (repeats >= REPEATED_PATTERN_MIN_REPEATS && repeatedLength >= REPEATED_PATTERN_MIN_LENGTH) {
      return { kind: 'repeated-pattern', pattern: unit, repeats, length: repeatedLength };
    }
  }
  return null;
}

module.exports = { detectOutputLoop };
