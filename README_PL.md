# ECUMaster BT RX/TX Stats v1.6

Aplikacja diagnostyczna dla Androida do testowania tego samego strumienia telemetrycznego przez:

- **BLE/GATT** — `react-native-ble-plx`,
- **SPP/RFCOMM (Bluetooth Classic)** — `react-native-bluetooth-classic`.

Parser pracuje natychmiast dla każdego callbacku, ekran kanałów odświeża się co 40 ms (25 Hz), a widok statystyk co 500 ms. Aplikacja nie loguje ani nie zapisuje do pliku każdej odebranej ramki.

## Nowość w v1.6 — switche, rotary i RTT

Dodano zakładkę **Sterowanie** z:

- 8 przełącznikami On/Off, kodowanymi w jednym bajcie `switches`;
- 8 wartościami rotary 0–15, po 4 bity każda;
- zwiększaniem rotary o 1 po naciśnięciu i zawijaniem `15 → 0`;
- statystykami transmisji zwrotnej;
- automatyczną odpowiedzią na kanał 99 do pomiaru round-trip time.

Po każdym nowym połączeniu aplikacja czeka na jednorazowe odebranie:

- ID 254 — najniższe 8 bitów inicjalizuje switche 1–8;
- ID 253 — cztery nibble inicjalizują rotary 1–4;
- ID 252 — cztery nibble inicjalizują rotary 5–8.

Dopiero po odebraniu wszystkich trzech kanałów sterowanie staje się aktywne. Ramka ID 254, która ewentualnie kończy inicjalizację, nie wyzwala odpowiedzi. Każde **kolejne** ID 254 powoduje wysłanie aktualnego stanu:

```text
byte 0: 8
byte 1: 0x55
byte 2: switches 1–8
byte 3: rotary 1 w high nibble, rotary 2 w low nibble
byte 4: rotary 3 / rotary 4
byte 5: rotary 5 / rotary 6
byte 6: rotary 7 / rotary 8
byte 7: suma bajtów 0–6 modulo 256
```

Naciśnięcie kontrolki zmienia stan lokalny. Nowa wartość jest wysyłana przy następnym odebraniu kanału 254.

Po każdym poprawnym odebraniu kanału **99** aplikacja kolejkuje z najwyższym priorytetem ramkę:

```text
08 56 CF 00 00 00 00 2D
```

`0xCF` to zapis `-49` w `uint8_t`. Ramki RTT mają pierwszeństwo przed oczekującymi ramkami statusu switchy. Wszystkie zapisy są serializowane, aby nie wykonywać równoległych operacji GATT/RFCOMM.

Mechanizm TX działa dla aktualnie połączonego transportu:

- BLE: preferowana charakterystyka FFE2; fallback do zapisywalnej charakterystyki w usłudze RX, a następnie do dowolnej zapisywalnej charakterystyki;
- SPP: zapis binarny do aktywnego socketu RFCOMM.

## Widoki

- **Połączenie** — wybór BLE/SPP, skanowanie i łączenie;
- **Kanały** — trzy kanały w rzędzie, wartość, jednostka i częstotliwość z ostatnich 5 s;
- **Sterowanie** — 8 switchy, 8 rotary i statystyki TX/RTT;
- **Statystyki** — przepływność, integralność parsera, częstotliwości, obciążenie JS i TX.

## Budowanie APK

Po przesłaniu plików do repozytorium uruchom nowe wykonanie:

```text
Actions → Build Android APK → Run workflow → main → Run workflow
```

Nie wybieraj `Re-run` poprzedniego wykonania, ponieważ GitHub zbuduje wtedy wcześniejszy commit.
