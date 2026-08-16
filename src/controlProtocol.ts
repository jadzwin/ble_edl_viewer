export const CONTROL_CHANNEL_IDS = {
  roundTrip: 99,
  rotary5678: 252,
  rotary1234: 253,
  switches: 254,
} as const;

export const CONTROL_FRAME_LENGTH = 8;
export const SWITCH_STATUS_MAGIC = 0x55;
export const LATENCY_REPLY_MAGIC = 0x56;
export const LATENCY_REPLY_SIGNED_VALUE = -49;

export type RotaryValues = [number, number, number, number, number, number, number, number];

export interface ControlSyncSnapshot {
  switchesMask: number;
  rotaryValues: RotaryValues;
  seenSwitches: boolean;
  seenRotary1234: boolean;
  seenRotary5678: boolean;
  initialized: boolean;
}

export interface ControlIngestResult {
  stateChanged: boolean;
  justInitialized: boolean;
  shouldSendSwitchFrame: boolean;
}

function emptyRotaries(): RotaryValues {
  return [0, 0, 0, 0, 0, 0, 0, 0];
}

function clampNibble(value: number): number {
  return value & 0x0f;
}

function splitRotaryWord(rawUnsigned: number): [number, number, number, number] {
  const raw = rawUnsigned & 0xffff;
  return [
    (raw >>> 12) & 0x0f,
    (raw >>> 8) & 0x0f,
    (raw >>> 4) & 0x0f,
    raw & 0x0f,
  ];
}

function packRotaryPair(first: number, second: number): number {
  return (clampNibble(first) << 4) | clampNibble(second);
}

export function checksum8(bytes: Uint8Array, bytesToSum = bytes.length - 1): number {
  let checksum = 0;
  const count = Math.max(0, Math.min(bytesToSum, bytes.length));
  for (let index = 0; index < count; index += 1) {
    checksum = (checksum + (bytes[index] ?? 0)) & 0xff;
  }
  return checksum;
}

export function buildSwitchStatusFrame(
  switchesMask: number,
  rotaryValues: readonly number[],
): Uint8Array {
  if (rotaryValues.length !== 8) {
    throw new Error(`Expected 8 rotary values, got ${rotaryValues.length}.`);
  }

  const frame = new Uint8Array(CONTROL_FRAME_LENGTH);
  frame[0] = CONTROL_FRAME_LENGTH;
  frame[1] = SWITCH_STATUS_MAGIC;
  frame[2] = switchesMask & 0xff;
  frame[3] = packRotaryPair(rotaryValues[0] ?? 0, rotaryValues[1] ?? 0);
  frame[4] = packRotaryPair(rotaryValues[2] ?? 0, rotaryValues[3] ?? 0);
  frame[5] = packRotaryPair(rotaryValues[4] ?? 0, rotaryValues[5] ?? 0);
  frame[6] = packRotaryPair(rotaryValues[6] ?? 0, rotaryValues[7] ?? 0);
  frame[7] = checksum8(frame, 7);
  return frame;
}

export function buildLatencyReplyFrame(
  signedValue = LATENCY_REPLY_SIGNED_VALUE,
): Uint8Array {
  const frame = new Uint8Array(CONTROL_FRAME_LENGTH);
  frame[0] = CONTROL_FRAME_LENGTH;
  frame[1] = LATENCY_REPLY_MAGIC;
  frame[2] = signedValue & 0xff;
  frame[3] = 0;
  frame[4] = 0;
  frame[5] = 0;
  frame[6] = 0;
  frame[7] = checksum8(frame, 7);
  return frame;
}

export function frameToHex(frame: Uint8Array): string {
  return Array.from(frame, (value) => value.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export class ControlStateSynchronizer {
  private switchesMask = 0;
  private rotaryValues: RotaryValues = emptyRotaries();
  private seenSwitches = false;
  private seenRotary1234 = false;
  private seenRotary5678 = false;
  private initialized = false;

  reset(): ControlSyncSnapshot {
    this.switchesMask = 0;
    this.rotaryValues = emptyRotaries();
    this.seenSwitches = false;
    this.seenRotary1234 = false;
    this.seenRotary5678 = false;
    this.initialized = false;
    return this.snapshot();
  }

  snapshot(): ControlSyncSnapshot {
    return {
      switchesMask: this.switchesMask,
      rotaryValues: [...this.rotaryValues] as RotaryValues,
      seenSwitches: this.seenSwitches,
      seenRotary1234: this.seenRotary1234,
      seenRotary5678: this.seenRotary5678,
      initialized: this.initialized,
    };
  }

  ingestChannel(id: number, rawUnsigned: number): ControlIngestResult {
    const wasInitialized = this.initialized;
    let stateChanged = false;

    // Kanały 252–254 inicjalizują lokalny stan tylko raz po połączeniu.
    // Po inicjalizacji każde kolejne ID 254 jest traktowane jako poll TX.
    if (!wasInitialized) {
      if (id === CONTROL_CHANNEL_IDS.switches) {
        this.switchesMask = rawUnsigned & 0xff;
        this.seenSwitches = true;
        stateChanged = true;
      } else if (id === CONTROL_CHANNEL_IDS.rotary1234) {
        const values = splitRotaryWord(rawUnsigned);
        this.rotaryValues[0] = values[0];
        this.rotaryValues[1] = values[1];
        this.rotaryValues[2] = values[2];
        this.rotaryValues[3] = values[3];
        this.seenRotary1234 = true;
        stateChanged = true;
      } else if (id === CONTROL_CHANNEL_IDS.rotary5678) {
        const values = splitRotaryWord(rawUnsigned);
        this.rotaryValues[4] = values[0];
        this.rotaryValues[5] = values[1];
        this.rotaryValues[6] = values[2];
        this.rotaryValues[7] = values[3];
        this.seenRotary5678 = true;
        stateChanged = true;
      }

      if (this.seenSwitches && this.seenRotary1234 && this.seenRotary5678) {
        this.initialized = true;
        stateChanged = true;
      }
    }

    return {
      stateChanged,
      justInitialized: !wasInitialized && this.initialized,
      // ID 254, które dopiero domyka inicjalizację, nie wyzwala jeszcze odpowiedzi.
      shouldSendSwitchFrame: wasInitialized && id === CONTROL_CHANNEL_IDS.switches,
    };
  }

  toggleSwitch(index: number): ControlSyncSnapshot {
    if (index < 0 || index >= 8) {
      throw new Error(`Switch index out of range: ${index}`);
    }
    this.switchesMask ^= 1 << index;
    this.switchesMask &= 0xff;
    return this.snapshot();
  }

  incrementRotary(index: number): ControlSyncSnapshot {
    if (index < 0 || index >= 8) {
      throw new Error(`Rotary index out of range: ${index}`);
    }
    this.rotaryValues[index] = ((this.rotaryValues[index] ?? 0) + 1) & 0x0f;
    return this.snapshot();
  }

  buildSwitchFrame(): Uint8Array {
    return buildSwitchStatusFrame(this.switchesMask, this.rotaryValues);
  }
}
