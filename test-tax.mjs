import { parseTax } from "./tax.mjs";
const s = `Skatthlutfall einstaklinga í staðgreiðslu 2026
| Skattþrep 1: Af tekjum 0 – 498.122 kr. | 31,49% |
| Skattþrep 2: Af tekjum 498.123 - 1.398.450 kr. | 37,99% |
| Skattþrep 3: Af tekjum yfir 1.398.450 kr. | 46,29% |
| Persónuafsláttur á mánuði | 72.492 kr. |`;
const r = parseTax(s, 2026);
console.log(JSON.stringify(r));
if (!r || r.br1 !== 498122 || r.br2 !== 1398450 || r.t3 !== 46.29 || r.credit !== 72492) { console.error("FAIL"); process.exit(1); }
console.log("tax ok");
