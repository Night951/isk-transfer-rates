# Serwer kursów ISK Transfer (GitHub Actions + GitHub Pages)

Automat co ok. 15 minut otwiera strony Landsbankinn, Íslandsbanki, Arion banki i Kantoru Alior w przeglądarce bez okna, odczytuje kursy wszystkich walut obsługiwanych przez aplikację, pobiera kursy monobanku i PrivatBanku z ich API i publikuje plik `rates.json`. Aplikacja czyta ten plik zamiast pobierać strony banków na telefonie. Jest szybciej, a gdy bank zmieni wygląd strony, wystarczy poprawić skrypt tutaj, bez nowej wersji w Sklepie Play. Jeśli plik jest niedostępny albo starszy niż 3 godziny, aplikacja wraca do pobierania na telefonie.

Na tej samej stronie jest też **polityka prywatności** (`privacy.html`), której adres podasz w Play Console.

## Uruchomienie (ok. 10 minut)

1. **Utwórz repozytorium publiczne** na GitHubie, np. `isk-transfer-rates`.
   Musi być publiczne: GitHub Actions jest wtedy darmowy bez limitu minut. Prywatne repozytorium szybko wyczerpałoby darmowe 2000 minut miesięcznie.
2. **Wgraj zawartość tego folderu** (`server/`) do repozytorium, łącznie z ukrytym folderem `.github`.
   Najprościej: na stronie repozytorium kliknij *Add file → Upload files* i przeciągnij wszystkie pliki i foldery. Jeśli przeglądarka pominie folder `.github`, utwórz ręcznie plik `.github/workflows/rates.yml` (*Add file → Create new file*) i wklej jego treść.
3. **Włącz GitHub Pages:** *Settings → Pages → Build and deployment → Source:* wybierz **GitHub Actions**.
4. **Uruchom pierwszy raz:** zakładka *Actions → Kursy ISK Transfer → Run workflow*. Po 2–4 minutach w logu kroku „node scrape.mjs” zobaczysz, które banki się odczytały.
5. **Sprawdź adresy** (zamień `TWOJA-NAZWA` na swój login GitHub):
   - kursy: `https://TWOJA-NAZWA.github.io/isk-transfer-rates/rates.json`
   - polityka prywatności: `https://TWOJA-NAZWA.github.io/isk-transfer-rates/privacy.html`
6. **Uzupełnij politykę prywatności:** w `public/privacy.html` wpisz w nawiasach kwadratowych swoje imię/nazwę, e-mail i datę.
7. **Wpisz oba adresy w aplikacji:** plik `app/src/main/java/pl/iskpln/kalkulator/Config.java`, pola `RATES_URL` i `PRIVACY_URL`.

## Dobrze wiedzieć

- **Wyłączanie po 60 dniach:** GitHub wyłącza zaplanowane uruchomienia w repozytoriach publicznych, w których przez 60 dni nie było żadnej zmiany. Dostaniesz wtedy e-mail. Wystarczy wejść w *Actions* i kliknąć *Enable workflow* albo co jakiś czas zrobić dowolny commit.
- **Opóźnienia:** GitHub nie gwarantuje dokładnego co-15-minutowego uruchamiania. W godzinach szczytu bywa co 20–30 minut. Dla kursów, które banki zmieniają kilka razy dziennie, to wystarcza.
- **Blokady:** bank może kiedyś zablokować ruch z serwerów GitHuba. Wtedy w logu zobaczysz puste wyniki dla tego banku, a aplikacja użyje pobierania na telefonie.
- **Test parsera:** `npm test` uruchamia testy odczytu na przykładowych danych.

## Format `rates.json` (wersja 2)

```json
{
  "version": 2,
  "updatedMs": 1763700000000,
  "updated": "2026-11-21T08:00:00.000Z",
  "nbp": { "EUR": 4.4559, "USD": 4.0613, "ISK": 0.032477, "UAH": 0.0903, "...": 0 },
  "banks": {
    "landsbankinn": {
      "rates": { "EUR": [143.57, 144.68], "USD": [132.93, 133.96], "PLN": [34.41, 34.80], "GBP": [163.1, 164.2], "...": [] },
      "card": { "PLN": 34.55, "EUR": 142.9 }
    },
    "islandsbanki": { "rates": { }, "card": { } },
    "arion": { "rates": { }, "card": { } }
  },
  "alior": { "eur": [4.2312, 4.2598], "usd": [3.6401, 3.6702] },
  "ua": { "monobank": { "eur": [49.26, 50.0], "usd": [44.91, 45.40] }, "privatbank": { "eur": [49.25, 50.25], "usd": [44.9, 45.45] } }
}
```
Pary to `[kupno, sprzedaż]`. Aplikacja bierze z banków islandzkich kurs sprzedaży (ISK za 1 jednostkę), a z Kantoru Alior, monobanku i PrivatBanku kurs kupna. Lista walut w `scrape.mjs` (`CODES`) musi odpowiadać liście w `Dest.java`. Jeśli bank nie sprzedaje danej waluty, po prostu jej nie ma w `rates`.

Wersje aplikacji od 6.0 czytają tylko format 2. Starsze wersje (z formatem 1) nie były publikowane w sklepie, więc nie trzeba utrzymywać zgodności.
