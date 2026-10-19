# pocket-bridge / PMS

Personal system for tracking an XTB portfolio. It combines Pocket voice questions, Gmail transaction confirmations,
Google Drive notes, and market news. Every morning it prepares a brief, and everything is visible on a
trading-style web page.

```
Główny Gmail ──(przekazanie)──▶ drugi Gmail ──Apps Script (co 5 min)──▶ Dysk: PMS/inbox/xtb/*.json + PDF
                                                                          │  Google Drive for desktop
Pocket ─▶ iOS ─▶ chmura Pocket ─webhook─▶ tunel ─▶ Mac :8787 ◀────────────┘
                                                   │
                     ┌─────────────────────────────┼──────────────────────────────┐
                     ▼                             ▼                              ▼
          import XTB (Claude czyta mail/PDF)  pytanie głosowe / wpisane   poranny brief 07:30 (pn–pt)
          → PMS/data/transactions.json        → Claude + MCP „pms” + web  → Claude + MCP „pms” + web
                                                   │                              │
                                                   └────────▶ PMS/xtb-news/*.json|html ◀┘
                                                              http://127.0.0.1:8787  (strona PMS)
```

## Konfiguracja krok po kroku

### 1. Dysk Google na Macu
1. Zainstaluj **Google Drive for desktop**: `brew install --cask google-drive` albo pobierz ze strony Google.
2. Zaloguj się **drugim kontem** Gmail, czyli tym, na które przekazujesz maile XTB.
3. W `.env` ustaw ścieżkę do folderu PMS (`open -e ~/pocket-bridge/.env`):
   ```
   PMS_DIR=~/Library/CloudStorage/GoogleDrive-DRUGIE.KONTO@gmail.com/My Drive/PMS
   ```
   W ustawieniach Google Drive wybierz dla folderu PMS tryb **„Mirror”** albo „Dostępne offline”, żeby pliki były na dysku Maca.
4. Zrestartuj usługę: `launchctl kickstart -k gui/$(id -u)/com.pocket-bridge.server`

### 2. Apps Script na drugim koncie Gmail
1. Zaloguj się na drugie konto i wejdź na <https://script.google.com>, a potem **Nowy projekt**.
2. Wklej zawartość `google-apps-script/Code.gs` i zapisz.
3. Wybierz funkcję `setup` i kliknij **Uruchom**. Zaakceptuj uprawnienia (Gmail i Dysk, tylko Twoje konto).
   Skrypt utworzy foldery `PMS/inbox/xtb`, `PMS/notes`, `PMS/xtb-news` i `PMS/data`. Od teraz co 5 minut przenosi
   maile XTB na Dysk, a co 15 minut eksportuje Twoje Google Docs i Sheets z `PMS/notes` do zwykłego tekstu.

### 3. Przekazywanie maili z głównego konta
- **Ręcznie:** wybierz „Przekaż dalej” na mailu „Potwierdzenie wykonania zleceń”, z załącznikami.
- **Automatycznie:** w głównym Gmailu wejdź w Ustawienia → Przekazywanie i dodaj drugi adres (Gmail wyśle kod
  potwierdzający). Potem utwórz filtr: Od `xtb`, Temat `Potwierdzenie wykonania`, akcja „Przekaż do: drugi adres”.

### 4. Notatki o spółkach i ETF-ach
Wrzucaj do `PMS/notes` pliki `.md`, `.txt` albo `.csv`, Google Docs lub Sheets (eksportowane automatycznie),
np. `CDR.PL.md` z Twoją tezą inwestycyjną. Agenci czytają je przy pytaniach i w porannym briefie.

## Codzienne użycie

- **„+ Dodaj operacje”** (prawy górny róg strony): wybierz rodzaj z listy i upuść plik albo wybierz go z dysku.
  - *Potwierdzenie transakcji*: PDF, mail `.eml`, zrzut ekranu lub CSV. Claude dopisuje transakcje do księgi.
  - *Stan portfela*: zrzut pozycji z xStation albo CSV. **Zastępuje** wszystkie pozycje (stan wyjściowy).
  - *Wpis ręczny*: symbol, strona, wolumen, cena, waluta i data.
  Upuszczenie pliku w dowolnym miejscu strony otwiera panel.
- **Wykresy na żywo** (Yahoo, odświeżanie co 60 s): wartość portfela 1D/5D/1M/3M/1R, mini-wykresy 1M przy pozycjach
  i strona waloru (`/p/NVDA.US`) z linią Twojej średniej ceny zakupu.
- **Feed newsów o Twoich spółkach** (zakładka „Newsy o Twoich spółkach”). Źródła: Yahoo Finance (USA, ETF-y)
  i Google News (GPW: Bankier, Parkiet, PAP, Stockwatch…), z ostatnich 30 dni, od najnowszych, z filtrem po walorze.
  Świeże newsy o pozycji, która mocno się dziś rusza, albo z ważnym słowem (wyniki, rekomendacja, przejęcie, cła…) są
  oznaczone PILNE lub WAŻNE. **Kliknięcie newsa** otwiera stronę, na której Claude czyta artykuł i w 1–2 minuty
  przygotowuje analizę wpływu na portfel. Analiza jest zapamiętana, a w feedzie pojawia się „✓ Analiza PMS gotowa”.
  Zapytania dla walorów możesz zmienić w `PMS/data/news-queries.json`, np.
  `{"XTB.PL": {"q": "XTB (akcje OR wyniki)", "lang": "pl", "excludeSources": ["xtb.com"]}}`.
- Zadania „na żywo” (kliknięty news, pytanie, Pocket) mają osobną kolejkę i nie czekają na brief, skan ani import.
- **Newsy od najnowszych.** Co 2 godziny (pn–pt, 8–21) skaner sprawdza newsy dla Twoich pozycji i publikuje alert,
  tylko gdy dzieje się coś istotnego. Wydarzenia, które realnie ruszają pozycje, są oznaczone **PILNE**: czerwony
  baner, czerwona miniaturka z wykresem i powiadomienie na Macu.
- **Strona PMS:** <http://127.0.0.1:8787>. Zawiera nagłówki, portfel, radar wpływu, pole „Zapytaj” i przycisk „Brief teraz”.
- **Pocket:** zacznij nagranie od hasła **„XTB news”**, np. „XTB news. Jak cła na Chiny wpłyną na moje ETF-y?”.
  Do PMS trafiają **tylko** nagrania, które mają to hasło w pierwszym zdaniu. Dopasowanie toleruje błędy
  transkrypcji: „XTB newsy”, „x t b news”, „iks te be news”. Wszystkie inne nagrania (spotkania, notatki) są
  odrzucane, a z ich treści nic nie jest zapisywane. Do agenta trafia samo pytanie, bez hasła. Własne hasła ustawisz
  w `TRIGGER_PHRASES` w `.env`.
- **Rano (pn–pt, 07:30):** poranny brief o Twoich pozycjach z kierunkiem i prawdopodobieństwem. Jeśli Mac
  spał o 7:30, brief zrobi się po wybudzeniu.
- **Raporty** trafiają też do `PMS/xtb-news/*.html` na Dysku, więc otworzysz je na telefonie.

## MCP „pms” w Claude Code / Claude Desktop

```
claude mcp add pms -s user -- node ~/pocket-bridge/mcp-server.mjs
```
Narzędzia: `get_portfolio`, `get_transactions`, `add_transactions`, `get_quotes`, `get_price_history`,
`get_correlations`, `list_notes`, `read_note`, `save_report`, `list_reports`, `get_report`, `list_commands`, …

## Dane i założenia

- Księga transakcji to `PMS/data/transactions.json`. Duplikaty są pomijane (numer zlecenia), a pozycje liczone są metodą średniego kosztu.
- Notowania pochodzą z Yahoo Finance (bez klucza). Symbole XTB są mapowane automatycznie (`.PL`→`.WA`, `.UK`→`.L`, `.US`→bez sufiksu …).
  Wyjątki dodasz w `PMS/data/symbols.json`, np. `{"XYZ.PL": "XYZ.WA"}`.
- Koszt w PLN pochodzi z maila XTB (wartość lub kurs przewalutowania). Gdy go brak, liczony jest po bieżącym kursie i oznaczony `*`.
- Prawdopodobieństwa w raportach to subiektywne oceny modelu. To analiza scenariuszy, nie rekomendacja inwestycyjna.

## Pocket (webhook)

W aplikacji Pocket dodaj webhook na adres `https://<adres-tunelu><WEBHOOK_PATH z .env>`. Tunel uruchamiasz przez `./scripts/tunnel.sh`.
Darmowy tunel zmienia adres po restarcie. Stały adres wymaga nazwanego tunelu Cloudflare albo domeny ngrok.
Gdy plan Pocket nie ma webhooków: ustaw `POLL_INTERVAL_SEC=60` i `POCKET_API_KEY` (Settings → Developer → API Keys).

## Bezpieczeństwo

- Przez tunel dostępny jest **tylko** tajny adres webhooka. Strona, API portfela i „Zapytaj” działają wyłącznie lokalnie na Macu.
- Treść raportów (z internetu) jest oczyszczana i blokowana przez CSP. Wstrzyknięte skrypty się nie uruchomią.
- Agenci mają tylko WebSearch, WebFetch i MCP „pms”. Agent importu czyta wyłącznie pliki maila. Żaden nie ma terminala ani dostępu do XTB.

## Opcje (.env)

| zmienna | znaczenie |
|---|---|
| `PMS_DIR` | folder PMS (Dysk Google) |
| `DAILY_BRIEF_TIME` / `DAILY_BRIEF_DAYS` | godzina i dni briefu (puste = wyłączony) |
| `NEWS_SCAN_INTERVAL_MIN` / `NEWS_SCAN_HOURS` / `NEWS_SCAN_DAYS` | skaner newsów (alerty/PILNE); 0 = wyłączony |
| `INGEST_INTERVAL_SEC` / `INGEST_MODEL` | częstotliwość skanowania maili XTB / model do parsowania (np. `haiku`) |
| `WEBHOOK_PATH` / `REQUIRE_SIGNATURE` | tajna ścieżka webhooka Pocket / weryfikacja HMAC |
| `REQUIRE_TRIGGER` / `TRIGGER_PHRASES` | hasło w pierwszym zdaniu nagrania, które kieruje je do PMS (domyślnie „XTB news”) |
| `POLL_INTERVAL_SEC` + `POCKET_API_KEY` | alternatywa dla webhooka: odpytywanie API Pocket |
| `OPEN_REPORT` / `NOTIFY` / `USE_CHROME` / `CLAUDE_MODEL` | zachowanie agentów |

Instrukcje dla agentów są w `prompts/` (`voice.md`, `daily.md`, `scan.md`, `xtb-parse.md`).
Logi: `tail -f ~/pocket-bridge/logs/server.log`
