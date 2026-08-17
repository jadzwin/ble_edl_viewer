# AGENTS.md — ble_edl_viewer

## Purpose

This repository contains an Android React Native / Expo diagnostic application for ECUMaster telemetry over:

- BLE / GATT
- Bluetooth Classic SPP / RFCOMM

The application is used to measure transport performance, parse ECUMaster telemetry channels, display live values, expose transport/parser statistics, and test bidirectional control/latency behavior.

Before changing code, inspect the current implementation, especially:

- `App.tsx`
- `src/BleStatsCollector.ts`
- `src/channels.ts`
- `src/controlProtocol.ts`
- `src/config.ts`
- `src/time.ts`
- `package.json`
- `app.json`
- `.github/workflows/android-apk.yml`

Treat the current code and the protocol rules below as the source of truth. If a user request conflicts with this file, the newest explicit user instruction wins.

---

## General engineering rules

1. Prefer small, focused changes over rewrites.
2. Do not change transport behavior, parser behavior, channel scaling, packet formats, or timing semantics unless explicitly requested.
3. Preserve BLE and SPP support.
4. Keep hot RX/TX paths lightweight.
5. Do not add per-frame React `setState`, file I/O, heavy logging, or other expensive work in the receive callback.
6. UI rendering may be throttled, but protocol parsing and response generation must happen immediately when data arrives.
7. Preserve parser state across arbitrary transport chunk boundaries.
8. SPP is a byte stream. Never assume one callback equals one logical packet.
9. BLE notification boundaries must also not be relied upon by the 5-byte telemetry parser.
10. Do not add dependencies unless they are genuinely required.
11. Keep user-facing text in Polish unless explicitly asked otherwise.
12. Do not bump application version/versionCode unless requested.
13. Do not commit or push changes unless explicitly requested. Modify the working tree, run checks, and show a concise summary/diff first.

---

## Telemetry frame format

Each telemetry channel record is exactly 5 bytes:

```text
byte 0: channel ID
byte 1: magic = 0xA3 (163)
byte 2: data high byte
byte 3: data low byte
byte 4: checksum
```

Raw 16-bit channel data is big-endian:

```text
raw = (data_high << 8) | data_low
```

Checksum:

```text
checksum = (channel_id + 0xA3 + data_high + data_low) & 0xFF
```

The parser must:

- retain incomplete trailing bytes between callbacks,
- resynchronize only when necessary,
- count checksum errors and resynchronization drops,
- not silently duplicate or reprocess previously consumed bytes.

The application currently works with many channel IDs defined in `src/channels.ts`. That file is the source of truth for channel names, dividers, units, signed handling, decimal precision, and display scaling.

---

## Expected transport characteristics

Nominal complete stream:

```text
3375 bytes/s
675 telemetry frames/s
```

Important control/diagnostic channel rates used in testing include:

```text
RPM ID 1: 25 Hz nominal
IAT ID 4: 6.25 Hz nominal
CLT ID 24: 6.25 Hz nominal
```

Do not interpret `rate vs nominal` as a true packet-loss percentage unless the protocol has an explicit sequence counter.

Performance statistics should distinguish transport callbacks/chunks from parsed 5-byte channel frames.

---

## UI refresh and performance

The receive/parser path must process data immediately.

The visible channel dashboard may refresh at approximately:

```text
25 Hz / every 40 ms
```

This is intentional. Do not update React UI separately for every telemetry frame, because the stream may contain roughly 675 frames/s.

Prefer:

```text
RX callback -> decode bytes -> parse -> update lightweight mutable statistics/state
                                      |
                                      -> UI snapshots at controlled rate
```

For latency-response channel ID 99, do not wait for the next UI refresh.

---

# Bidirectional control protocol

The app supports:

- 8 binary switches
- 8 rotary/button values, each 4-bit and ranging from 0 to 15
- periodic switch-state replies
- round-trip-time replies

Relevant telemetry channels:

```text
ID 254 = 8 binary switch states
ID 253 = rotary 1..4 packed into 16 bits
ID 252 = rotary 5..8 packed into 16 bits
ID 99  = RTT / latency request channel
```

---

## Rotary packing

ID 253 contains rotary 1..4:

```text
bits 15..12 = Rotary 1
bits 11..8  = Rotary 2
bits 7..4   = Rotary 3
bits 3..0   = Rotary 4
```

ID 252 contains rotary 5..8 in the same format:

```text
bits 15..12 = Rotary 5
bits 11..8  = Rotary 6
bits 7..4   = Rotary 7
bits 3..0   = Rotary 8
```

When the user presses a rotary control in the Android UI:

```text
value = (value + 1) & 0x0F
```

So:

```text
14 -> 15
15 -> 0
```

Do not reverse rotary order or nibble order unless explicitly requested.

---

## Binary switch bit order — IMPORTANT

Human/UI numbering and wire bit order are intentionally opposite.

Required protocol mapping:

```text
Switch 1 -> bit 7 -> 0x80
Switch 2 -> bit 6 -> 0x40
Switch 3 -> bit 5 -> 0x20
Switch 4 -> bit 4 -> 0x10
Switch 5 -> bit 3 -> 0x08
Switch 6 -> bit 2 -> 0x04
Switch 7 -> bit 1 -> 0x02
Switch 8 -> bit 0 -> 0x01
```

Inside the application, keep UI state intuitive if possible:

```text
logical Switch 1 = index 0
logical Switch 2 = index 1
...
logical Switch 8 = index 7
```

Perform bit reversal only at the protocol boundary:

1. when initializing local switch state from received channel ID 254,
2. when writing the switch mask into outgoing `magic=0x55` control frames.

Do not scatter reversed indexing throughout the UI.

A good conceptual model is:

```text
wire ID254 mask -> reverse 8 bits -> logical UI mask
logical UI mask -> reverse 8 bits -> outgoing wire mask
```

---

## Control state initialization

After each new connection:

1. reset local control synchronization state,
2. wait until valid values have been received for all three channels:
   - ID 254
   - ID 253
   - ID 252
3. initialize the 8 switches and 8 rotary values from those received channels,
4. only then enable interactive controls.

The first ID 254 that completes initial synchronization must NOT trigger an outgoing switch-status frame.

After initialization, every subsequently received ID 254 acts as a poll and must cause the app to send the current complete control state.

Changing a UI switch or rotary value updates local state immediately but does not itself send the `0x55` frame. Transmission occurs on the next post-initialization ID 254 poll unless a newer explicit user requirement says otherwise.

---

## Outgoing switch-state frame (`magic = 0x55`)

C-compatible structure:

```c
typedef struct
{
    uint8_t len;
    uint8_t magic;
    uint8_t switches;

    uint8_t rotary_1_2;
    uint8_t rotary_3_4;
    uint8_t rotary_5_6;
    uint8_t rotary_7_8;
    uint8_t checksum;
} eBTSwitchesStruct;
```

Exactly 8 bytes:

```text
byte 0: len = 8
byte 1: magic = 0x55
byte 2: switches wire mask
byte 3: (rotary1 << 4) | rotary2
byte 4: (rotary3 << 4) | rotary4
byte 5: (rotary5 << 4) | rotary6
byte 6: (rotary7 << 4) | rotary8
byte 7: checksum
```

Checksum:

```text
checksum =
    (byte0 + byte1 + byte2 + byte3 + byte4 + byte5 + byte6) & 0xFF
```

Always send exactly 8 bytes.

---

## RTT / latency reply (`magic = 0x56`)

When a valid telemetry frame with channel ID 99 is parsed, reply as quickly as possible.

Do NOT wait for:

- UI refresh,
- the next ID 254,
- the next periodic timer.

Required response:

```text
byte 0: 8
byte 1: 0x56
byte 2: -49 represented as uint8_t = 0xCF
byte 3: 0x00
byte 4: 0x00
byte 5: 0x00
byte 6: 0x00
byte 7: checksum
```

Canonical byte sequence:

```text
08 56 CF 00 00 00 00 2D
```

RTT replies are higher priority than switch-status (`0x55`) frames.

TX operations must remain serialized so that BLE writes or RFCOMM writes do not overlap unsafely. An RTT reply may not interrupt a native write already in progress, but it should be the next queued TX item.

Channel 99 itself contains measured round-trip time and uses divider 128, with resulting value expressed in milliseconds according to the channel definition.

---

# BLE behavior

BLE uses `react-native-ble-plx`.

Preserve the current connection sequence unless specifically asked to change it:

- scan,
- user-selected device,
- connect with `autoConnect=false`,
- request high connection priority,
- request MTU,
- discover services/characteristics,
- subscribe to RX notifications,
- identify a writable TX characteristic,
- receive continuously.

For TX, preserve the existing characteristic selection logic in current code. The implementation currently prefers the intended ECUMaster/Bolutek writable characteristic where available and falls back only when necessary.

Prefer write-without-response where the current characteristic supports it and the code already selects it; otherwise use write-with-response.

Do not introduce extra BLE traffic into performance tests without an explicit reason.

---

# SPP / Bluetooth Classic behavior

SPP uses `react-native-bluetooth-classic`.

For performance tests, use an already paired/bonded device rather than running Classic discovery while receiving.

Treat SPP as a continuous byte stream.

Native read callbacks may contain:

- part of one 5-byte telemetry frame,
- exactly one frame,
- multiple frames,
- multiple frames plus a partial next frame.

This is normal.

Do not use callback length modulo 5 as an error criterion for SPP.

Preserve transport decoding and Base64/binary handling used by the current implementation unless there is evidence it is incorrect.

---

# Statistics

Maintain separate statistics for transport and parser behavior.

Useful transport statistics include:

- callback / notification count
- callbacks/s
- bytes received
- bytes/s
- callback/chunk length histogram
- callback gap median / p95 / p99 / max

Useful parser statistics include:

- valid frames
- valid frames/s
- checksum errors
- resynchronization dropped bytes
- carry bytes
- active channel IDs
- per-ID counts/rates
- consecutive duplicate chunks where relevant

Useful TX/control statistics include:

- ID 254 polls received
- switch-status frames queued/sent
- ID 99 requests received
- RTT replies queued/sent
- TX errors
- queue depth
- last TX frame
- write duration
- queue delay

Avoid metrics whose name implies real packet loss unless the protocol actually provides enough information to determine it.

---

# Important files and responsibilities

## `App.tsx`

Main application orchestration and UI:

- BLE and SPP connection logic
- scan/device selection
- transport RX callbacks
- TX queue
- control UI
- channels/statistics views
- report generation

Avoid making this file even larger unless the requested change is genuinely small. For significant new protocol/business logic, prefer extracting a focused module under `src/`.

## `src/BleStatsCollector.ts`

Telemetry parsing and runtime statistics.

Changes here can affect measured transport performance. Be especially conservative.

## `src/channels.ts`

Channel metadata and value formatting.

Do not invent channel scaling. Preserve definitions from the project's TypeScript channel data.

## `src/controlProtocol.ts`

Bidirectional control protocol:

- IDs 252/253/254/99
- switch state
- rotary state
- switch status frame
- RTT reply frame
- synchronization rules

Protocol-specific bit/nibble packing belongs here rather than in rendering code whenever practical.

## `src/config.ts`

BLE-related configuration/defaults.

## `.github/workflows/android-apk.yml`

GitHub Actions release APK build.

Do not break the manual `workflow_dispatch` flow.

---

# Build and validation

`package.json` is the source of truth for exact dependency versions and scripts.

At minimum, after TypeScript changes run:

```bash
npm run typecheck
```

For a full Android release build, when the local environment supports Android SDK/Java:

```bash
npm run build:android:release
```

The GitHub Actions APK workflow performs the equivalent sequence:

```text
npm install
npm run typecheck
expo prebuild --clean --platform android
gradlew assembleRelease
```

Do not claim a native Android build succeeded unless it was actually run successfully.

If only typecheck was run, say exactly that.

---

# Change workflow for Codex

For each requested change:

1. Read this `AGENTS.md`.
2. Inspect the relevant current files before editing.
3. Check the current Git status/diff so existing user changes are not overwritten.
4. Make the smallest coherent change.
5. Preserve unrelated working-tree changes.
6. Run `npm run typecheck`.
7. Run additional targeted checks/tests when appropriate.
8. Explain:
   - which files changed,
   - what behavior changed,
   - what was tested,
   - what was not tested.
9. Show/review the diff before committing when the user requested review first.
10. Commit only when explicitly requested.
11. Push to GitHub only when explicitly requested.

Never use destructive Git operations such as:

```text
git reset --hard
git clean -fd
force push
```

unless the user explicitly asks for that exact operation and understands the consequences.

---

# Current known pending protocol requirement

The switch bit-order correction is important:

```text
Switch 1 = wire bit 7
...
Switch 8 = wire bit 0
```

If the current working tree does not yet implement this correctly, fix it by keeping logical UI indexing natural and reversing the mask only on ID 254 RX and `0x55` TX boundaries.

Rotary nibble ordering is unchanged.

---

# Communication style

When reporting changes:

- be concise and technical,
- identify exact files/functions touched,
- give measured or testable facts,
- distinguish verified results from assumptions,
- do not hide build/test failures,
- do not make unrelated refactors just because they look cleaner.
