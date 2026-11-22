// Port of RateParser.java: finds buy/sell pairs in the visible text of a bank page.

const NUM = /(?<![\d.,])\d{1,4}(?:[.,]\d{1,6})?(?!\d)/g;

export const EUR_LABELS = ["EUR", "Euro", "Evra"];
export const USD_LABELS = ["USD", "United State", "US dollar", "Bandaríkjadal", "Dolar amerykański"];
export const PLN_LABELS = ["PLN", "Polish zloty", "Polish złoty", "Pólsk", "Zloty", "Złoty"];

const KNOWN_CODES = new Set(["EUR", "USD", "PLN", "GBP", "CHF", "SEK", "NOK", "DKK", "JPY", "CZK", "CAD", "HUF", "AUD",
  "MXN", "RON", "ZAR", "THB", "ILS", "HKD", "TRY", "BGN", "ISK", "CNY", "NZD", "SGD", "AED",
  "UAH", "BRL", "PHP", "XDR", "INR", "KRW", "IDR", "MYR", "CLP", "SAR", "QAR", "KWD", "RUB", "LTL"]);

const NAMES = {
  EUR: EUR_LABELS, USD: USD_LABELS, PLN: PLN_LABELS,
  GBP: ["GBP", "Sterlingspund", "Pound sterling", "British pound"],
  NOK: ["NOK", "Norsk króna", "Norwegian krone"],
  SEK: ["SEK", "Sænsk króna", "Swedish krona"],
  DKK: ["DKK", "Dönsk króna", "Danish krone"],
  CHF: ["CHF", "Svissneskur frank", "Swiss franc"],
  JPY: ["JPY", "Japanskt jen", "Japanese yen"],
  CAD: ["CAD", "Kanadadal", "Canadian dollar"],
  AUD: ["AUD", "Ástralíudal", "Australian dollar"],
};

/** Labels identifying a currency row: code plus common English/Icelandic names (same as RateParser.labels). */
export function labels(code) { return NAMES[code] || [code]; }

export function lineMatches(line, labels) {
  for (const l of labels) {
    if (l.length <= 3 && l === l.toUpperCase()) {
      if (new RegExp(`(?<![A-Za-z])${l}(?![a-z])`).test(line)) return true;
    } else if (line.toLowerCase().includes(l.toLowerCase())) return true;
  }
  return false;
}

export function numbers(line) {
  const out = [];
  for (const m of line.matchAll(NUM)) {
    const end = m.index + m[0].length;
    if (line[end] === "%") continue;
    const v = parseFloat(m[0].replace(",", "."));
    if (!Number.isNaN(v)) out.push(v);
  }
  return out;
}

function startsWithOtherCode(line, labels) {
  const m = /^\s*([A-Z]{3})(?![A-Za-z])/.exec(line);
  if (!m || !KNOWN_CODES.has(m[1])) return false;
  return !labels.includes(m[1]);
}

/** @returns [buy, sell] or null. maxValues=1 accepts a single rate. */
export function findPair(text, labels, expected, tol, maxValues = 2) {
  if (!text || !(expected > 0)) return null;
  const lines = text.split(/\r?\n/);
  const lo = expected * (1 - tol), hi = expected * (1 + tol);
  let single = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lineMatches(lines[i], labels)) continue;
    const found = [];
    for (let j = i; j < Math.min(lines.length, i + 8) && found.length < 2; j++) {
      if (j > i && startsWithOtherCode(lines[j], labels)) break;
      for (const v of numbers(lines[j])) {
        if (v >= lo && v <= hi) { found.push(v); if (found.length === 2) break; }
      }
    }
    if (found.length >= 2) return [Math.min(found[0], found[1]), Math.max(found[0], found[1])];
    if (found.length === 1 && !single) single = [found[0], found[0]];
  }
  return maxValues === 1 ? single : null;
}

/** Label-less fallback (currency names shown as images). */
export function findPairByValue(text, expected, tol) {
  if (!text || !(expected > 0)) return null;
  const lo = expected * (1 - tol), hi = expected * (1 + tol);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const found = [];
    for (let j = i; j < Math.min(lines.length, i + 3) && found.length < 2; j++) {
      for (const v of numbers(lines[j])) {
        if (v >= lo && v <= hi) { found.push(v); if (found.length === 2) break; }
      }
      if (found.length === 0) break;
    }
    if (found.length === 2) {
      const a = Math.min(...found), b = Math.max(...found);
      if (b / a < 1.03) return [a, b];
    }
  }
  return null;
}
