# ECUMaster BT RX Stats v1.5

Minimalna aplikacja diagnostyczna dla Androida służąca do porównania odbioru tego samego strumienia telemetrycznego przez:

- **BLE/GATT** — `react-native-ble-plx`,
- **SPP/RFCOMM (Bluetooth Classic)** — `react-native-bluetooth-classic`.

Aplikacja nie aktualizuje interfejsu dla każdej ramki, nie zapisuje strumienia do pliku i nie wykonuje transmisji zwrotnej podczas testu. Surowe dane są od razu przekazywane do lekkiego licznika i parsera, ekran statystyk odświeża się co 500 ms, a lekki widok wszystkich kanałów co 40 ms (25 Hz).

## Co dodano w v1.3

- wybór transportu **BLE/GATT** albo **SPP/RFCOMM** przed skanowaniem;
- osobne listy urządzeń BLE oraz Bluetooth Classic/DUAL;
- dla SPP najpierw wyświetlane są urządzenia już sparowane, a następnie wynik discovery;
- możliwość sparowania urządzenia SPP z poziomu aplikacji;
- połączenie SPP w trybie binarnym RFCOMM;
- najpierw próba bezpiecznego socketu RFCOMM, potem automatyczny fallback do socketu insecure;
- `READ_SIZE=8192`, `READ_TIMEOUT=0`;
- dekodowanie danych binarnych Base64 przekazanych przez natywny bridge React Native;
- wspólny parser strumieniowy obsługujący ramkę podzieloną między dowolne callbacki SPP;
- osobny opis transportu i parametrów socketu w raporcie.


## Widok kanałów v1.5

- trzy kanały w każdym rzędzie;
- nazwa, przeliczona wartość z jednostką i częstotliwość z ostatnich 5 sekund;
- 72 definicje wygenerowane z dostarczonego `EcumasterDASHPro.ts`;
- poprawna interpretacja 16-bitowych wartości ze znakiem dla kanałów o zakresie ujemnym;
- wszystkie aktywne, niezdefiniowane ID są dopisywane jako `Kanał niezdefiniowany` z wartością RAW;
- parser pracuje event-driven, natomiast React odświeża ekran kanałów z częstotliwością 25 Hz, aby nie wykonywać setState dla każdej z około 675 ramek na sekundę;
- szare pole oznacza kanał jeszcze nieodebrany, żółte — aktywne ID bez definicji, czerwone obramowanie — kanał chwilowo nieaktualny;
- raport tekstowy zawiera dla każdego aktywnego ID nazwę, wartość, RAW, częstotliwość średnią i 5-sekundową, count oraz age.

## BLE/GATT

- skan nie filtruje po nazwie, MAC ani UUID;
- ręczny wybór urządzenia z listy;
- skan w trybie `LowLatency`;
- żądanie `ConnectionPriority.High`;
- żądanie MTU 247 i prezentacja wartości zwróconej przez bibliotekę;
- preferowana usługa FFE0 oraz charakterystyka notify FFE1, z fallbackiem do pierwszej charakterystyki notify/indicate;
- brak zapisów do urządzenia.

## SPP/RFCOMM

Najwygodniej sparować moduł wcześniej w ustawieniach Bluetooth Androida. Po wybraniu **SPP/RFCOMM** i kliknięciu **Skanuj SPP** urządzenia sparowane powinny pojawić się od razu na górze listy. Pełne discovery urządzeń niesparowanych może trwać kilkanaście sekund.

Dla SPP jeden callback nie jest pakietem protokołu. Może zawierać część ramki, jedną ramkę albo wiele ramek. Dlatego licznik:

```text
chunk len % 5 != 0
```

może być większy od zera i sam w sobie nie oznacza błędu. Parser zachowuje końcówkę callbacku i łączy ją z kolejnymi danymi. Istotne są przede wszystkim:

- `checksum errors`,
- `resync dropped bytes`,
- końcowe `carry bytes`,
- częstotliwości RPM/IAT/CLT,
- B/s oraz frames/s,
- rozkład przerw pomiędzy callbackami.

## Statystyki wspólne dla BLE i SPP

- liczba callbacków, bajtów i poprawnych ramek;
- średnia oraz chwilowa szybkość odbioru;
- histogram rozmiarów callbacków/chunków;
- czasy przerw p50/p95/p99/max;
- checksum i resynchronizacja parsera;
- RPM, IAT i CLT;
- liczba wystąpień każdego ID 0–255;
- czas wykonania callbacku oraz opóźnienie pętli JavaScript;
- raport tekstowy przez systemową funkcję „Udostępnij”.

Dla dotychczasowego źródła danych wartości nominalne wynoszą około 25 Hz dla RPM oraz 6,25 Hz dla IAT i CLT. Pole `rate vs nominal` nie jest prawdziwym licznikiem utraconych pakietów — bez licznika sekwencji pokazuje wyłącznie relację częstotliwości odebranej do zadanej.

## Budowanie APK

Repozytorium zawiera workflow:

```text
.github/workflows/android-apk.yml
```

Po zmianie plików uruchom **nowe** wykonanie przez:

```text
Actions → Build Android APK → Run workflow → main → Run workflow
```

Nie używaj `Re-run` starego wykonania, ponieważ GitHub zbuduje wtedy poprzedni commit.
