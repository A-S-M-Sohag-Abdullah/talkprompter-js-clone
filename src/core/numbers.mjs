// Expands digit strings into spoken English cardinal words so that a script
// written as "25" matches a speaker who says "twenty five". Speech engines
// almost always emit number words, so aligning both sides on words removes a
// common source of missed matches.

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen'
];

const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const SCALES = [
  [1_000_000_000, 'billion'],
  [1_000_000, 'million'],
  [1_000, 'thousand']
];

export function isAllDigits(s) {
  return typeof s === 'string' && /^[0-9]+$/.test(s);
}

/**
 * Returns the spoken words for a digit string, or the original string as a
 * single element when it cannot be expanded (too long, not numeric).
 */
export function numberToWords(digits) {
  if (!isAllDigits(digits) || digits.length > 15) return [digits];
  let n = Number(digits);
  if (!Number.isSafeInteger(n)) return [digits];

  const out = [];
  if (n === 0) return ['zero'];

  for (const [value, name] of SCALES) {
    if (n >= value) {
      appendThreeDigits(Math.floor(n / value), out);
      out.push(name);
      n %= value;
    }
  }
  if (n > 0) appendThreeDigits(n, out);
  return out.length === 0 ? ['zero'] : out;
}

function appendThreeDigits(n, out) {
  if (n >= 100) {
    out.push(ONES[Math.floor(n / 100)], 'hundred');
    n %= 100;
  }
  if (n >= 20) {
    out.push(TENS[Math.floor(n / 10)]);
    n %= 10;
    if (n > 0) out.push(ONES[n]);
  } else if (n > 0) {
    out.push(ONES[n]);
  }
}
