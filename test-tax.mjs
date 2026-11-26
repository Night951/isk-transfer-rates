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

import { parseNoTax } from "./tax.mjs";
const no = `Klasse 1\t114 540 kroner
#####
Lønnsinntekt\t \nSats\t46 %\nØvre grense *\t95 700 kr
#####
 \tInntekten mellom 0 – 226 100 kroner\tIngen trinnskatt
Trinn 1\tInntekten mellom 226 101 – 318 300 kroner\t1,7 % trinnskatt
Trinn 2\tInntekten mellom 318 301 – 725 050 kroner\t4,0 %  trinnskatt
Trinn 3\tInntekten mellom 725 051 – 980 100 kroner\t13,7 % trinnskatt  
Trinn 4\tInntekten mellom 980 101 – 1 467 200 kroner \t16,8 % trinnskatt
Trinn 5\tInntekten fra og med 1 467 201 kroner\t17,8 %  trinnskatt
#####
 \tSats
Lønnsinntekt, sykepenger osv.
(personer i alderen 17 til 69 år i inntektsåret)\t7,6 %
Nedre grense i personinntekten / grunnlaget
for å beregne trygdeavgift\t99 650 kr`;
const rn = parseNoTax(no, 2026);
console.log(JSON.stringify(rn));
if (!rn || rn.pers !== 114540 || rn.minMax !== 95700 || rn.b1 !== 226100 || rn.b5 !== 1467200 || rn.s4 !== 16.8 || rn.tryg !== 7.6 || rn.trygLow !== 99650) { console.error("NO FAIL"); process.exit(1); }
console.log("no tax ok");

import { parseSeTables, parseDkTax } from "./tax.mjs";
let se = "";
for (let t = 29; t <= 40; t++) { for (let i = 0; i < 120; i++) se += `30B${t}   ${2001 + i * 100}   ${2100 + i * 100}  ${150 + i}    0\n`; se += `30%${t}  80001          52   52\n`; }
const st = parseSeTables(se);
if (!st || st.tables["32"][0][2] !== 150 || st.tables["32"].at(-1)[2] !== -52) { console.error("SE FAIL", st && st.tables["32"].at(-1)); process.exit(1); }
console.log("se tables ok");
const dk = parseDkTax(`Bundskat: 12,01 %  \nMellemskat: 7,5 %  \nhvis du har en personlig indkomst over 641.200 kr. efter am-bidrag, skal du\nTopskat: 7,5 % \nHvis du har en personlig indkomst over 777.900 kr. efter am-bidrag\nToptopskat: 5 %\nhar en personlig indkomst over 2.592.700 kr. efter am-bidrag`, 2026);
if (!dk || dk.bund !== 12.01 || dk.mellemLim !== 641200 || dk.topLim !== 777900 || dk.ttLim !== 2592700) { console.error("DK FAIL", dk); process.exit(1); }
console.log("dk tax ok");
