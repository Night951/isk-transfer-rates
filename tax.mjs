// Icelandic withholding tax (staðgreiðsla) from skatturinn.is "Helstu tölur og prósentur <year>".
const n = (s) => Number(String(s).replace(/\./g, "").replace(",", "."));

/** {year, br1, br2, t1, t2, t3, credit} or null. Text is the page's visible text. */
export function parseTax(text, year) {
  const t = text.replace(/ /g, " ").replace(/\s+/g, " ");
  const step = (k) => t.match(new RegExp(`Skattþrep ${k}:?[^%]{0,80}?(\\d{1,2},\\d{2})\\s*%`, "i"));
  const s1 = step(1), s2 = step(2), s3 = step(3);
  const b1 = t.match(/Skattþrep 1:?\s*Af tekjum\s*0\s*[–-]\s*([\d.]{6,})/i);
  const b2 = t.match(/Skattþrep 2:?\s*Af tekjum\s*[\d.]+\s*[–-]\s*([\d.]{6,})/i);
  const c = t.match(/Persónuafsláttur á mánuði\s*\|?\s*([\d.]{5,})/i);
  if (!s1 || !s2 || !s3 || !b1 || !b2 || !c) return null;
  const r = { year, br1: n(b1[1]), br2: n(b2[1]), t1: n(s1[1]), t2: n(s2[1]), t3: n(s3[1]), credit: n(c[1]) };
  const ok = r.br1 > 200000 && r.br2 > r.br1 && r.t1 > 20 && r.t2 > r.t1 && r.t3 > r.t2 && r.t3 < 70 && r.credit > 30000 && r.credit < 200000;
  return ok ? r : null;
}

// Norway: skatteetaten.no "satser" pages (one per topic, ?year=YYYY). Texts are joined by "\n#####\n".
const nn = (s) => Number(String(s).replace(/[\s ]/g, "").replace(",", "."));

/** {year, pers, minPct, minMax, tryg, trygLow, b1..b5, s1..s5} or null. */
export function parseNoTax(text, year) {
  const t = text.replace(/ /g, " ").replace(/\t/g, " ");
  const r = { year };
  const pers = t.match(/Klasse 1\s+([\d ]{6,9}) kroner/);
  const min = t.match(/Lønnsinntekt\s+Sats\s+(\d+(?:,\d+)?) ?%\s+Øvre grense \*?\s+([\d ]{5,9}) kr/);
  const tryg = t.match(/Lønnsinntekt, sykepenger[^\n]*\n[^\n]*?(\d+,\d) ?%/);
  const low = t.match(/Nedre grense[\s\S]{0,80}?([\d ]{5,8}) kr/);
  if (!pers || !min || !tryg || !low) return null;
  r.pers = nn(pers[1]); r.minPct = nn(min[1]); r.minMax = nn(min[2]); r.tryg = nn(tryg[1]); r.trygLow = nn(low[1]);
  for (let k = 1; k <= 5; k++) {
    const m = t.match(new RegExp(`Trinn ${k}\\s+Inntekten (?:mellom|fra og med) ([\\d ]{6,11}?)\\s*(?:–|-|kroner)[^\\n]*?(\\d+,\\d) ?%`));
    if (!m) return null;
    r["b" + k] = nn(m[1]) - 1;
    r["s" + k] = nn(m[2]);
  }
  const ok = r.pers > 50000 && r.minPct > 20 && r.minMax > 40000 && r.tryg > 3 && r.tryg < 15 && r.trygLow > 30000
    && r.b1 > 100000 && r.b2 > r.b1 && r.b3 > r.b2 && r.b4 > r.b3 && r.b5 > r.b4 && r.s1 < r.s2 && r.s5 < 30;
  return ok ? r : null;
}
