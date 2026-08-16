// Generated from EcumasterDASHPro.ts supplied for this project.
// Keep this file in sync when the channel table changes.

export interface ChannelDefinition {
  readonly id: number;
  readonly name: string;
  readonly divider: number;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly decimalPoint: number;
  readonly groupName: string;
}

export const READABLE_CHANNELS: Readonly<Partial<Record<number, ChannelDefinition>>> = {
  1: { id: 1, name: "RPM", divider: 1, unit: "rpm", min: 0, max: 8000, decimalPoint: 0, groupName: "Engine" },
  2: { id: 2, name: "MAP", divider: 1, unit: "kPa", min: 0, max: 500, decimalPoint: 0, groupName: "Pressure" },
  3: { id: 3, name: "TPS", divider: 2, unit: "%", min: 0, max: 100, decimalPoint: 0, groupName: "Engine" },
  4: { id: 4, name: "IAT", divider: 1, unit: "°C", min: -40, max: 120, decimalPoint: 0, groupName: "Temperature" },
  5: { id: 5, name: "Battery voltage", divider: 37, unit: "V", min: 8.0, max: 20.0, decimalPoint: 1, groupName: "Engine" },
  6: { id: 6, name: "Ignition Angle", divider: 2, unit: "°BTDC", min: -20, max: 60, decimalPoint: 0, groupName: "Ignition" },
  7: { id: 7, name: "Injectors PW", divider: 62, unit: "ms", min: 0.0, max: 25.0, decimalPoint: 2, groupName: "Fueling" },
  8: { id: 8, name: "EGT 1", divider: 1, unit: "°C", min: 300, max: 1100, decimalPoint: 0, groupName: "Temperature" },
  9: { id: 9, name: "EGT 2", divider: 1, unit: "°C", min: 300, max: 1100, decimalPoint: 0, groupName: "Temperature" },
  10: { id: 10, name: "Knock Level Peak", divider: 51, unit: "V", min: 0.0, max: 5.0, decimalPoint: 2, groupName: "Knock" },
  11: { id: 11, name: "Dwell Time", divider: 20, unit: "ms", min: 0.0, max: 10.0, decimalPoint: 1, groupName: "Ignition" },
  12: { id: 12, name: "AFR", divider: 10, unit: "AFR", min: 10.0, max: 20.0, decimalPoint: 1, groupName: "Fueling" },
  13: { id: 13, name: "Gear", divider: 1, unit: "", min: -1, max: 7, decimalPoint: 0, groupName: "VSS and gears" },
  14: { id: 14, name: "Baro", divider: 1, unit: "kPa", min: 50, max: 120, decimalPoint: 0, groupName: "Pressure" },
  15: { id: 15, name: "Analog 1", divider: 51, unit: "V", min: 0.0, max: 5.0, decimalPoint: 2, groupName: "Analog inputs" },
  16: { id: 16, name: "Analog 2", divider: 51, unit: "V", min: 0.0, max: 5.0, decimalPoint: 2, groupName: "Analog inputs" },
  17: { id: 17, name: "Analog 3", divider: 51, unit: "V", min: 0.0, max: 5.0, decimalPoint: 2, groupName: "Analog inputs" },
  18: { id: 18, name: "Analog 4", divider: 51, unit: "V", min: 0.0, max: 5.0, decimalPoint: 2, groupName: "Analog inputs" },
  19: { id: 19, name: "Injectors DC", divider: 2, unit: "%", min: 0, max: 100, decimalPoint: 0, groupName: "Fueling" },
  20: { id: 20, name: "ECU Temperature", divider: 1, unit: "°C", min: -40, max: 120, decimalPoint: 0, groupName: "Temperature" },
  21: { id: 21, name: "Engine oil pressure", divider: 16, unit: "bar", min: 0.0, max: 12.0, decimalPoint: 1, groupName: "Pressure" },
  22: { id: 22, name: "Engine oil temperature", divider: 1, unit: "°C", min: 0, max: 150, decimalPoint: 0, groupName: "Temperature" },
  23: { id: 23, name: "Fuel pressure", divider: 16, unit: "bar", min: 0.0, max: 16.0, decimalPoint: 1, groupName: "Pressure" },
  24: { id: 24, name: "CLT", divider: 1, unit: "°C", min: 0, max: 150, decimalPoint: 0, groupName: "Temperature" },
  25: { id: 25, name: "Ethanol content", divider: 2, unit: "%", min: 0, max: 100, decimalPoint: 0, groupName: "Fueling" },
  26: { id: 26, name: "Fuel Temperature", divider: 1, unit: "°C", min: -30, max: 120, decimalPoint: 0, groupName: "Temperature" },
  27: { id: 27, name: "Lambda 1", divider: 128, unit: "λ", min: 0.5, max: 2.0, decimalPoint: 2, groupName: "Fueling" },
  28: { id: 28, name: "Vehicle Speed", divider: 4, unit: "km/h", min: 0, max: 250, decimalPoint: 0, groupName: "VSS and gears" },
  29: { id: 29, name: "Fuel pressure error", divider: 1, unit: "kPa", min: -300, max: 300, decimalPoint: 0, groupName: "Pressure" },
  30: { id: 30, name: "Fuel level", divider: 1, unit: "%", min: 0, max: 100, decimalPoint: 0, groupName: "Other" },
  31: { id: 31, name: "Tables set", divider: 1, unit: "", min: 0, max: 1, decimalPoint: 0, groupName: "Other" },
  32: { id: 32, name: "Lambda target", divider: 100, unit: "λ", min: 0.5, max: 2.0, decimalPoint: 2, groupName: "Fueling" },
  33: { id: 33, name: "Secondary inj. PW", divider: 62, unit: "ms", min: 0.0, max: 25.0, decimalPoint: 2, groupName: "Fueling" },
  34: { id: 34, name: "Analog 5", divider: 51, unit: "V", min: 0.0, max: 5.0, decimalPoint: 2, groupName: "Analog inputs" },
  35: { id: 35, name: "Analog 6", divider: 51, unit: "V", min: 0.0, max: 5.0, decimalPoint: 2, groupName: "Analog inputs" },
  36: { id: 36, name: "Boost", divider: 1, unit: "kPa g", min: 0, max: 400, decimalPoint: 0, groupName: "Boost" },
  37: { id: 37, name: "Boost Target", divider: 1, unit: "kPa g", min: 0, max: 400, decimalPoint: 0, groupName: "Boost" },
  38: { id: 38, name: "Knock count", divider: 1, unit: "", min: 0, max: 65535, decimalPoint: 0, groupName: "Knock" },
  39: { id: 39, name: "Trigger error count", divider: 1, unit: "%", min: 0, max: 100, decimalPoint: 0, groupName: "Ignition" },
  41: { id: 41, name: "Boost DC", divider: 2, unit: "%", min: 0, max: 100, decimalPoint: 0, groupName: "Boost" },
  42: { id: 42, name: "Boost PID correction", divider: 1, unit: "%", min: -100, max: 100, decimalPoint: 0, groupName: "Boost" },
  43: { id: 43, name: "CAM sync trigger tooth", divider: 1, unit: "", min: 0, max: 120, decimalPoint: 0, groupName: "Ignition" },
  45: { id: 45, name: "ECU FW ver.", divider: 1, unit: "", min: 0, max: 32, decimalPoint: 0, groupName: "Other" },
  46: { id: 46, name: "Idle ignition correction", divider: 2, unit: "deg", min: -20, max: 20, decimalPoint: 0, groupName: "Idle" },
  47: { id: 47, name: "Idle PID air % correction", divider: 16, unit: "", min: -100.0, max: 100.0, decimalPoint: 1, groupName: "Idle" },
  49: { id: 49, name: "Knock ign. retard", divider: 8, unit: "deg", min: 0, max: 30, decimalPoint: 0, groupName: "Knock" },
  50: { id: 50, name: "VE", divider: 10, unit: "%", min: 0.0, max: 200.0, decimalPoint: 1, groupName: "Fueling" },
  58: { id: 58, name: "Lambda 2", divider: 1024, unit: "λ", min: 0.5, max: 2.0, decimalPoint: 2, groupName: "Fueling" },
  59: { id: 59, name: "Lambda error mult.", divider: 2, unit: "%", min: -50, max: 50, decimalPoint: 0, groupName: "Fueling" },
  61: { id: 61, name: "Nitrous pressure", divider: 1, unit: "bar", min: 0, max: 200, decimalPoint: 0, groupName: "Pressure" },
  63: { id: 63, name: "PPS", divider: 10, unit: "%", min: 0, max: 100, decimalPoint: 0, groupName: "Engine" },
  64: { id: 64, name: "Short term trim", divider: 16, unit: "%", min: -25.0, max: 25.0, decimalPoint: 1, groupName: "Fueling" },
  66: { id: 66, name: "Turboshaft speed", divider: 100, unit: "kRPM", min: 0.0, max: 320.0, decimalPoint: 2, groupName: "Boost" },
  67: { id: 67, name: "VVT CAM1 angle", divider: 2, unit: "deg", min: -50, max: 50, decimalPoint: 0, groupName: "VVTi" },
  68: { id: 68, name: "VVT CAM2 angle", divider: 2, unit: "deg", min: -50, max: 50, decimalPoint: 0, groupName: "VVTi" },
  69: { id: 69, name: "Idle target", divider: 1, unit: "rpm", min: 0, max: 16000, decimalPoint: 0, groupName: "Idle" },
  70: { id: 70, name: "Wasted spark", divider: 1, unit: "", min: 0, max: 1, decimalPoint: 0, groupName: "Ignition" },
  71: { id: 71, name: "Engine torque %", divider: 1, unit: "%", min: -100, max: 100, decimalPoint: 0, groupName: "Engine" },
  73: { id: 73, name: "Fuel cut percent", divider: 1, unit: "%", min: 0, max: 100, decimalPoint: 0, groupName: "Fueling" },
  74: { id: 74, name: "Spark cut percent", divider: 1, unit: "%", min: 0, max: 100, decimalPoint: 0, groupName: "Ignition" },
  76: { id: 76, name: "Rev. limiter target", divider: 1, unit: "RPM", min: 2000, max: 15000, decimalPoint: 0, groupName: "Engine" },
  77: { id: 77, name: "Pre throttle boost pressure", divider: 1, unit: "kPa g", min: 0, max: 600, decimalPoint: 0, groupName: "Boost" },
  78: { id: 78, name: "Wastegate dome pressure", divider: 1, unit: "kPa g", min: 0, max: 1200, decimalPoint: 0, groupName: "Boost" },
  79: { id: 79, name: "EWG position", divider: 2, unit: "%", min: 0, max: 100, decimalPoint: 0, groupName: "Boost" },
  80: { id: 80, name: "Differential oil temperature", divider: 1, unit: "°C", min: -40, max: 160, decimalPoint: 0, groupName: "Temperature" },
  82: { id: 82, name: "Coolant pressure", divider: 1, unit: "kPa", min: 0, max: 300, decimalPoint: 0, groupName: "Pressure" },
  83: { id: 83, name: "AC Pressure", divider: 1, unit: "kPa", min: 0, max: 5000, decimalPoint: 0, groupName: "Pressure" },
  84: { id: 84, name: "Nitrous active", divider: 1, unit: "", min: 0, max: 1, decimalPoint: 0, groupName: "Other" },
  99: { id: 99, name: "Round trip time", divider: 128, unit: "ms", min: 1.0, max: 200.0, decimalPoint: 2, groupName: "Statistic" },
  100: { id: 100, name: "BLE signal strength", divider: 1, unit: "dBm", min: -110, max: 0, decimalPoint: 0, groupName: "Statistic" },
  250: { id: 250, name: "EDL FW ver.", divider: 100, unit: "", min: 1.0, max: 200.0, decimalPoint: 2, groupName: "Other" },
  252: { id: 252, name: "BT Rotary 5-8", divider: 1, unit: "RAW", min: 0, max: 65535, decimalPoint: 0, groupName: "Bluetooth controls" },
  253: { id: 253, name: "BT Rotary 1-4", divider: 1, unit: "RAW", min: 0, max: 65535, decimalPoint: 0, groupName: "Bluetooth controls" },
  254: { id: 254, name: "BT Switches", divider: 1, unit: "RAW", min: 0, max: 255, decimalPoint: 0, groupName: "Bluetooth controls" },
  255: { id: 255, name: "Check engine code", divider: 1, unit: "", min: 0, max: 65535, decimalPoint: 0, groupName: "Engine" },
} as const;

export const READABLE_CHANNEL_LIST: readonly ChannelDefinition[] = Object.values(
  READABLE_CHANNELS,
).filter((value): value is ChannelDefinition => value !== undefined)
  .sort((a, b) => a.id - b.id);

export function decodeChannelRaw(
  definition: ChannelDefinition,
  rawUnsigned: number,
): number {
  let raw = rawUnsigned & 0xffff;
  if (definition.min < 0 && raw >= 0x8000) {
    raw -= 0x10000;
  }
  return raw / definition.divider;
}

export function formatChannelValue(
  definition: ChannelDefinition,
  rawUnsigned: number | null,
): string {
  if (rawUnsigned === null) return '—';
  const value = decodeChannelRaw(definition, rawUnsigned);
  const factor = 10 ** definition.decimalPoint;
  const truncatedValue = Math.trunc(value * factor) / factor;
  const valueText = truncatedValue.toFixed(definition.decimalPoint);
  return definition.unit.length > 0 ? `${valueText} ${definition.unit}` : valueText;
}
