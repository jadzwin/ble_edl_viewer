# Kompilacja ECUMaster BT RX Stats v1.3 bez Android Studio

## Aktualizacja istniejącego repozytorium

Do przejścia z v1.2 na v1.3 trzeba podmienić trzy pliki w głównym katalogu repozytorium:

```text
App.tsx
app.json
package.json
```

`package.json` jest konieczny, ponieważ v1.3 dodaje natywną bibliotekę obsługującą Bluetooth Classic/SPP.

1. Rozpakuj archiwum `ECUMaster_v1.3_BLE_SPP_update_only.zip`.
2. Na GitHubie otwórz **Code → Add file → Upload files**.
3. Przeciągnij trzy wymienione pliki i zapisz przez **Commit changes** bezpośrednio do gałęzi `main`.
4. Otwórz **Actions → Build Android APK**.
5. Kliknij **Run workflow**, wybierz `main` i ponownie kliknij **Run workflow**.
6. Nie używaj `Re-run` wcześniejszego buildu — zbudowałby stary commit.
7. Po zielonym zakończeniu pobierz najnowszy artefakt **ECUMaster-BLE-RX-Stats-APK**.
8. Rozpakuj ZIP artefaktu i zainstaluj `ECUMaster-BLE-RX-Stats.apk`.

Aplikacja zachowuje ten sam identyfikator Androida, więc nowy APK powinien zaktualizować wcześniejszą wersję. Gdyby Android odmówił aktualizacji, odinstaluj poprzednią aplikację i zainstaluj v1.3 od nowa.

## Pełne repozytorium od zera

1. Prześlij całą zawartość pełnego archiwum projektu do repozytorium, łącznie z ukrytym katalogiem `.github`.
2. Upewnij się, że w głównym katalogu widzisz `App.tsx`, `package.json`, `src` oraz `.github/workflows`.
3. Uruchom workflow zgodnie z instrukcją powyżej.

Workflow wykonuje `npm install`, `expo prebuild --clean --platform android` oraz kompilację wariantu `release` przez Gradle.

## Pierwszy test SPP

1. W ustawieniach Androida sparuj wcześniej moduł Bolutek.
2. Uruchom aplikację i wybierz **SPP/RFCOMM**.
3. Kliknij **Skanuj SPP**.
4. Sparowany moduł powinien pojawić się na początku listy.
5. Kliknij **Połącz SPP z tym urządzeniem**.
6. Pozostaw test na co najmniej 60–120 sekund.
7. Kliknij **Udostępnij raport** i zapisz wynik.

Dla uczciwego porównania BLE i SPP wykonaj oba testy na tym samym telefonie, z tym samym modułem, w podobnym otoczeniu radiowym i przez podobny czas.
