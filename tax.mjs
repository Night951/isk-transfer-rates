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
