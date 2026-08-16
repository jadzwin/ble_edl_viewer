# Kompilacja ECUMaster BT RX Stats v1.6 bez Android Studio

## Aktualizacja istniejącego repozytorium

Rozpakuj archiwum aktualizacyjne i prześlij do głównego katalogu repozytorium wszystkie zawarte w nim pliki, zachowując katalog `src/`:

```text
App.tsx
app.json
package.json
README_PL.md
src/BleStatsCollector.ts
src/channels.ts
src/config.ts
src/controlProtocol.ts
```

Na GitHubie:

1. Wejdź w **Code → Add file → Upload files**.
2. Prześlij powyższe pliki i folder `src`.
3. Kliknij **Commit changes** i zapisz na gałęzi `main`.
4. Wejdź w **Actions → Build Android APK**.
5. Kliknij **Run workflow**, wybierz `main` i ponownie **Run workflow**.
6. Po zielonym zakończeniu pobierz artefakt `ECUMaster-BLE-RX-Stats-APK`.
7. Rozpakuj artefakt i zainstaluj znajdujący się w nim plik APK.

Nie używaj **Re-run**, ponieważ ponowne wykonanie starego joba buduje commit przypisany do tamtego uruchomienia, a nie najnowszy stan gałęzi `main`.

## Pierwszy test po instalacji

1. Połącz aplikację z modułem przez BLE albo SPP.
2. Otwórz zakładkę **Sterowanie**.
3. Poczekaj, aż aplikacja pokaże `OK` dla kanałów 254, 253 i 252.
4. Sprawdź, czy przełączniki oraz rotary zostały zainicjalizowane.
5. Zmień kilka wartości i obserwuj liczniki `ID 254 polls`, `queued` i `sent`.
6. Przy aktywnym kanale 99 obserwuj liczniki odpowiedzi RTT oraz wartość kanału `Round trip time`.

## Pełny projekt

Dla nowego repozytorium prześlij całą zawartość archiwum pełnego projektu. Plik workflow musi znajdować się dokładnie pod ścieżką:

```text
.github/workflows/android-apk.yml
```
