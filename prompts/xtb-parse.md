Twoje zadanie to import danych z XTB do PMS. Źródło: {{ORIGIN}}. Typ wybrany przez użytkownika: {{UPLOAD_KIND}}.
Pliki są w bieżącym katalogu:

Metadane i treść maila: {{EMAIL_JSON}}
Załączniki: {{ATTACHMENTS}}

1. Przeczytaj plik JSON (metadane i ewentualna treść maila) i KAŻDY załącznik narzędziem Read: PDF, zrzut ekranu
   (PNG/JPG), CSV, HTML albo .eml.
   JEŚLI typ to „snapshot” (stan portfela): dokument powinien pokazywać WSZYSTKIE otwarte pozycje (symbol, wolumen,
   średnia cena otwarcia). Zapisz je przez set_portfolio_snapshot(positions=[{symbol, name, quantity, avgPrice,
   currency}], source="{{MESSAGE_ID}}"). Waluty ustal z symbolu i opisu (np. „ACC, EUR”). Pomiń kroki 2–3 i przejdź do 4.
   Jeśli dokument nie wygląda na pełną listę pozycji, NIE nadpisuj stanu. Wtedy status="failed" z wyjaśnieniem.
2. Wyodrębnij WSZYSTKIE wykonane transakcje. Dla każdej podaj: executedAt (ISO, czas wykonania), symbol
   (w formacie XTB, np. CDR.PL, AAPL.US, SXR8.DE, VUAA.UK; jeśli dokument podaje tylko nazwę lub ISIN,
   ustal symbol XTB), name, side (BUY/SELL), quantity, price (cena jednostkowa w walucie instrumentu),
   currency (waluta instrumentu), valueBase (wartość w walucie rachunku {{BASE}}, jeśli podana), fxRate
   (kurs przewalutowania, jeśli podany), commission (jeśli podana), orderId (numer zlecenia/pozycji).
   Nie zgaduj liczb. Jeśli czegoś nie ma w dokumencie, pomiń to pole.
3. Zapisz je jednym wywołaniem add_transactions(transactions=[...], source_type="xtb-email", source_ref="{{MESSAGE_ID}}").
4. Wywołaj complete_command(id="{{COMMAND_ID}}", status="done", summary="Zaimportowano N transakcji: ...").
   Jeśli to nie jest potwierdzenie transakcji albo nie da się odczytać danych (np. PDF jest zaszyfrowany),
   wywołaj complete_command ze status="failed" i opisz powód. Nie dodawaj wtedy żadnych transakcji.
