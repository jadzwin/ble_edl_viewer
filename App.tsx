import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { fromByteArray, toByteArray } from 'base64-js';
import { useKeepAwake } from 'expo-keep-awake';
import {
  BleError,
  BleManager,
  ConnectionPriority,
  LogLevel,
  ScanMode,
  State,
} from 'react-native-ble-plx';
import type { Characteristic, Device, Subscription } from 'react-native-ble-plx';
import RNBluetoothClassic from 'react-native-bluetooth-classic';

import { BleStatsCollector } from './src/BleStatsCollector';
import type {
  BleStatsSnapshot,
  ChannelLiveSnapshot,
  ChannelStatsSnapshot,
  ControlChannelFrame,
  DistributionSnapshot,
} from './src/BleStatsCollector';
import { BLE_CONFIG } from './src/config';
import { READABLE_CHANNEL_LIST, READABLE_CHANNELS, formatChannelValue } from './src/channels';
import { monotonicNowMs } from './src/time';
import {
  CONTROL_CHANNEL_IDS,
  ControlStateSynchronizer,
  buildLatencyReplyFrame,
  frameToHex,
} from './src/controlProtocol';
import type { ControlSyncSnapshot } from './src/controlProtocol';
import { UiRefreshDiagnostics } from './src/UiRefreshDiagnostics';
import type { UiRefreshDiagnosticsSnapshot } from './src/UiRefreshDiagnostics';

type TransportMode = 'ble' | 'spp';
type MainView = 'connection' | 'channels' | 'controls' | 'statistics';
type ClassicDeviceType = 'CLASSIC' | 'LOW_ENERGY' | 'DUAL' | 'UNKNOWN';
type ClassicRxEncoding = 'unknown' | 'base64' | 'binary-string';
type BleConnectionPriorityName = 'LOW_POWER' | 'BALANCED' | 'HIGH';

const FRAME_RATE_CHART_SECONDS = 60;
const FRAME_RATE_CHART_MAX = 1000;
const FRAME_RATE_CHART_HEIGHT = 180;

type ConnectionState =
  | 'idle'
  | 'waiting-for-bluetooth'
  | 'scanning'
  | 'scan-results'
  | 'pairing'
  | 'connecting'
  | 'discovering'
  | 'subscribing'
  | 'receiving'
  | 'disconnecting'
  | 'disconnected'
  | 'error';

interface RemovableSubscription {
  remove(): void;
}

interface ClassicNativeDeviceLike {
  address?: string;
  id?: string;
  name?: string;
}

interface ClassicReadEventLike {
  data: string;
  device?: ClassicNativeDeviceLike;
}

interface ClassicDeviceEventLike {
  device?: ClassicNativeDeviceLike;
  message?: string;
  error?: unknown;
}

interface ClassicDeviceLike {
  name?: string;
  address?: string;
  id?: string;
  bonded?: boolean | Boolean;
  deviceClass?: string | Record<string, unknown>;
  rssi?: number | Number;
  type?: string;
  extra?: unknown;
  connect(options?: Record<string, unknown>): Promise<boolean>;
  isConnected(): Promise<boolean>;
  disconnect(): Promise<boolean>;
  write(data: string, encoding?: string): Promise<boolean>;
  onDataReceived(listener: (event: ClassicReadEventLike) => void): RemovableSubscription;
}

interface ClassicModuleLike {
  isBluetoothAvailable(): Promise<boolean>;
  isBluetoothEnabled(): Promise<boolean>;
  requestBluetoothEnabled(): Promise<boolean>;
  getBondedDevices(): Promise<ClassicDeviceLike[]>;
  startDiscovery(): Promise<ClassicDeviceLike[]>;
  cancelDiscovery(): Promise<boolean>;
  pairDevice(address: string): Promise<ClassicDeviceLike>;
  onDeviceDisconnected(
    listener: (event: ClassicDeviceEventLike) => void,
  ): RemovableSubscription;
  onError(listener: (event: ClassicDeviceEventLike) => void): RemovableSubscription;
}

const ClassicBluetooth = RNBluetoothClassic as unknown as ClassicModuleLike;

interface BleConnectedInfo {
  transport: 'ble';
  id: string;
  name: string;
  scanRssi: number | null;
  mtu: number;
  serviceUuid: string;
  notifyCharacteristicUuid: string;
  writeServiceUuid: string | null;
  writeCharacteristicUuid: string | null;
  writeMode: 'without-response' | 'with-response' | 'unavailable';
  characteristicSummary: string;
  connectedAtIso: string;
}

interface SppConnectedInfo {
  transport: 'spp';
  id: string;
  address: string;
  name: string;
  bonded: boolean;
  deviceType: ClassicDeviceType;
  scanRssi: number | null;
  secureSocket: boolean;
  readSize: number;
  connectedAtIso: string;
}

type ConnectedInfo = BleConnectedInfo | SppConnectedInfo;

interface BleScanDeviceRow {
  id: string;
  name: string | null;
  localName: string | null;
  rssi: number | null;
  isConnectable: boolean | null;
  serviceUUIDs: string[] | null;
}

interface SppScanDeviceRow {
  id: string;
  address: string;
  name: string;
  bonded: boolean;
  type: ClassicDeviceType;
  rssi: number | null;
}

interface ChannelTileModel {
  id: number;
  name: string;
  valueText: string;
  rateText: string;
  active: boolean;
  stale: boolean;
  unknown: boolean;
}

type TxFrameKind = 'latency-reply' | 'switch-status';
type BleWriteMode = 'without-response' | 'with-response';

interface BleTxTarget {
  deviceId: string;
  serviceUuid: string;
  characteristicUuid: string;
  mode: BleWriteMode;
}

interface TxQueueItem {
  kind: TxFrameKind;
  payload: Uint8Array;
  enqueuedAtMs: number;
  generation: number;
}

interface TxDiagnosticsSnapshot {
  switchPolls: number;
  switchFramesQueued: number;
  switchFramesSent: number;
  latencyRequests: number;
  latencyRepliesQueued: number;
  latencyRepliesSent: number;
  txSuppressedTotal: number;
  latencyRepliesSuppressed: number;
  switchFramesSuppressed: number;
  txErrors: number;
  queueDepth: number;
  lastTxKind: TxFrameKind | null;
  lastTxHex: string;
  lastTxAgoMs: number | null;
  lastWriteDurationMs: number | null;
  lastQueueDelayMs: number | null;
  lastError: string | null;
}

interface TxDiagnosticsMutable {
  switchPolls: number;
  switchFramesQueued: number;
  switchFramesSent: number;
  latencyRequests: number;
  latencyRepliesQueued: number;
  latencyRepliesSent: number;
  txSuppressedTotal: number;
  latencyRepliesSuppressed: number;
  switchFramesSuppressed: number;
  txErrors: number;
  lastTxKind: TxFrameKind | null;
  lastTxHex: string;
  lastTxAtMs: number | null;
  lastWriteDurationMs: number | null;
  lastQueueDelayMs: number | null;
  lastError: string | null;
}

const SPP_READ_SIZE = 8192;

const BLE_CONNECTION_PRIORITIES: ReadonlyArray<{
  name: BleConnectionPriorityName;
  value: ConnectionPriority;
}> = [
  { name: 'LOW_POWER', value: ConnectionPriority.LowPower },
  { name: 'BALANCED', value: ConnectionPriority.Balanced },
  { name: 'HIGH', value: ConnectionPriority.High },
];

function connectionPriorityValue(name: BleConnectionPriorityName): ConnectionPriority {
  return BLE_CONNECTION_PRIORITIES.find((priority) => priority.name === name)?.value
    ?? ConnectionPriority.Balanced;
}

function rpmSnapshotCount(channels: readonly ChannelLiveSnapshot[]): number {
  return channels.find((channel) => channel.id === 1)?.count ?? 0;
}

function emptyTxDiagnosticsMutable(): TxDiagnosticsMutable {
  return {
    switchPolls: 0,
    switchFramesQueued: 0,
    switchFramesSent: 0,
    latencyRequests: 0,
    latencyRepliesQueued: 0,
    latencyRepliesSent: 0,
    txSuppressedTotal: 0,
    latencyRepliesSuppressed: 0,
    switchFramesSuppressed: 0,
    txErrors: 0,
    lastTxKind: null,
    lastTxHex: '',
    lastTxAtMs: null,
    lastWriteDurationMs: null,
    lastQueueDelayMs: null,
    lastError: null,
  };
}

function txDiagnosticsSnapshot(
  value: TxDiagnosticsMutable,
  nowMs: number,
  queueDepth: number,
): TxDiagnosticsSnapshot {
  return {
    switchPolls: value.switchPolls,
    switchFramesQueued: value.switchFramesQueued,
    switchFramesSent: value.switchFramesSent,
    latencyRequests: value.latencyRequests,
    latencyRepliesQueued: value.latencyRepliesQueued,
    latencyRepliesSent: value.latencyRepliesSent,
    txSuppressedTotal: value.txSuppressedTotal,
    latencyRepliesSuppressed: value.latencyRepliesSuppressed,
    switchFramesSuppressed: value.switchFramesSuppressed,
    txErrors: value.txErrors,
    queueDepth,
    lastTxKind: value.lastTxKind,
    lastTxHex: value.lastTxHex,
    lastTxAgoMs:
      value.lastTxAtMs === null ? null : Math.max(0, nowMs - value.lastTxAtMs),
    lastWriteDurationMs: value.lastWriteDurationMs,
    lastQueueDelayMs: value.lastQueueDelayMs,
    lastError: value.lastError,
  };
}

function writableMode(characteristic: Characteristic): BleWriteMode | null {
  if (characteristic.isWritableWithoutResponse) {
    return 'without-response';
  }
  if (characteristic.isWritableWithResponse) {
    return 'with-response';
  }
  return null;
}

function normalizedUuid(uuid: string): string {
  return uuid.trim().toLowerCase();
}

function bleDeviceDisplayName(
  device: Pick<BleScanDeviceRow, 'id' | 'name' | 'localName'>,
): string {
  return device.localName ?? device.name ?? '(bez nazwy)';
}

function bleDeviceToRow(device: Device): BleScanDeviceRow {
  return {
    id: device.id,
    name: device.name ?? null,
    localName: device.localName ?? null,
    rssi: device.rssi ?? null,
    isConnectable: device.isConnectable ?? null,
    serviceUUIDs: device.serviceUUIDs ?? null,
  };
}

function finiteNumber(value: unknown): number | null {
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

function classicAddress(device: ClassicDeviceLike): string {
  return device.address ?? device.id ?? '';
}

function classicDeviceName(device: ClassicDeviceLike): string {
  const name = device.name?.trim();
  return name && name.length > 0 ? name : '(bez nazwy)';
}

function classicDeviceType(device: ClassicDeviceLike): ClassicDeviceType {
  const value = String(device.type ?? 'UNKNOWN').toUpperCase();
  if (value === 'CLASSIC' || value === 'LOW_ENERGY' || value === 'DUAL') {
    return value;
  }
  return 'UNKNOWN';
}

function classicDeviceRssi(device: ClassicDeviceLike): number | null {
  const direct = finiteNumber(device.rssi);
  if (direct !== null && direct !== 0) {
    return direct;
  }

  const extra = device.extra;
  if (extra instanceof Map) {
    const mapped = finiteNumber(extra.get('rssi'));
    return mapped === 0 ? null : mapped;
  }
  if (typeof extra === 'object' && extra !== null && 'rssi' in extra) {
    const mapped = finiteNumber((extra as { rssi?: unknown }).rssi);
    return mapped === 0 ? null : mapped;
  }
  return null;
}

function classicDeviceToRow(device: ClassicDeviceLike): SppScanDeviceRow | null {
  const address = classicAddress(device);
  if (address.length === 0) {
    return null;
  }
  const type = classicDeviceType(device);
  if (type === 'LOW_ENERGY') {
    return null;
  }
  return {
    id: device.id ?? address,
    address,
    name: classicDeviceName(device),
    bonded: Boolean(device.bonded),
    type,
    rssi: classicDeviceRssi(device),
  };
}

function sortSppDevices(rows: SppScanDeviceRow[]): SppScanDeviceRow[] {
  return rows.sort((a, b) => {
    if (a.bonded !== b.bonded) {
      return a.bonded ? -1 : 1;
    }
    const aRssi = a.rssi ?? -999;
    const bRssi = b.rssi ?? -999;
    if (aRssi !== bRssi) {
      return bRssi - aRssi;
    }
    return a.name.localeCompare(b.name);
  });
}

async function requestAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }

  const apiLevel = Number(Platform.Version);
  if (apiLevel >= 31) {
    const result = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return (
      result[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] ===
        PermissionsAndroid.RESULTS.GRANTED &&
      result[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] ===
        PermissionsAndroid.RESULTS.GRANTED
    );
  }

  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

async function requestAndroidSppPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }

  const apiLevel = Number(Platform.Version);
  if (apiLevel >= 31) {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  }

  // Dla Android <= 11, gdy korzystamy wyłącznie z już sparowanych urządzeń
  // i nie uruchamiamy discovery, BLUETOOTH jest uprawnieniem install-time.
  return true;
}

async function waitForBlePoweredOn(manager: BleManager): Promise<void> {
  const initialState = await manager.state();
  if (initialState === State.PoweredOn) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let subscription: Subscription | null = null;
    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        subscription?.remove();
        reject(new Error('Bluetooth nie przeszedł do stanu PoweredOn w ciągu 10 s.'));
      }
    }, 10_000);

    subscription = manager.onStateChange((state) => {
      if (finished) {
        return;
      }
      if (state === State.PoweredOn) {
        finished = true;
        clearTimeout(timeout);
        subscription?.remove();
        resolve();
      } else if (
        state === State.PoweredOff ||
        state === State.Unauthorized ||
        state === State.Unsupported
      ) {
        finished = true;
        clearTimeout(timeout);
        subscription?.remove();
        reject(new Error(`Bluetooth state: ${state}`));
      }
    }, true);
  });
}

async function ensureClassicBluetoothReady(): Promise<void> {
  if (Platform.OS !== 'android') {
    throw new Error('Test SPP w tej aplikacji jest przeznaczony dla Androida.');
  }
  if (!(await ClassicBluetooth.isBluetoothAvailable())) {
    throw new Error('Telefon nie zgłasza obsługi Bluetooth Classic.');
  }
  if (!(await ClassicBluetooth.isBluetoothEnabled())) {
    const enabled = await ClassicBluetooth.requestBluetoothEnabled();
    if (!enabled) {
      throw new Error('Bluetooth nie został włączony.');
    }
  }
}

function formatNumber(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) {
    return '—';
  }
  return value.toFixed(digits);
}

function formatDistribution(value: DistributionSnapshot): string {
  return `med ${formatNumber(value.median, 1)} | p95 ${formatNumber(
    value.p95,
    1,
  )} | p99 ${formatNumber(value.p99, 1)} | max ${formatNumber(value.max, 1)}`;
}

function emptySnapshot(): BleStatsSnapshot {
  const channel = (id: number, expectedRateHz: number): ChannelStatsSnapshot => ({
    id,
    count: 0,
    averageRateHz: 0,
    recentRateHz: 0,
    expectedRateHz,
    estimatedDeliveryPercent: 0,
    latestRaw: null,
    lastSeenAgoMs: null,
  });
  const emptyDistribution: DistributionSnapshot = {
    min: null,
    median: null,
    p95: null,
    p99: null,
    max: null,
  };
  return {
    elapsedSeconds: 0,
    notifications: 0,
    notificationsPerSecondAverage: 0,
    notificationsPerSecond1s: 0,
    lastNotificationAgoMs: null,
    bytes: 0,
    bytesPerSecondAverage: 0,
    bytesPerSecond1s: 0,
    validFrames: 0,
    validFramesPerSecondAverage: 0,
    validFramesPerSecond1s: 0,
    lastParserActivityAgoMs: null,
    checksumErrors: 0,
    markerResyncDrops: 0,
    carryBytes: 0,
    notificationLengthsNotMultipleOf5: 0,
    exactConsecutiveDuplicateNotifications: 0,
    notificationLengthHistogram: [],
    channelCounts: [],
    notificationGapMs: emptyDistribution,
    callbackDurationMs: emptyDistribution,
    jsEventLoopLagMs: emptyDistribution,
    maxJsEventLoopLagMs: 0,
    rpm: channel(1, BLE_CONFIG.expectedRatesHz.rpm),
    iat: channel(4, BLE_CONFIG.expectedRatesHz.iat),
    clt: channel(24, BLE_CONFIG.expectedRatesHz.clt),
    rpmToCltRatio: null,
    iatToCltRatio: null,
  };
}

function errorDescription(error: unknown): string {
  if (error instanceof BleError) {
    return [
      error.message,
      `errorCode=${error.errorCode}`,
      error.androidErrorCode !== null ? `android=${error.androidErrorCode}` : null,
      error.attErrorCode !== null ? `att=${error.attErrorCode}` : null,
      error.reason ? `reason=${error.reason}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}

function decodeClassicPayload(data: string): {
  payload: Uint8Array;
  encoding: Exclude<ClassicRxEncoding, 'unknown'>;
} {
  const compact = data.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    try {
      const padded = compact + '='.repeat((4 - (compact.length % 4)) % 4);
      return { payload: toByteArray(padded), encoding: 'base64' };
    } catch {
      // Fallback poniżej dla implementacji zwracającej bezpośredni string binarny.
    }
  }

  const payload = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    payload[index] = data.charCodeAt(index) & 0xff;
  }
  return { payload, encoding: 'binary-string' };
}

function ChannelRow({ label, value }: { label: string; value: ChannelStatsSnapshot }) {
  return (
    <View style={styles.channelBox}>
      <Text style={styles.channelTitle}>
        {label} (ID {value.id})
      </Text>
      <Text style={styles.mono}>
        count={value.count} | avg={formatNumber(value.averageRateHz, 2)} Hz | 5s=
        {formatNumber(value.recentRateHz, 2)} Hz
      </Text>
      <Text style={styles.mono}>
        expected={formatNumber(value.expectedRateHz, 2)} Hz | rate vs nominal≈
        {formatNumber(value.estimatedDeliveryPercent, 1)}% | raw={value.latestRaw ?? '—'} | age=
        {formatNumber(value.lastSeenAgoMs, 0)} ms
      </Text>
    </View>
  );
}

function FrameRateChart({ samples }: { samples: readonly number[] }) {
  const latest = samples[samples.length - 1] ?? 0;

  return (
    <View>
      <View style={styles.chartHeaderRow}>
        <Text style={styles.mono}>Odebrane kanały / s</Text>
        <Text style={styles.mono}>teraz: {latest}/s</Text>
      </View>
      <View style={styles.chartBody}>
        <View style={styles.chartYAxis}>
          {[1000, 750, 500, 250, 0].map((value) => (
            <Text key={value} style={styles.chartAxisLabel}>
              {value}
            </Text>
          ))}
        </View>
        <View style={styles.chartPlot}>
          {[0, 0.25, 0.5, 0.75, 1].map((position) => (
            <View
              key={position}
              style={[styles.chartGridLine, { top: position * FRAME_RATE_CHART_HEIGHT }]}
            />
          ))}
          <View style={styles.chartBars}>
            {samples.map((value, index) => {
              const height =
                (Math.min(FRAME_RATE_CHART_MAX, Math.max(0, value)) /
                  FRAME_RATE_CHART_MAX) *
                FRAME_RATE_CHART_HEIGHT;
              return (
                <View key={index} style={styles.chartBarCell}>
                  <View
                    style={[
                      styles.chartBar,
                      value > FRAME_RATE_CHART_MAX && styles.chartBarOverflow,
                      { height },
                    ]}
                  />
                </View>
              );
            })}
          </View>
        </View>
      </View>
      <View style={styles.chartXAxisRow}>
        <Text style={styles.chartAxisLabel}>-60</Text>
        <Text style={styles.chartAxisLabel}>-45</Text>
        <Text style={styles.chartAxisLabel}>-30</Text>
        <Text style={styles.chartAxisLabel}>-15</Text>
        <Text style={styles.chartAxisLabel}>0 s</Text>
      </View>
      <Text style={styles.note}>
        Każdy słupek pokazuje liczbę poprawnie odebranych kanałów w jednej sekundzie.
        Wykres przesuwa się i przechowuje ostatnie 60 sekund.
      </Text>
    </View>
  );
}

const ChannelTile = React.memo(
  function ChannelTileView({
    model,
    compact,
  }: {
    model: ChannelTileModel;
    compact: boolean;
  }) {
    return (
      <View
        style={[
          styles.channelTile,
          compact && styles.channelTileCompact,
          !model.active && styles.channelTileInactive,
          model.stale && styles.channelTileStale,
          model.unknown && styles.channelTileUnknown,
        ]}
      >
        <Text
          style={[styles.channelTileTitle, compact && styles.channelTileTitleCompact]}
          numberOfLines={2}
        >
          {model.id}. {model.name}
        </Text>
        <Text
          style={[styles.channelTileValue, compact && styles.channelTileValueCompact]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.72}
        >
          {model.valueText}
        </Text>
        <Text style={[styles.channelTileRate, compact && styles.channelTileRateCompact]}>
          ({model.rateText})
        </Text>
      </View>
    );
  },
  (previous, next) =>
    previous.compact === next.compact &&
    previous.model.id === next.model.id &&
    previous.model.name === next.model.name &&
    previous.model.valueText === next.model.valueText &&
    previous.model.rateText === next.model.rateText &&
    previous.model.active === next.model.active &&
    previous.model.stale === next.model.stale &&
    previous.model.unknown === next.model.unknown,
);

export default function App() {
  useKeepAwake();

  const manager = useMemo(() => new BleManager(), []);
  const collectorRef = useRef(new BleStatsCollector());
  const uiRefreshDiagnosticsRef = useRef(
    new UiRefreshDiagnostics(BLE_CONFIG.channelUiRefreshMs),
  );
  const { width: windowWidth } = useWindowDimensions();
  const compactChannelGrid = windowWidth < 700;

  const bleMonitorSubscriptionRef = useRef<Subscription | null>(null);
  const bleDisconnectSubscriptionRef = useRef<Subscription | null>(null);
  const classicDataSubscriptionRef = useRef<RemovableSubscription | null>(null);
  const classicDisconnectSubscriptionRef = useRef<RemovableSubscription | null>(null);
  const classicErrorSubscriptionRef = useRef<RemovableSubscription | null>(null);

  const bleScanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bleScanUiTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const classicScanGenerationRef = useRef(0);
  const classicDiscoveryActiveRef = useRef(false);

  const discoveredBleObjectsRef = useRef<Map<string, Device>>(new Map());
  const discoveredBleRowsRef = useRef<Map<string, BleScanDeviceRow>>(new Map());
  const discoveredSppObjectsRef = useRef<Map<string, ClassicDeviceLike>>(new Map());
  const discoveredSppRowsRef = useRef<Map<string, SppScanDeviceRow>>(new Map());

  const connectingRef = useRef(false);
  const connectedTransportRef = useRef<TransportMode | null>(null);
  const connectedBleDeviceIdRef = useRef<string | null>(null);
  const connectedSppDeviceRef = useRef<ClassicDeviceLike | null>(null);
  const intentionalDisconnectRef = useRef(false);
  const transportDecodeErrorsRef = useRef(0);
  const classicRxEncodingRef = useRef<ClassicRxEncoding>('unknown');
  const mainViewRef = useRef<MainView>('connection');
  const channelUiCommitPendingRef = useRef(false);
  const scheduleChannelUiRefreshRef = useRef<(() => void) | null>(null);

  const controlSynchronizerRef = useRef(new ControlStateSynchronizer());
  const bleTxTargetRef = useRef<BleTxTarget | null>(null);
  const highPriorityTxQueueRef = useRef<TxQueueItem[]>([]);
  const normalPriorityTxQueueRef = useRef<TxQueueItem[]>([]);
  const txProcessingRef = useRef(false);
  const txGenerationRef = useRef(0);
  const txDiagnosticsRef = useRef<TxDiagnosticsMutable>(emptyTxDiagnosticsMutable());
  const bleTxEnabledRef = useRef(true);
  const controlStateDirtyRef = useRef(false);

  const [transportMode, setTransportMode] = useState<TransportMode>('ble');
  const [mainView, setMainView] = useState<MainView>('connection');
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [statusText, setStatusText] = useState(
    'Wybierz BLE albo SPP, zeskanuj urządzenia i połącz się z wybranym modułem.',
  );
  const [errorText, setErrorText] = useState<string | null>(null);
  const [connectedInfo, setConnectedInfo] = useState<ConnectedInfo | null>(null);
  const [bleScanDevices, setBleScanDevices] = useState<BleScanDeviceRow[]>([]);
  const [sppScanDevices, setSppScanDevices] = useState<SppScanDeviceRow[]>([]);
  const [stats, setStats] = useState<BleStatsSnapshot>(() => emptySnapshot());
  const [frameRateHistory, setFrameRateHistory] = useState<number[]>(() =>
    Array(FRAME_RATE_CHART_SECONDS).fill(0),
  );
  const lastChartFrameCountRef = useRef(0);
  const frameRateRangeSamplingReadyRef = useRef(false);
  const [frameRateRange, setFrameRateRange] = useState<{
    min: number | null;
    max: number | null;
  }>({ min: null, max: null });
  const [liveChannels, setLiveChannels] = useState<ChannelLiveSnapshot[]>([]);
  const [uiRefreshDiagnostics, setUiRefreshDiagnostics] =
    useState<UiRefreshDiagnosticsSnapshot>(() =>
      uiRefreshDiagnosticsRef.current.snapshot(monotonicNowMs()),
    );
  const [transportDecodeErrors, setTransportDecodeErrors] = useState(0);
  const [classicRxEncoding, setClassicRxEncoding] = useState<ClassicRxEncoding>('unknown');
  const [bleTxEnabled, setBleTxEnabled] = useState(true);
  const [selectedConnectionPriority, setSelectedConnectionPriority] =
    useState<BleConnectionPriorityName>('BALANCED');
  const [requestedConnectionPriority, setRequestedConnectionPriority] =
    useState<BleConnectionPriorityName | null>(null);
  const [connectionPriorityRequestSuccess, setConnectionPriorityRequestSuccess] =
    useState<boolean | null>(null);
  const [connectionPriorityRequestError, setConnectionPriorityRequestError] =
    useState<string | null>(null);
  const [controlState, setControlState] = useState<ControlSyncSnapshot>(() =>
    controlSynchronizerRef.current.snapshot(),
  );
  const [txDiagnostics, setTxDiagnostics] = useState<TxDiagnosticsSnapshot>(() =>
    txDiagnosticsSnapshot(emptyTxDiagnosticsMutable(), monotonicNowMs(), 0),
  );

  const selectMainView = useCallback((nextView: MainView) => {
    mainViewRef.current = nextView;
    setMainView(nextView);
  }, []);

  const refreshBleScanList = useCallback(() => {
    // Map zachowuje kolejność pierwszego wykrycia. Ponowne set() dla tego samego
    // urządzenia aktualizuje RSSI/metadane bez przesuwania pozycji na liście.
    setBleScanDevices(Array.from(discoveredBleRowsRef.current.values()));
  }, []);

  const refreshSppScanList = useCallback(() => {
    setSppScanDevices(sortSppDevices(Array.from(discoveredSppRowsRef.current.values())));
  }, []);

  const mergeSppDevices = useCallback(
    (devices: ClassicDeviceLike[], forceBonded = false) => {
      for (const device of devices) {
        const row = classicDeviceToRow(device);
        if (row === null) {
          continue;
        }
        const previous = discoveredSppRowsRef.current.get(row.address);
        const merged: SppScanDeviceRow = {
          ...row,
          bonded: forceBonded || row.bonded || previous?.bonded === true,
          rssi: row.rssi ?? previous?.rssi ?? null,
          name: row.name === '(bez nazwy)' ? previous?.name ?? row.name : row.name,
        };
        discoveredSppObjectsRef.current.set(row.address, device);
        discoveredSppRowsRef.current.set(row.address, merged);
      }
      refreshSppScanList();
    },
    [refreshSppScanList],
  );

  const stopBleScan = useCallback(() => {
    if (bleScanTimeoutRef.current !== null) {
      clearTimeout(bleScanTimeoutRef.current);
      bleScanTimeoutRef.current = null;
    }
    if (bleScanUiTimerRef.current !== null) {
      clearInterval(bleScanUiTimerRef.current);
      bleScanUiTimerRef.current = null;
    }
    void manager.stopDeviceScan().catch(() => undefined);
  }, [manager]);

  const cancelSppDiscovery = useCallback(async (invalidate = true): Promise<void> => {
    if (invalidate) {
      classicScanGenerationRef.current += 1;
    }

    // v1.4 celowo NIE wywołuje natywnego BluetoothAdapter.cancelDiscovery().
    // Do testu SPP wystarczają urządzenia już sparowane w ustawieniach Androida.
    // Dzięki temu ścieżka BLE nigdy nie dotyka modułu Bluetooth Classic, a SPP
    // nie uruchamia kosztownego inquiry scan ani nie ryzykuje SecurityException.
    classicDiscoveryActiveRef.current = false;
  }, []);

  const stopAllScans = useCallback(() => {
    stopBleScan();
    void cancelSppDiscovery(true);
  }, [cancelSppDiscovery, stopBleScan]);

  const finishBleScan = useCallback(
    (message?: string) => {
      stopBleScan();
      refreshBleScanList();
      setConnectionState('scan-results');
      setStatusText(
        message ??
          `Skan BLE zakończony. Znaleziono ${discoveredBleRowsRef.current.size} urządzeń.`,
      );
    },
    [refreshBleScanList, stopBleScan],
  );

  const finishSppScan = useCallback(
    (message?: string) => {
      void cancelSppDiscovery(true);
      refreshSppScanList();
      setConnectionState('scan-results');
      setStatusText(
        message ??
          `Skan SPP zakończony. Na liście jest ${discoveredSppRowsRef.current.size} urządzeń Classic/DUAL.`,
      );
    },
    [cancelSppDiscovery, refreshSppScanList],
  );

  const removeSubscriptions = useCallback(() => {
    bleMonitorSubscriptionRef.current?.remove();
    bleMonitorSubscriptionRef.current = null;
    bleDisconnectSubscriptionRef.current?.remove();
    bleDisconnectSubscriptionRef.current = null;
    classicDataSubscriptionRef.current?.remove();
    classicDataSubscriptionRef.current = null;
    classicDisconnectSubscriptionRef.current?.remove();
    classicDisconnectSubscriptionRef.current = null;
    classicErrorSubscriptionRef.current?.remove();
    classicErrorSubscriptionRef.current = null;
  }, []);

  const resetStats = useCallback(() => {
    const nowMs = monotonicNowMs();
    collectorRef.current.reset(nowMs);
    uiRefreshDiagnosticsRef.current.reset();
    lastChartFrameCountRef.current = 0;
    frameRateRangeSamplingReadyRef.current = false;
    transportDecodeErrorsRef.current = 0;
    classicRxEncodingRef.current = 'unknown';
    setTransportDecodeErrors(0);
    setClassicRxEncoding('unknown');
    setStats(emptySnapshot());
    setFrameRateHistory(Array(FRAME_RATE_CHART_SECONDS).fill(0));
    setFrameRateRange({ min: null, max: null });
    setLiveChannels([]);
    setUiRefreshDiagnostics(uiRefreshDiagnosticsRef.current.snapshot(nowMs));
  }, []);

  const resetControlSession = useCallback(() => {
    txGenerationRef.current += 1;
    highPriorityTxQueueRef.current.length = 0;
    normalPriorityTxQueueRef.current.length = 0;
    bleTxTargetRef.current = null;
    const controlSnapshot = controlSynchronizerRef.current.reset();
    controlStateDirtyRef.current = false;
    const emptyTx = emptyTxDiagnosticsMutable();
    txDiagnosticsRef.current = emptyTx;
    setControlState(controlSnapshot);
    setTxDiagnostics(txDiagnosticsSnapshot(emptyTx, monotonicNowMs(), 0));
  }, []);

  const writeTransportFrame = useCallback(
    async (payload: Uint8Array): Promise<void> => {
      const valueBase64 = fromByteArray(payload);
      const transport = connectedTransportRef.current;

      if (transport === 'ble') {
        const target = bleTxTargetRef.current;
        if (target === null) {
          throw new Error('BLE: nie znaleziono zapisywalnej charakterystyki TX.');
        }
        if (target.mode === 'without-response') {
          await manager.writeCharacteristicWithoutResponseForDevice(
            target.deviceId,
            target.serviceUuid,
            target.characteristicUuid,
            valueBase64,
          );
        } else {
          await manager.writeCharacteristicWithResponseForDevice(
            target.deviceId,
            target.serviceUuid,
            target.characteristicUuid,
            valueBase64,
          );
        }
        return;
      }

      if (transport === 'spp') {
        const device = connectedSppDeviceRef.current;
        if (device === null) {
          throw new Error('SPP: brak aktywnego socketu RFCOMM.');
        }
        const written = await device.write(valueBase64, 'base64');
        if (!written) {
          throw new Error('SPP: write() zwróciło false.');
        }
        return;
      }

      throw new Error('Brak aktywnego transportu TX.');
    },
    [manager],
  );

  const processTxQueue = useCallback(async (): Promise<void> => {
    if (txProcessingRef.current) {
      return;
    }

    txProcessingRef.current = true;
    try {
      while (
        highPriorityTxQueueRef.current.length > 0 ||
        normalPriorityTxQueueRef.current.length > 0
      ) {
        const item =
          highPriorityTxQueueRef.current.shift() ??
          normalPriorityTxQueueRef.current.shift();
        if (item === undefined || item.generation !== txGenerationRef.current) {
          continue;
        }

        const writeStartedAt = monotonicNowMs();
        const queueDelayMs = Math.max(0, writeStartedAt - item.enqueuedAtMs);
        try {
          await writeTransportFrame(item.payload);
          if (item.generation !== txGenerationRef.current) {
            continue;
          }
          const completedAt = monotonicNowMs();
          const diagnostics = txDiagnosticsRef.current;
          if (item.kind === 'latency-reply') {
            diagnostics.latencyRepliesSent += 1;
          } else {
            diagnostics.switchFramesSent += 1;
          }
          diagnostics.lastTxKind = item.kind;
          diagnostics.lastTxHex = frameToHex(item.payload);
          diagnostics.lastTxAtMs = completedAt;
          diagnostics.lastWriteDurationMs = Math.max(0, completedAt - writeStartedAt);
          diagnostics.lastQueueDelayMs = queueDelayMs;
          diagnostics.lastError = null;
        } catch (error) {
          if (item.generation !== txGenerationRef.current) {
            continue;
          }
          const diagnostics = txDiagnosticsRef.current;
          diagnostics.txErrors += 1;
          diagnostics.lastError = errorDescription(error);
          diagnostics.lastTxKind = item.kind;
          diagnostics.lastTxHex = frameToHex(item.payload);
          diagnostics.lastTxAtMs = monotonicNowMs();
          diagnostics.lastWriteDurationMs = Math.max(
            0,
            monotonicNowMs() - writeStartedAt,
          );
          diagnostics.lastQueueDelayMs = queueDelayMs;
        }
      }
    } finally {
      txProcessingRef.current = false;
    }
  }, [writeTransportFrame]);

  const enqueueTxFrame = useCallback(
    (kind: TxFrameKind, payload: Uint8Array, highPriority: boolean): void => {
      const diagnostics = txDiagnosticsRef.current;
      if (connectedTransportRef.current === 'ble' && !bleTxEnabledRef.current) {
        diagnostics.txSuppressedTotal += 1;
        if (kind === 'latency-reply') {
          diagnostics.latencyRepliesSuppressed += 1;
        } else {
          diagnostics.switchFramesSuppressed += 1;
        }
        diagnostics.lastTxKind = kind;
        diagnostics.lastTxHex = frameToHex(payload);
        diagnostics.lastTxAtMs = monotonicNowMs();
        diagnostics.lastWriteDurationMs = null;
        diagnostics.lastQueueDelayMs = null;
        return;
      }

      const item: TxQueueItem = {
        kind,
        payload: payload.slice(),
        enqueuedAtMs: monotonicNowMs(),
        generation: txGenerationRef.current,
      };
      if (highPriority) {
        highPriorityTxQueueRef.current.push(item);
      } else {
        normalPriorityTxQueueRef.current.push(item);
      }

      if (kind === 'latency-reply') {
        diagnostics.latencyRepliesQueued += 1;
      } else {
        diagnostics.switchFramesQueued += 1;
      }
      void processTxQueue();
    },
    [processTxQueue],
  );

  const handleParsedFrames = useCallback(
    (frames: readonly ControlChannelFrame[]): void => {
      // RTT ma najwyższy priorytet. Najpierw przeglądamy cały odebrany fragment
      // pod kątem ID 99, a dopiero później kolejkujemy ramki statusu switchy.
      for (const frame of frames) {
        if (frame.id === CONTROL_CHANNEL_IDS.roundTrip) {
          txDiagnosticsRef.current.latencyRequests += 1;
          enqueueTxFrame('latency-reply', buildLatencyReplyFrame(), true);
        }
      }

      let stateChanged = false;
      for (const frame of frames) {
        const result = controlSynchronizerRef.current.ingestChannel(frame.id, frame.raw);
        stateChanged = stateChanged || result.stateChanged;
        if (result.shouldSendSwitchFrame) {
          txDiagnosticsRef.current.switchPolls += 1;
          enqueueTxFrame(
            'switch-status',
            controlSynchronizerRef.current.buildSwitchFrame(),
            false,
          );
        }
      }

      if (stateChanged) {
        // Stan protokołu zmienia się natychmiast, ale jego kopia React może
        // poczekać na wolniejszy tick statusów poza callbackiem RX.
        controlStateDirtyRef.current = true;
      }
    },
    [enqueueTxFrame],
  );

  const toggleControlSwitch = useCallback((index: number) => {
    setControlState(controlSynchronizerRef.current.toggleSwitch(index));
  }, []);

  const incrementControlRotary = useCallback((index: number) => {
    setControlState(controlSynchronizerRef.current.incrementRotary(index));
  }, []);

  const changeBleTxEnabled = useCallback((enabled: boolean) => {
    bleTxEnabledRef.current = enabled;
    setBleTxEnabled(enabled);
    if (!enabled && connectedTransportRef.current === 'ble') {
      const pendingItems = [
        ...highPriorityTxQueueRef.current,
        ...normalPriorityTxQueueRef.current,
      ];
      const diagnostics = txDiagnosticsRef.current;
      for (const item of pendingItems) {
        diagnostics.txSuppressedTotal += 1;
        if (item.kind === 'latency-reply') {
          diagnostics.latencyRepliesSuppressed += 1;
        } else {
          diagnostics.switchFramesSuppressed += 1;
        }
      }
      highPriorityTxQueueRef.current.length = 0;
      normalPriorityTxQueueRef.current.length = 0;
    }
  }, []);

  const resynchronizeControls = useCallback(() => {
    setControlState(controlSynchronizerRef.current.reset());
    normalPriorityTxQueueRef.current.length = 0;
  }, []);

  const installBleMonitor = useCallback(
    async (device: Device, scanRssi: number | null): Promise<void> => {
      setConnectionState('discovering');
      setStatusText('Wykrywanie usług i charakterystyk BLE…');
      const preparedDevice = await device.discoverAllServicesAndCharacteristics();

      const services = await preparedDevice.services();
      const preferredService = normalizedUuid(BLE_CONFIG.preferredServiceUuid);
      const preferredNotify = normalizedUuid(BLE_CONFIG.preferredNotifyCharacteristicUuid);
      const preferredWrite = normalizedUuid(BLE_CONFIG.preferredWriteCharacteristicUuid);
      const orderedServices = [...services].sort((a, b) => {
        const aPreferred = normalizedUuid(a.uuid) === preferredService ? 0 : 1;
        const bPreferred = normalizedUuid(b.uuid) === preferredService ? 0 : 1;
        return aPreferred - bPreferred;
      });

      const allCharacteristics: Characteristic[] = [];
      const characteristicDescriptions: string[] = [];
      for (const service of orderedServices) {
        const characteristics = await preparedDevice.characteristicsForService(service.uuid);
        allCharacteristics.push(...characteristics);
        for (const characteristic of characteristics) {
          characteristicDescriptions.push(
            `${service.uuid}/${characteristic.uuid} ` +
              `[N=${characteristic.isNotifiable ? 1 : 0}, I=${
                characteristic.isIndicatable ? 1 : 0
              }, WNR=${characteristic.isWritableWithoutResponse ? 1 : 0}, WR=${
                characteristic.isWritableWithResponse ? 1 : 0
              }]`,
          );
        }
      }

      const notifyCharacteristic =
        allCharacteristics.find(
          (characteristic) =>
            normalizedUuid(characteristic.uuid) === preferredNotify &&
            (characteristic.isNotifiable || characteristic.isIndicatable),
        ) ??
        allCharacteristics.find(
          (characteristic) =>
            normalizedUuid(characteristic.serviceUUID) === preferredService &&
            (characteristic.isNotifiable || characteristic.isIndicatable),
        ) ??
        allCharacteristics.find(
          (characteristic) => characteristic.isNotifiable || characteristic.isIndicatable,
        ) ??
        null;

      if (notifyCharacteristic === null) {
        throw new Error(
          `Nie znaleziono charakterystyki notify/indicate. Odkryto: ${characteristicDescriptions.join(
            '; ',
          )}`,
        );
      }

      const writeCharacteristic =
        allCharacteristics.find(
          (characteristic) =>
            normalizedUuid(characteristic.uuid) === preferredWrite &&
            writableMode(characteristic) !== null,
        ) ??
        allCharacteristics.find(
          (characteristic) =>
            normalizedUuid(characteristic.serviceUUID) ===
              normalizedUuid(notifyCharacteristic.serviceUUID) &&
            writableMode(characteristic) !== null,
        ) ??
        allCharacteristics.find((characteristic) => writableMode(characteristic) !== null) ??
        null;
      const writeMode =
        writeCharacteristic === null ? null : writableMode(writeCharacteristic);

      setConnectionState('subscribing');
      setStatusText(`Subskrypcja ${notifyCharacteristic.serviceUUID}/${notifyCharacteristic.uuid}…`);
      resetStats();
      resetControlSession();

      if (writeCharacteristic !== null && writeMode !== null) {
        bleTxTargetRef.current = {
          deviceId: preparedDevice.id,
          serviceUuid: writeCharacteristic.serviceUUID,
          characteristicUuid: writeCharacteristic.uuid,
          mode: writeMode,
        };
      }
      connectedTransportRef.current = 'ble';

      setConnectedInfo({
        transport: 'ble',
        id: preparedDevice.id,
        name: preparedDevice.localName ?? preparedDevice.name ?? '(bez nazwy)',
        scanRssi,
        mtu: preparedDevice.mtu,
        serviceUuid: notifyCharacteristic.serviceUUID,
        notifyCharacteristicUuid: notifyCharacteristic.uuid,
        writeServiceUuid: writeCharacteristic?.serviceUUID ?? null,
        writeCharacteristicUuid: writeCharacteristic?.uuid ?? null,
        writeMode: writeMode ?? 'unavailable',
        characteristicSummary: characteristicDescriptions.join('\n'),
        connectedAtIso: new Date().toISOString(),
      });

      bleMonitorSubscriptionRef.current = preparedDevice.monitorCharacteristicForService(
        notifyCharacteristic.serviceUUID,
        notifyCharacteristic.uuid,
        (error, characteristic) => {
          const callbackStartedAt = monotonicNowMs();
          try {
            if (error !== null) {
              if (!intentionalDisconnectRef.current) {
                setErrorText(errorDescription(error));
                setConnectionState('error');
              }
              return;
            }

            const base64Value = characteristic?.value;
            if (base64Value === null || base64Value === undefined) {
              return;
            }

            const payload = toByteArray(base64Value);
            const parsedFrames = collectorRef.current.ingestNotification(
              payload,
              callbackStartedAt,
            );
            handleParsedFrames(parsedFrames);
          } catch {
            transportDecodeErrorsRef.current += 1;
          } finally {
            collectorRef.current.recordCallbackDuration(monotonicNowMs() - callbackStartedAt);
          }
        },
        'ecumaster-rx-monitor',
      );

      bleDisconnectSubscriptionRef.current = manager.onDeviceDisconnected(
        preparedDevice.id,
        (error) => {
          connectedBleDeviceIdRef.current = null;
          connectedTransportRef.current = null;
          bleTxTargetRef.current = null;
          txGenerationRef.current += 1;
          highPriorityTxQueueRef.current.length = 0;
          normalPriorityTxQueueRef.current.length = 0;
          connectingRef.current = false;
          bleMonitorSubscriptionRef.current?.remove();
          bleMonitorSubscriptionRef.current = null;
          setConnectionState('disconnected');
          selectMainView('connection');
          setStatusText(
            intentionalDisconnectRef.current
              ? 'Rozłączono BLE ręcznie.'
              : 'Połączenie BLE zostało przerwane.',
          );
          if (!intentionalDisconnectRef.current && error !== null) {
            setErrorText(errorDescription(error));
          }
        },
      );

      connectingRef.current = false;
      setConnectionState('receiving');
      selectMainView('channels');
      setStatusText(
        writeMode === null
          ? 'BLE: odbieranie notyfikacji. Nie znaleziono charakterystyki TX — sterowanie i RTT będą niedostępne.'
          : `BLE: RX aktywny; TX ${writeCharacteristic?.serviceUUID}/${writeCharacteristic?.uuid} (${writeMode}).`,
      );
    },
    [handleParsedFrames, manager, resetControlSession, resetStats, selectMainView],
  );

  const connectBleDevice = useCallback(
    async (scannedDevice: Device): Promise<void> => {
      const priorityName = selectedConnectionPriority;
      setConnectionState('connecting');
      setRequestedConnectionPriority(null);
      setConnectionPriorityRequestSuccess(null);
      setConnectionPriorityRequestError(null);
      setStatusText(
        `Łączenie BLE z ${scannedDevice.localName ?? scannedDevice.name ?? scannedDevice.id}…`,
      );

      let device = await scannedDevice.connect({
        autoConnect: false,
        timeout: BLE_CONFIG.connectionTimeoutMs,
      });
      connectedBleDeviceIdRef.current = device.id;

      setRequestedConnectionPriority(priorityName);
      try {
        device = await manager.requestConnectionPriorityForDevice(
          device.id,
          connectionPriorityValue(priorityName),
          `ecumaster-${priorityName.toLowerCase()}`,
        );
        setConnectionPriorityRequestSuccess(true);
        setStatusText(`Połączono BLE; wysłano żądanie CONNECTION_PRIORITY_${priorityName}.`);
      } catch (error) {
        const description = errorDescription(error);
        setConnectionPriorityRequestSuccess(false);
        setConnectionPriorityRequestError(description);
        setStatusText(
          `Połączono BLE, ale żądanie CONNECTION_PRIORITY_${priorityName} zwróciło błąd; kontynuuję: ${description}`,
        );
      }

      try {
        device = await manager.requestMTUForDevice(
          device.id,
          BLE_CONFIG.requestedMtu,
          'ecumaster-request-mtu',
        );
        setStatusText(`BLE priority ${priorityName} zażądane; MTU zwrócone przez bibliotekę: ${device.mtu}.`);
      } catch (error) {
        setStatusText(`BLE priority ${priorityName} zażądane; MTU request error: ${errorDescription(error)}`);
      }

      await installBleMonitor(device, scannedDevice.rssi ?? null);
    },
    [installBleMonitor, manager, selectedConnectionPriority],
  );

  const startBleScan = useCallback(async () => {
    if (connectingRef.current || connectedTransportRef.current !== null) {
      return;
    }

    intentionalDisconnectRef.current = false;
    setErrorText(null);
    setConnectedInfo(null);
    removeSubscriptions();
    resetControlSession();
    // BLE nie powinno wywoływać żadnej funkcji z modułu Bluetooth Classic.
    // W v1.3 stopAllScans() wykonywało cancelDiscovery() Classic jeszcze przed
    // uzyskaniem BLUETOOTH_SCAN, co mogło powodować natywny crash na Android 12+.
    stopBleScan();
    discoveredBleObjectsRef.current.clear();
    discoveredBleRowsRef.current.clear();
    setBleScanDevices([]);

    try {
      const permissionsGranted = await requestAndroidPermissions();
      if (!permissionsGranted) {
        throw new Error('Brak uprawnień Bluetooth wymaganych do skanowania i połączenia.');
      }

      setConnectionState('waiting-for-bluetooth');
      setStatusText('Oczekiwanie na Bluetooth PoweredOn…');
      await waitForBlePoweredOn(manager);

      setConnectionState('scanning');
      setStatusText(
        `Skanowanie wszystkich urządzeń BLE przez ${BLE_CONFIG.scanTimeoutMs / 1000} s.`,
      );

      bleScanUiTimerRef.current = setInterval(refreshBleScanList, 300);
      bleScanTimeoutRef.current = setTimeout(() => finishBleScan(), BLE_CONFIG.scanTimeoutMs);

      await manager.startDeviceScan(
        null,
        { scanMode: ScanMode.LowLatency },
        (error, device) => {
          if (error !== null) {
            stopBleScan();
            setConnectionState('error');
            setErrorText(errorDescription(error));
            return;
          }
          if (device === null) {
            return;
          }
          discoveredBleObjectsRef.current.set(device.id, device);
          discoveredBleRowsRef.current.set(device.id, bleDeviceToRow(device));
        },
      );
    } catch (error) {
      stopBleScan();
      setConnectionState('error');
      setErrorText(errorDescription(error));
    }
  }, [finishBleScan, manager, refreshBleScanList, removeSubscriptions, resetControlSession, stopBleScan]);

  const startSppScan = useCallback(async () => {
    if (connectingRef.current || connectedTransportRef.current !== null) {
      return;
    }

    intentionalDisconnectRef.current = false;
    setErrorText(null);
    setConnectedInfo(null);
    removeSubscriptions();
    resetControlSession();
    stopBleScan();
    discoveredSppObjectsRef.current.clear();
    discoveredSppRowsRef.current.clear();
    setSppScanDevices([]);

    classicScanGenerationRef.current += 1;

    try {
      const permissionsGranted = await requestAndroidSppPermissions();
      if (!permissionsGranted) {
        throw new Error(
          'Brak uprawnienia Urządzenia w pobliżu / BLUETOOTH_CONNECT wymaganego dla SPP.',
        );
      }

      setConnectionState('waiting-for-bluetooth');
      setStatusText('Sprawdzanie Bluetooth Classic…');
      await ensureClassicBluetoothReady();

      // Dla testu performance nie potrzebujemy inquiry scan. Android zaleca
      // najpierw sprawdzić urządzenia sparowane; do połączenia wystarcza MAC.
      // Bolutek należy wcześniej sparować w Ustawienia -> Bluetooth.
      const bonded = await ClassicBluetooth.getBondedDevices();
      mergeSppDevices(bonded, true);

      setConnectionState('scan-results');
      setStatusText(
        `SPP: znaleziono ${bonded.length} sparowanych urządzeń. Jeśli modułu nie ma na liście, sparuj go najpierw w ustawieniach Androida.`,
      );
    } catch (error) {
      setConnectionState('error');
      setErrorText(errorDescription(error));
    }
  }, [mergeSppDevices, removeSubscriptions, resetControlSession, stopBleScan]);

  const connectSelectedBleDevice = useCallback(
    async (deviceId: string) => {
      if (connectingRef.current || connectedTransportRef.current !== null) {
        return;
      }
      const device = discoveredBleObjectsRef.current.get(deviceId);
      if (device === undefined) {
        setConnectionState('error');
        setErrorText('Wybrane urządzenie BLE nie jest już dostępne. Uruchom skan ponownie.');
        return;
      }

      intentionalDisconnectRef.current = false;
      connectingRef.current = true;
      setErrorText(null);
      stopAllScans();

      try {
        await connectBleDevice(device);
      } catch (connectError) {
        const failedDeviceId = connectedBleDeviceIdRef.current;
        if (failedDeviceId !== null) {
          void manager.cancelDeviceConnection(failedDeviceId).catch(() => undefined);
        }
        connectedBleDeviceIdRef.current = null;
        connectedTransportRef.current = null;
        resetControlSession();
        connectingRef.current = false;
        setConnectionState('error');
        setErrorText(errorDescription(connectError));
      }
    },
    [connectBleDevice, manager, resetControlSession, stopAllScans],
  );

  const installSppReceiver = useCallback(
    (device: ClassicDeviceLike, row: SppScanDeviceRow, secureSocket: boolean): void => {
      resetStats();
      resetControlSession();
      const address = classicAddress(device);
      connectedSppDeviceRef.current = device;
      connectedTransportRef.current = 'spp';

      setConnectedInfo({
        transport: 'spp',
        id: device.id ?? address,
        address,
        name: classicDeviceName(device),
        bonded: true,
        deviceType: classicDeviceType(device),
        scanRssi: row.rssi,
        secureSocket,
        readSize: SPP_READ_SIZE,
        connectedAtIso: new Date().toISOString(),
      });

      classicDataSubscriptionRef.current = device.onDataReceived((event) => {
        const callbackStartedAt = monotonicNowMs();
        try {
          if (typeof event.data !== 'string' || event.data.length === 0) {
            return;
          }
          const decoded = decodeClassicPayload(event.data);
          if (classicRxEncodingRef.current === 'unknown') {
            classicRxEncodingRef.current = decoded.encoding;
          }
          if (decoded.payload.length > 0) {
            const parsedFrames = collectorRef.current.ingestNotification(
              decoded.payload,
              callbackStartedAt,
            );
            handleParsedFrames(parsedFrames);
          }
        } catch {
          transportDecodeErrorsRef.current += 1;
        } finally {
          collectorRef.current.recordCallbackDuration(monotonicNowMs() - callbackStartedAt);
        }
      });

      classicDisconnectSubscriptionRef.current = ClassicBluetooth.onDeviceDisconnected((event) => {
        const eventAddress = event.device?.address ?? event.device?.id;
        if (
          eventAddress !== undefined &&
          eventAddress.toUpperCase() !== address.toUpperCase()
        ) {
          return;
        }
        connectedSppDeviceRef.current = null;
        connectedTransportRef.current = null;
        txGenerationRef.current += 1;
        highPriorityTxQueueRef.current.length = 0;
        normalPriorityTxQueueRef.current.length = 0;
        connectingRef.current = false;
        classicDataSubscriptionRef.current?.remove();
        classicDataSubscriptionRef.current = null;
        setConnectionState('disconnected');
        selectMainView('connection');
        setStatusText(
          intentionalDisconnectRef.current
            ? 'Rozłączono SPP ręcznie.'
            : 'Połączenie SPP zostało przerwane.',
        );
      });

      classicErrorSubscriptionRef.current = ClassicBluetooth.onError((event) => {
        const eventAddress = event.device?.address ?? event.device?.id;
        if (
          eventAddress !== undefined &&
          eventAddress.toUpperCase() !== address.toUpperCase()
        ) {
          return;
        }
        if (!intentionalDisconnectRef.current) {
          setErrorText(event.message ?? 'Natywna warstwa Bluetooth Classic zgłosiła błąd.');
        }
      });

      connectingRef.current = false;
      setConnectionState('receiving');
      selectMainView('channels');
      setStatusText(
        `SPP: odbieranie binarnego strumienia RFCOMM, READ_SIZE=${SPP_READ_SIZE}, socket ${
          secureSocket ? 'secure' : 'insecure'
        }.`,
      );
    },
    [handleParsedFrames, resetControlSession, resetStats, selectMainView],
  );

  const connectSelectedSppDevice = useCallback(
    async (address: string) => {
      if (connectingRef.current || connectedTransportRef.current !== null) {
        return;
      }
      const initialDevice = discoveredSppObjectsRef.current.get(address);
      const row = discoveredSppRowsRef.current.get(address);
      if (initialDevice === undefined || row === undefined) {
        setConnectionState('error');
        setErrorText('Wybrane urządzenie SPP nie jest już dostępne. Uruchom skan ponownie.');
        return;
      }

      intentionalDisconnectRef.current = false;
      connectingRef.current = true;
      setErrorText(null);
      stopBleScan();
      await cancelSppDiscovery(true);

      let device = initialDevice;
      try {
        if (!row.bonded && !Boolean(device.bonded)) {
          setConnectionState('pairing');
          setStatusText(`Parowanie SPP z ${row.name} (${address})…`);
          device = await ClassicBluetooth.pairDevice(address);
          mergeSppDevices([device], true);
        }

        setConnectionState('connecting');
        setStatusText(`Łączenie SPP/RFCOMM z ${classicDeviceName(device)} (${address})…`);

        try {
          if (await device.isConnected()) {
            await device.disconnect();
          }
        } catch {
          // Kontynuujemy próbę połączenia w żądanym trybie binarnym.
        }

        const commonOptions: Record<string, unknown> = {
          CONNECTOR_TYPE: 'rfcomm',
          CONNECTION_TYPE: 'binary',
          READ_SIZE: SPP_READ_SIZE,
          READ_TIMEOUT: 0,
        };

        let secureSocket = true;
        let connected = false;
        let secureError: unknown = null;
        try {
          connected = await device.connect({ ...commonOptions, SECURE_SOCKET: true });
        } catch (error) {
          secureError = error;
        }

        if (!connected) {
          try {
            await device.disconnect();
          } catch {
            // Socket mógł nie zostać utworzony.
          }
          setStatusText(
            `Secure RFCOMM nie połączył się (${errorDescription(
              secureError,
            )}). Próba insecure RFCOMM…`,
          );
          secureSocket = false;
          connected = await device.connect({ ...commonOptions, SECURE_SOCKET: false });
        }

        if (!connected) {
          throw new Error('Biblioteka zwróciła false podczas łączenia SPP.');
        }

        installSppReceiver(device, { ...row, bonded: true }, secureSocket);
      } catch (error) {
        try {
          await device.disconnect();
        } catch {
          // Ignorujemy błąd sprzątania po nieudanym connect.
        }
        connectedSppDeviceRef.current = null;
        connectedTransportRef.current = null;
        resetControlSession();
        connectingRef.current = false;
        setConnectionState('error');
        setErrorText(errorDescription(error));
      }
    },
    [cancelSppDiscovery, installSppReceiver, mergeSppDevices, resetControlSession, stopBleScan],
  );

  const disconnect = useCallback(async () => {
    intentionalDisconnectRef.current = true;
    stopAllScans();
    removeSubscriptions();
    resetControlSession();
    const currentTransport = connectedTransportRef.current;
    connectedTransportRef.current = null;
    connectingRef.current = false;

    setConnectionState('disconnecting');
    if (currentTransport === 'ble') {
      const deviceId = connectedBleDeviceIdRef.current;
      connectedBleDeviceIdRef.current = null;
      if (deviceId !== null) {
        try {
          await manager.cancelDeviceConnection(deviceId);
        } catch {
          // Połączenie mogło już zostać zamknięte przez system.
        }
      }
    } else if (currentTransport === 'spp') {
      const device = connectedSppDeviceRef.current;
      connectedSppDeviceRef.current = null;
      if (device !== null) {
        try {
          await device.disconnect();
        } catch {
          // Połączenie mogło już zostać zamknięte przez system.
        }
      }
    }

    setConnectionState('disconnected');
    selectMainView('connection');
    setStatusText('Rozłączono ręcznie. Możesz ponownie uruchomić skan.');
  }, [manager, removeSubscriptions, resetControlSession, selectMainView, stopAllScans]);

  const changeTransport = useCallback(
    (nextTransport: TransportMode) => {
      if (nextTransport === transportMode || connectedTransportRef.current !== null) {
        return;
      }
      // Zatrzymuj wyłącznie skan aktualnie wybranego transportu. Dzięki temu
      // samo przełączenie BLE <-> SPP nie dotyka natywnego modułu Classic bez
      // potrzeby i bez uprawnień.
      if (transportMode === 'ble') {
        stopBleScan();
      } else {
        void cancelSppDiscovery(true);
      }
      removeSubscriptions();
      resetControlSession();
      connectingRef.current = false;
      setTransportMode(nextTransport);
      selectMainView('connection');
      setConnectionState('idle');
      setConnectedInfo(null);
      setErrorText(null);
      resetStats();
      setStatusText(
        nextTransport === 'ble'
          ? 'Wybrano BLE/GATT. Kliknij „Skanuj BLE”.'
          : 'Wybrano SPP/Classic. Najpierw sparuj moduł w ustawieniach Androida, potem pokaż sparowane urządzenia.',
      );
    },
    [
      cancelSppDiscovery,
      removeSubscriptions,
      resetControlSession,
      resetStats,
      selectMainView,
      stopBleScan,
      transportMode,
    ],
  );

  const startSelectedScan = useCallback(async () => {
    if (transportMode === 'ble') {
      await startBleScan();
    } else {
      await startSppScan();
    }
  }, [startBleScan, startSppScan, transportMode]);

  const stopSelectedScan = useCallback(() => {
    if (transportMode === 'ble') {
      finishBleScan('Skan BLE zatrzymany ręcznie.');
    } else {
      finishSppScan('Skan SPP zatrzymany ręcznie.');
    }
  }, [finishBleScan, finishSppScan, transportMode]);

  const shareReport = useCallback(async () => {
    const infoLines: Array<string | null> = [];
    if (connectedInfo?.transport === 'ble') {
      infoLines.push(
        'transport=BLE_GATT',
        `connected_at=${connectedInfo.connectedAtIso}`,
        `device=${connectedInfo.name} ${connectedInfo.id}`,
        `scan_rssi=${connectedInfo.scanRssi ?? '—'} dBm`,
        `mtu=${connectedInfo.mtu}`,
        `service=${connectedInfo.serviceUuid}`,
        `notify=${connectedInfo.notifyCharacteristicUuid}`,
        `write_service=${connectedInfo.writeServiceUuid ?? '—'}`,
        `write=${connectedInfo.writeCharacteristicUuid ?? '—'}`,
        `write_mode=${connectedInfo.writeMode}`,
      );
    } else if (connectedInfo?.transport === 'spp') {
      infoLines.push(
        'transport=SPP_RFCOMM',
        `connected_at=${connectedInfo.connectedAtIso}`,
        `device=${connectedInfo.name} ${connectedInfo.address}`,
        `scan_rssi=${connectedInfo.scanRssi ?? '—'} dBm`,
        `bonded=${connectedInfo.bonded}`,
        `device_type=${connectedInfo.deviceType}`,
        `secure_socket=${connectedInfo.secureSocket}`,
        `read_size=${connectedInfo.readSize}`,
        `rx_bridge_encoding=${classicRxEncoding}`,
      );
    } else {
      infoLines.push(`transport_selected=${transportMode.toUpperCase()}`, 'device=—');
    }

    const eventName = transportMode === 'ble' ? 'notifications' : 'read_callbacks';
    const channelReportLines = [...liveChannels]
      .sort((a, b) => a.id - b.id)
      .map((channel) => {
        const definition = READABLE_CHANNELS[channel.id];
        const name = definition?.name ?? 'UNDEFINED';
        const value =
          definition === undefined
            ? channel.latestRaw === null
              ? '—'
              : `RAW ${channel.latestRaw}`
            : formatChannelValue(definition, channel.latestRaw);
        return [
          `channel=${channel.id}`,
          `name=${name}`,
          `value=${value}`,
          `raw=${channel.latestRaw ?? '—'}`,
          `recent_hz=${channel.recentRateHz.toFixed(3)}`,
          `avg_hz=${channel.averageRateHz.toFixed(3)}`,
          `count=${channel.count}`,
          `age_ms=${channel.lastSeenAgoMs === null ? '—' : channel.lastSeenAgoMs.toFixed(0)}`,
        ].join(';');
      });

    const report = [
      'ECUMaster BT RX Stats v1.7',
      `generated=${new Date().toISOString()}`,
      `state=${connectionState}`,
      `status=${statusText}`,
      ...infoLines,
      `elapsed_s=${stats.elapsedSeconds.toFixed(3)}`,
      `${eventName}=${stats.notifications}`,
      `${eventName}_per_s_avg=${stats.notificationsPerSecondAverage.toFixed(3)}`,
      `bytes=${stats.bytes}`,
      `bytes_per_s_avg=${stats.bytesPerSecondAverage.toFixed(3)}`,
      `frames=${stats.validFrames}`,
      `frames_per_s_avg=${stats.validFramesPerSecondAverage.toFixed(3)}`,
      `transport_decode_errors=${transportDecodeErrors}`,
      `checksum_errors=${stats.checksumErrors}`,
      `resync_dropped_bytes=${stats.markerResyncDrops}`,
      `carry_bytes=${stats.carryBytes}`,
      `chunks_not_multiple_of_5=${stats.notificationLengthsNotMultipleOf5}`,
      `consecutive_exact_duplicate_chunks=${stats.exactConsecutiveDuplicateNotifications}`,
      `RPM_count=${stats.rpm.count} RPM_avg_hz=${stats.rpm.averageRateHz.toFixed(
        3,
      )} RPM_rate_vs_nominal_pct=${stats.rpm.estimatedDeliveryPercent.toFixed(2)}`,
      `IAT_count=${stats.iat.count} IAT_avg_hz=${stats.iat.averageRateHz.toFixed(
        3,
      )} IAT_rate_vs_nominal_pct=${stats.iat.estimatedDeliveryPercent.toFixed(2)}`,
      `CLT_count=${stats.clt.count} CLT_avg_hz=${stats.clt.averageRateHz.toFixed(
        3,
      )} CLT_rate_vs_nominal_pct=${stats.clt.estimatedDeliveryPercent.toFixed(2)}`,
      `RPM_to_CLT=${stats.rpmToCltRatio ?? '—'}`,
      `IAT_to_CLT=${stats.iatToCltRatio ?? '—'}`,
      `chunk_lengths=${stats.notificationLengthHistogram
        .map(([length, count]) => `${length}:${count}`)
        .join(',')}`,
      `channel_counts=${stats.channelCounts.map(([id, count]) => `${id}:${count}`).join(',')}`,
      `chunk_gap_ms=${JSON.stringify(stats.notificationGapMs)}`,
      `callback_duration_ms=${JSON.stringify(stats.callbackDurationMs)}`,
      `js_event_loop_lag_ms=${JSON.stringify(stats.jsEventLoopLagMs)}`,
      `js_event_loop_lag_max_ms=${stats.maxJsEventLoopLagMs}`,
      `last_rx_callback_age_ms=${stats.lastNotificationAgoMs ?? '—'}`,
      `last_parser_activity_age_ms=${stats.lastParserActivityAgoMs ?? '—'}`,
      `ui_refresh_requested=${uiRefreshDiagnostics.requested}`,
      `ui_refresh_executed=${uiRefreshDiagnostics.executed}`,
      `ui_refresh_committed=${uiRefreshDiagnostics.committed}`,
      `ui_refresh_coalesced=${uiRefreshDiagnostics.coalesced}`,
      `ui_refresh_interval_ms=${JSON.stringify(uiRefreshDiagnostics.actualIntervalMs)}`,
      `ui_refresh_lateness_ms=${JSON.stringify(uiRefreshDiagnostics.latenessMs)}`,
      `ui_snapshot_preparation_ms=${JSON.stringify(uiRefreshDiagnostics.preparationDurationMs)}`,
      `ui_snapshot_commit_delay_ms=${JSON.stringify(uiRefreshDiagnostics.commitDelayMs)}`,
      `ui_rpm_latest_age_ms=${uiRefreshDiagnostics.rpmLatestAgeMs ?? '—'}`,
      `ui_rpm_snapshot_behind_frames=${Math.max(
        0,
        stats.rpm.count - uiRefreshDiagnostics.rpmSnapshotCount,
      )}`,
      `controls_initialized=${controlState.initialized}`,
      `controls_seen_254=${controlState.seenSwitches}`,
      `controls_seen_253=${controlState.seenRotary1234}`,
      `controls_seen_252=${controlState.seenRotary5678}`,
      `switch_mask=0x${controlState.switchesMask.toString(16).padStart(2, '0').toUpperCase()}`,
      `rotary_values=${controlState.rotaryValues.join(',')}`,
      `switch_frame=${frameToHex(controlSynchronizerRef.current.buildSwitchFrame())}`,
      `tx_switch_polls=${txDiagnostics.switchPolls}`,
      `tx_switch_queued=${txDiagnostics.switchFramesQueued}`,
      `tx_switch_sent=${txDiagnostics.switchFramesSent}`,
      `tx_rtt_requests=${txDiagnostics.latencyRequests}`,
      `tx_rtt_queued=${txDiagnostics.latencyRepliesQueued}`,
      `tx_rtt_sent=${txDiagnostics.latencyRepliesSent}`,
      `ble_tx_enabled=${bleTxEnabled}`,
      `requested_connection_priority=${requestedConnectionPriority ?? selectedConnectionPriority}`,
      `connection_priority_request_success=${connectionPriorityRequestSuccess === true}`,
      `connection_priority_request_error=${connectionPriorityRequestError ?? ''}`,
      `tx_suppressed_total=${txDiagnostics.txSuppressedTotal}`,
      `rtt_suppressed=${txDiagnostics.latencyRepliesSuppressed}`,
      `switch_suppressed=${txDiagnostics.switchFramesSuppressed}`,
      `tx_errors=${txDiagnostics.txErrors}`,
      `tx_queue_depth=${txDiagnostics.queueDepth}`,
      `tx_last_kind=${txDiagnostics.lastTxKind ?? '—'}`,
      `tx_last_frame=${txDiagnostics.lastTxHex || '—'}`,
      `tx_last_write_ms=${txDiagnostics.lastWriteDurationMs ?? '—'}`,
      `tx_last_queue_delay_ms=${txDiagnostics.lastQueueDelayMs ?? '—'}`,
      `tx_last_error=${txDiagnostics.lastError ?? '—'}`,
      'channels_begin',
      ...channelReportLines,
      'channels_end',
      connectedInfo?.transport === 'ble'
        ? `characteristics=\n${connectedInfo.characteristicSummary}`
        : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');

    await Share.share({ title: 'ECUMaster BT RX Stats', message: report });
  }, [
    bleTxEnabled,
    classicRxEncoding,
    connectedInfo,
    connectionState,
    connectionPriorityRequestError,
    connectionPriorityRequestSuccess,
    controlState,
    liveChannels,
    requestedConnectionPriority,
    selectedConnectionPriority,
    stats,
    statusText,
    transportDecodeErrors,
    transportMode,
    txDiagnostics,
    uiRefreshDiagnostics,
  ]);

  useEffect(() => {
    void manager.setLogLevel(LogLevel.None).catch(() => undefined);

    let disposed = false;
    let statsTimer: ReturnType<typeof setTimeout> | null = null;
    let channelUiTimer: ReturnType<typeof setTimeout> | null = null;
    let frameRateChartTimer: ReturnType<typeof setTimeout> | null = null;
    let lagTimer: ReturnType<typeof setTimeout> | null = null;

    const refreshStats = () => {
      if (disposed) return;
      const nowMs = monotonicNowMs();
      setStats(collectorRef.current.snapshot(nowMs));
      setTransportDecodeErrors(transportDecodeErrorsRef.current);
      setClassicRxEncoding(classicRxEncodingRef.current);
      setUiRefreshDiagnostics(uiRefreshDiagnosticsRef.current.snapshot(nowMs));
      setTxDiagnostics(
        txDiagnosticsSnapshot(
          txDiagnosticsRef.current,
          nowMs,
          highPriorityTxQueueRef.current.length + normalPriorityTxQueueRef.current.length,
        ),
      );
      if (controlStateDirtyRef.current) {
        controlStateDirtyRef.current = false;
        setControlState(controlSynchronizerRef.current.snapshot());
      }
      statsTimer = setTimeout(refreshStats, BLE_CONFIG.uiRefreshMs);
    };
    statsTimer = setTimeout(refreshStats, BLE_CONFIG.uiRefreshMs);

    let nextChannelRefreshAtMs = monotonicNowMs() + BLE_CONFIG.channelUiRefreshMs;
    const scheduleChannelRefresh = () => {
      if (disposed || channelUiTimer !== null || channelUiCommitPendingRef.current) return;
      const delayMs = Math.max(0, nextChannelRefreshAtMs - monotonicNowMs());
      channelUiTimer = setTimeout(() => {
        channelUiTimer = null;
        if (disposed) return;

        const startedAtMs = monotonicNowMs();
        if (
          mainViewRef.current !== 'channels' ||
          connectedTransportRef.current === null
        ) {
          uiRefreshDiagnosticsRef.current.markInactive();
          nextChannelRefreshAtMs = startedAtMs + BLE_CONFIG.channelUiRefreshMs;
          scheduleChannelRefresh();
          return;
        }

        const channels = collectorRef.current.liveChannelsSnapshot(startedAtMs);
        const preparationDurationMs = monotonicNowMs() - startedAtMs;
        uiRefreshDiagnosticsRef.current.recordExecution(
          startedAtMs,
          preparationDurationMs,
          collectorRef.current.latestChannelAgeMs(1, startedAtMs),
          rpmSnapshotCount(channels),
        );
        channelUiCommitPendingRef.current = true;
        nextChannelRefreshAtMs = startedAtMs + BLE_CONFIG.channelUiRefreshMs;
        setLiveChannels(channels);
        // Następny timeout ustawia useEffect po commitcie tej kopii React.
      }, delayMs);
    };
    scheduleChannelUiRefreshRef.current = scheduleChannelRefresh;
    scheduleChannelRefresh();

    const refreshFrameRateChart = () => {
      if (disposed) return;
      const currentFrameCount = collectorRef.current.getValidFrameCount();
      const framesSinceLastSample = Math.max(
        0,
        currentFrameCount - lastChartFrameCountRef.current,
      );
      lastChartFrameCountRef.current = currentFrameCount;

      const connected = connectedTransportRef.current !== null;
      if (connected && frameRateRangeSamplingReadyRef.current) {
        setFrameRateRange((previous) => ({
          min:
            previous.min === null
              ? framesSinceLastSample
              : Math.min(previous.min, framesSinceLastSample),
          max:
            previous.max === null
              ? framesSinceLastSample
              : Math.max(previous.max, framesSinceLastSample),
        }));
      }
      frameRateRangeSamplingReadyRef.current = connected;

      setFrameRateHistory((previous) => [
        ...previous.slice(-(FRAME_RATE_CHART_SECONDS - 1)),
        framesSinceLastSample,
      ]);
      frameRateChartTimer = setTimeout(refreshFrameRateChart, 1000);
    };
    frameRateChartTimer = setTimeout(refreshFrameRateChart, 1000);

    const lagIntervalMs = 100;
    let nextExpected = monotonicNowMs() + lagIntervalMs;
    const sampleEventLoopLag = () => {
      if (disposed) return;
      const now = monotonicNowMs();
      const lag = Math.max(0, now - nextExpected);
      collectorRef.current.recordJsEventLoopLag(lag);
      nextExpected += lagIntervalMs;
      if (now - nextExpected > lagIntervalMs * 5) {
        nextExpected = now + lagIntervalMs;
      }
      lagTimer = setTimeout(sampleEventLoopLag, Math.max(0, nextExpected - monotonicNowMs()));
    };
    lagTimer = setTimeout(sampleEventLoopLag, lagIntervalMs);

    return () => {
      disposed = true;
      intentionalDisconnectRef.current = true;
      if (statsTimer !== null) clearTimeout(statsTimer);
      if (channelUiTimer !== null) clearTimeout(channelUiTimer);
      if (frameRateChartTimer !== null) clearTimeout(frameRateChartTimer);
      if (lagTimer !== null) clearTimeout(lagTimer);
      channelUiCommitPendingRef.current = false;
      scheduleChannelUiRefreshRef.current = null;
      stopBleScan();
      void cancelSppDiscovery(true);
      removeSubscriptions();
      const bleDeviceId = connectedBleDeviceIdRef.current;
      if (bleDeviceId !== null) {
        void manager.cancelDeviceConnection(bleDeviceId).catch(() => undefined);
      }
      const sppDevice = connectedSppDeviceRef.current;
      if (sppDevice !== null) {
        void sppDevice.disconnect().catch(() => undefined);
      }
      void manager.destroy().catch(() => undefined);
    };
  }, [cancelSppDiscovery, manager, removeSubscriptions, stopBleScan]);

  useEffect(() => {
    if (!channelUiCommitPendingRef.current) return;
    channelUiCommitPendingRef.current = false;
    uiRefreshDiagnosticsRef.current.recordCommit(monotonicNowMs());
    scheduleChannelUiRefreshRef.current?.();
  }, [liveChannels]);

  const isConnectionBusy = [
    'waiting-for-bluetooth',
    'pairing',
    'connecting',
    'discovering',
    'subscribing',
    'receiving',
    'disconnecting',
  ].includes(connectionState);
  const hasActiveConnection =
    connectedTransportRef.current !== null || connectionState === 'receiving';
  const canSwitchTransport =
    !isConnectionBusy && connectionState !== 'scanning' && !hasActiveConnection;
  const canStartScan =
    !isConnectionBusy && connectionState !== 'scanning' && !hasActiveConnection;
  const canConnectFromList = !connectingRef.current && !hasActiveConnection;
  const canDisconnect = isConnectionBusy || hasActiveConnection;
  const canChangeConnectionPriority = !isConnectionBusy && !hasActiveConnection;
  const txWritable =
    connectedInfo?.transport === 'spp' ||
    (connectedInfo?.transport === 'ble' && connectedInfo.writeMode !== 'unavailable');
  const controlsInteractive =
    connectionState === 'receiving' && controlState.initialized && txWritable;
  const currentSwitchFrameHex = frameToHex(
    controlSynchronizerRef.current.buildSwitchFrame(),
  );

  const eventLabel = transportMode === 'ble' ? 'notifications' : 'SPP read callbacks';
  const callbackLabel = transportMode === 'ble' ? 'BLE callback' : 'SPP callback';
  const histogramText =
    stats.notificationLengthHistogram.length === 0
      ? '—'
      : stats.notificationLengthHistogram
          .map(([length, count]) => `${length} B: ${count}`)
          .join(' | ');

  const channelTileModels = useMemo<ChannelTileModel[]>(() => {
    const liveById = new Map<number, ChannelLiveSnapshot>();
    for (const channel of liveChannels) {
      liveById.set(channel.id, channel);
    }

    const models: ChannelTileModel[] = READABLE_CHANNEL_LIST.map((definition) => {
      const live = liveById.get(definition.id);
      const rate = live?.recentRateHz ?? 0;
      const effectiveRate = rate > 0 ? rate : live?.averageRateHz ?? 0;
      const staleThresholdMs =
        effectiveRate > 0 ? Math.max(500, (1000 / effectiveRate) * 4) : 2000;
      return {
        id: definition.id,
        name: definition.name,
        valueText: formatChannelValue(definition, live?.latestRaw ?? null),
        rateText: live === undefined ? '— Hz' : `${formatNumber(rate, 2)} Hz`,
        active: live !== undefined,
        stale:
          live?.lastSeenAgoMs !== null &&
          live?.lastSeenAgoMs !== undefined &&
          live.lastSeenAgoMs > staleThresholdMs,
        unknown: false,
      };
    });

    const unknownChannels = liveChannels
      .filter((channel) => READABLE_CHANNELS[channel.id] === undefined)
      .sort((a, b) => a.id - b.id);

    for (const live of unknownChannels) {
      const effectiveRate = live.recentRateHz > 0 ? live.recentRateHz : live.averageRateHz;
      const staleThresholdMs =
        effectiveRate > 0 ? Math.max(500, (1000 / effectiveRate) * 4) : 2000;
      models.push({
        id: live.id,
        name: 'Kanał niezdefiniowany',
        valueText: live.latestRaw === null ? '—' : `RAW ${live.latestRaw}`,
        rateText: `${formatNumber(live.recentRateHz, 2)} Hz`,
        active: true,
        stale:
          live.lastSeenAgoMs !== null && live.lastSeenAgoMs > staleThresholdMs,
        unknown: true,
      });
    }

    return models;
  }, [liveChannels]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#f2f3f5" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>ECUMaster BT RX Stats v1.7</Text>
        <Text style={styles.subtitle}>
          Miernik RX/TX dla BLE/GATT i SPP/RFCOMM. Oprócz kanałów i statystyk obsługuje 8 przełączników, 8 wartości rotary 0–15 oraz natychmiastową odpowiedź RTT po odebraniu kanału 99.
        </Text>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Widok</Text>
          <View style={styles.mainViewRow}>
            {([
              ['connection', 'Połączenie'],
              ['channels', 'Kanały'],
              ['controls', 'Sterowanie'],
              ['statistics', 'Statystyki'],
            ] as const).map(([view, label]) => (
              <Pressable
                key={view}
                onPress={() => selectMainView(view)}
                style={[
                  styles.mainViewButton,
                  mainView === view && styles.transportSelected,
                ]}
              >
                <Text
                  style={[
                    styles.mainViewButtonText,
                    mainView === view && styles.transportSelectedText,
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.note}>
            {transportMode.toUpperCase()} | stan: {connectionState} | {statusText}
          </Text>
        </View>

        {mainView === 'connection' ? (
          <>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Wybór transportu</Text>
          <View style={styles.transportRow}>
            <Pressable
              onPress={() => changeTransport('ble')}
              disabled={!canSwitchTransport}
              style={[
                styles.transportButton,
                transportMode === 'ble' && styles.transportSelected,
                !canSwitchTransport && styles.disabledControl,
              ]}
            >
              <Text
                style={[
                  styles.transportText,
                  transportMode === 'ble' && styles.transportSelectedText,
                ]}
              >
                BLE / GATT
              </Text>
            </Pressable>
            <Pressable
              onPress={() => changeTransport('spp')}
              disabled={!canSwitchTransport}
              style={[
                styles.transportButton,
                transportMode === 'spp' && styles.transportSelected,
                !canSwitchTransport && styles.disabledControl,
              ]}
            >
              <Text
                style={[
                  styles.transportText,
                  transportMode === 'spp' && styles.transportSelectedText,
                ]}
              >
                SPP / RFCOMM
              </Text>
            </Pressable>
          </View>
          <Text style={styles.note}>
            Wybrano: {transportMode === 'ble' ? 'BLE/GATT' : 'SPP/RFCOMM'}. Transport można zmienić po zatrzymaniu skanu lub rozłączeniu.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Połączenie</Text>
          {transportMode === 'ble' ? (
            <View style={styles.diagnosticOptions}>
              <View style={styles.optionRow}>
                <Text style={styles.transportText}>BLE TX: {bleTxEnabled ? 'ON' : 'OFF'}</Text>
                <Switch value={bleTxEnabled} onValueChange={changeBleTxEnabled} />
              </View>
              <Text style={styles.transportText}>BLE CONNECTION PRIORITY</Text>
              <View style={styles.transportRow}>
                {BLE_CONNECTION_PRIORITIES.map((priority) => (
                  <Pressable
                    key={priority.name}
                    onPress={() => setSelectedConnectionPriority(priority.name)}
                    disabled={!canChangeConnectionPriority}
                    style={[
                      styles.priorityButton,
                      selectedConnectionPriority === priority.name && styles.transportSelected,
                      !canChangeConnectionPriority && styles.disabledControl,
                    ]}
                  >
                    <Text
                      style={[
                        styles.priorityButtonText,
                        selectedConnectionPriority === priority.name && styles.transportSelectedText,
                      ]}
                    >
                      {priority.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.mono}>wybrany: {selectedConnectionPriority}</Text>
              <Text style={styles.mono}>
                zażądany: {requestedConnectionPriority ?? '—'} | wynik:{' '}
                {connectionPriorityRequestSuccess === null
                  ? '—'
                  : connectionPriorityRequestSuccess
                    ? 'OK'
                    : 'BŁĄD'}
              </Text>
              {connectionPriorityRequestError !== null ? (
                <Text style={styles.error}>Priority request: {connectionPriorityRequestError}</Text>
              ) : null}
              <Text style={styles.note}>
                Priority można zmienić przed połączeniem BLE. TX OFF blokuje wyłącznie fizyczne zapisy BLE; RX i SPP pozostają aktywne.
              </Text>
            </View>
          ) : null}
          <Text style={styles.status}>{connectionState}</Text>
          <Text style={styles.bodyText}>{statusText}</Text>
          {[
            'waiting-for-bluetooth',
            'scanning',
            'pairing',
            'connecting',
            'discovering',
            'subscribing',
          ].includes(connectionState) ? (
            <ActivityIndicator style={styles.spinner} />
          ) : null}
          {errorText !== null ? <Text style={styles.error}>{errorText}</Text> : null}

          {connectedInfo?.transport === 'ble' ? (
            <View style={styles.infoBlock}>
              <Text style={styles.mono}>transport: BLE/GATT</Text>
              <Text style={styles.mono}>device: {connectedInfo.name}</Text>
              <Text style={styles.mono}>id: {connectedInfo.id}</Text>
              <Text style={styles.mono}>scan RSSI: {connectedInfo.scanRssi ?? '—'} dBm</Text>
              <Text style={styles.mono}>MTU reported: {connectedInfo.mtu}</Text>
              <Text style={styles.mono}>service: {connectedInfo.serviceUuid}</Text>
              <Text style={styles.mono}>notify: {connectedInfo.notifyCharacteristicUuid}</Text>
              <Text style={styles.mono}>
                write service: {connectedInfo.writeServiceUuid ?? '—'}
              </Text>
              <Text style={styles.mono}>
                write: {connectedInfo.writeCharacteristicUuid ?? '—'} | mode: {connectedInfo.writeMode}
              </Text>
            </View>
          ) : null}

          {connectedInfo?.transport === 'spp' ? (
            <View style={styles.infoBlock}>
              <Text style={styles.mono}>transport: SPP/RFCOMM</Text>
              <Text style={styles.mono}>device: {connectedInfo.name}</Text>
              <Text style={styles.mono}>address: {connectedInfo.address}</Text>
              <Text style={styles.mono}>type: {connectedInfo.deviceType}</Text>
              <Text style={styles.mono}>socket: {connectedInfo.secureSocket ? 'secure' : 'insecure'}</Text>
              <Text style={styles.mono}>READ_SIZE: {connectedInfo.readSize}</Text>
              <Text style={styles.mono}>bridge encoding: {classicRxEncoding}</Text>
            </View>
          ) : null}

          <View style={styles.buttonRow}>
            <View style={styles.buttonCell}>
              <Button
                title={transportMode === 'ble' ? 'Skanuj BLE' : 'Pokaż sparowane SPP'}
                onPress={() => void startSelectedScan()}
                disabled={!canStartScan}
              />
            </View>
            <View style={styles.buttonCell}>
              <Button
                title="Zatrzymaj skan"
                onPress={stopSelectedScan}
                disabled={connectionState !== 'scanning'}
              />
            </View>
          </View>
          <View style={styles.buttonRow}>
            <View style={styles.buttonCell}>
              <Button title="Rozłącz" onPress={() => void disconnect()} disabled={!canDisconnect} />
            </View>
            <View style={styles.buttonCell}>
              <Button title="Reset statystyk" onPress={resetStats} />
            </View>
          </View>
          <View style={styles.singleButtonRow}>
            <Button title="Udostępnij raport" onPress={() => void shareReport()} />
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            {transportMode === 'ble' ? 'Znalezione urządzenia BLE' : 'Urządzenia SPP / Classic'} ({
              transportMode === 'ble' ? bleScanDevices.length : sppScanDevices.length
            })
          </Text>

          {transportMode === 'ble' ? (
            <Text style={styles.note}>
              Lista nie filtruje po nazwie, MAC ani UUID. Najsilniejsze urządzenia są na górze.
            </Text>
          ) : (
            <Text style={styles.note}>
              SPP korzysta z urządzeń już sparowanych. Jeśli modułu nie ma na liście, sparuj go najpierw w Ustawieniach Androida → Bluetooth.
            </Text>
          )}

          {connectionState === 'scanning' ? <ActivityIndicator style={styles.spinner} /> : null}

          {transportMode === 'ble' ? (
            bleScanDevices.length === 0 ? (
              <Text style={styles.note}>
                {connectionState === 'scanning'
                  ? 'Czekam na advertisementy BLE…'
                  : 'Brak wyników. Kliknij „Skanuj BLE”.'}
              </Text>
            ) : (
              bleScanDevices.map((device) => (
                <View key={device.id} style={styles.deviceBox}>
                  <Text style={styles.deviceName}>{bleDeviceDisplayName(device)}</Text>
                  {device.name !== null &&
                  device.localName !== null &&
                  device.name !== device.localName ? (
                    <Text style={styles.mono}>name: {device.name}</Text>
                  ) : null}
                  <Text style={styles.mono}>id: {device.id}</Text>
                  <Text style={styles.mono}>
                    RSSI: {device.rssi ?? '—'} dBm | connectable:{' '}
                    {device.isConnectable === null ? '—' : device.isConnectable ? 'yes' : 'no'}
                  </Text>
                  <Text style={styles.mono}>
                    advertised services:{' '}
                    {device.serviceUUIDs === null || device.serviceUUIDs.length === 0
                      ? '—'
                      : device.serviceUUIDs.join(', ')}
                  </Text>
                  <View style={styles.deviceButton}>
                    <Button
                      title="Połącz BLE z tym urządzeniem"
                      onPress={() => void connectSelectedBleDevice(device.id)}
                      disabled={!canConnectFromList}
                    />
                  </View>
                </View>
              ))
            )
          ) : sppScanDevices.length === 0 ? (
            <Text style={styles.note}>
              {connectionState === 'scanning'
                ? 'Odczytuję listę sparowanych urządzeń…'
                : 'Brak wyników. Sparuj moduł w ustawieniach Androida, potem kliknij „Pokaż sparowane SPP”.'}
            </Text>
          ) : (
            sppScanDevices.map((device) => (
              <View key={device.address} style={styles.deviceBox}>
                <Text style={styles.deviceName}>{device.name}</Text>
                <Text style={styles.mono}>address: {device.address}</Text>
                <Text style={styles.mono}>
                  bonded: {device.bonded ? 'yes' : 'no'} | type: {device.type} | RSSI:{' '}
                  {device.rssi ?? '—'} dBm
                </Text>
                <View style={styles.deviceButton}>
                  <Button
                    title="Połącz SPP z tym urządzeniem"
                    onPress={() => void connectSelectedSppDevice(device.address)}
                    disabled={!canConnectFromList}
                  />
                </View>
              </View>
            ))
          )}
        </View>

          </>
        ) : null}

        {mainView === 'channels' ? (
          <>
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Kanały na żywo</Text>
              <Text style={styles.note}>
                Trzy kanały w każdym rzędzie. Częstotliwość w nawiasie jest liczona z ostatnich 5 s. Odbiór i parser działają natychmiast dla każdego callbacku; interfejs pobiera najnowszy stan co {BLE_CONFIG.channelUiRefreshMs} ms ({(1000 / BLE_CONFIG.channelUiRefreshMs).toFixed(0)} Hz), żeby nie generować setState dla każdej z około 675 ramek/s.
              </Text>
              <Text style={styles.mono}>
                aktywne ID: {liveChannels.length} | opisane w TypeScript: {READABLE_CHANNEL_LIST.length} | transport: {transportMode.toUpperCase()}
              </Text>
              <Text style={styles.mono}>
                RPM latest age: {formatNumber(uiRefreshDiagnostics.rpmLatestAgeMs, 0)} ms | UI
                coalesced: {uiRefreshDiagnostics.coalesced}
              </Text>
              <View style={styles.buttonRow}>
                <View style={styles.buttonCell}>
                  <Button title="Rozłącz" onPress={() => void disconnect()} disabled={!canDisconnect} />
                </View>
                <View style={styles.buttonCell}>
                  <Button title="Reset statystyk" onPress={resetStats} />
                </View>
              </View>
              <View style={styles.singleButtonRow}>
                <Button title="Udostępnij raport" onPress={() => void shareReport()} />
              </View>
            </View>

            <View style={[styles.card, styles.channelDashboardCard]}>
              <View style={styles.channelGrid}>
                {channelTileModels.map((model) => (
                  <ChannelTile key={model.id} model={model} compact={compactChannelGrid} />
                ))}
              </View>
              <Text style={styles.note}>
                Szare pola nie zostały jeszcze odebrane. Żółte pola to aktywne ID bez definicji w EcumasterDASHPro.ts. Czerwone obramowanie oznacza kanał chwilowo nieaktualny względem jego zmierzonej częstotliwości. Najczytelniejszy układ uzyskasz po obróceniu telefonu poziomo.
              </Text>
            </View>
          </>
        ) : null}

        {mainView === 'controls' ? (
          <>
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Synchronizacja sterowania i TX</Text>
              <Text style={styles.mono}>
                transport: {connectedInfo?.transport?.toUpperCase() ?? '—'} | TX:{' '}
                {txWritable ? 'gotowy' : 'niedostępny'}
              </Text>
              <Text style={styles.mono}>
                ID 254 switches: {controlState.seenSwitches ? 'OK' : 'czekam'} | ID 253 rotary 1–4:{' '}
                {controlState.seenRotary1234 ? 'OK' : 'czekam'} | ID 252 rotary 5–8:{' '}
                {controlState.seenRotary5678 ? 'OK' : 'czekam'}
              </Text>
              <Text style={styles.mono}>
                stan inicjalny: {controlState.initialized ? 'GOTOWY' : 'NIEGOTOWY'} | maska:{' '}
                0x{controlState.switchesMask.toString(16).padStart(2, '0').toUpperCase()}
              </Text>
              <Text style={styles.mono}>następna ramka 0x55: {currentSwitchFrameHex}</Text>
              <Text style={styles.note}>
                Aplikacja najpierw jednorazowo odczytuje stan z kanałów 254, 253 i 252. Po
                inicjalizacji każde kolejne odebranie ID 254 kolejkuje aktualną 8-bajtową ramkę
                magic=0x55. Naciśnięcie przycisku zmienia stan lokalny; transmisja następuje przy
                następnym ID 254. Każde ID 99 natychmiast kolejkuje odpowiedź magic=0x56 z
                priorytetem przed ramkami switchy.
              </Text>
              <View style={styles.buttonRow}>
                <View style={styles.buttonCell}>
                  <Button
                    title="Synchronizuj ponownie"
                    onPress={resynchronizeControls}
                    disabled={!hasActiveConnection}
                  />
                </View>
                <View style={styles.buttonCell}>
                  <Button title="Udostępnij raport" onPress={() => void shareReport()} />
                </View>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>8 switchy On / Off</Text>
              <View style={styles.binaryControlGrid}>
                {Array.from({ length: 8 }, (_, index) => {
                  const isOn = (controlState.switchesMask & (1 << index)) !== 0;
                  return (
                    <Pressable
                      key={`switch-${index}`}
                      disabled={!controlsInteractive}
                      onPress={() => toggleControlSwitch(index)}
                      style={[
                        styles.binaryControl,
                        isOn ? styles.binaryControlOn : styles.binaryControlOff,
                        !controlsInteractive && styles.disabledControl,
                      ]}
                    >
                      <Text style={styles.controlName}>Switch {index + 1}</Text>
                      <Text
                        style={[
                          styles.binaryControlValue,
                          isOn ? styles.binaryControlValueOn : styles.binaryControlValueOff,
                        ]}
                      >
                        {isOn ? 'ON' : 'OFF'}
                      </Text>
                      <Text style={styles.controlHint}>bit {index}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>8 rotary 4-bit, zakres 0–15</Text>
              <Text style={styles.note}>
                Każde naciśnięcie zwiększa wartość o 1; po 15 następuje zawinięcie do 0.
              </Text>
              <View style={styles.rotaryControlGrid}>
                {controlState.rotaryValues.map((value, index) => (
                  <Pressable
                    key={`rotary-${index}`}
                    disabled={!controlsInteractive}
                    onPress={() => incrementControlRotary(index)}
                    style={[
                      styles.rotaryControl,
                      !controlsInteractive && styles.disabledControl,
                    ]}
                  >
                    <Text style={styles.controlName}>Rotary {index + 1}</Text>
                    <Text style={styles.rotaryControlValue}>{value}</Text>
                    <Text style={styles.controlHint}>naciśnij +1</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Statystyki TX i round-trip</Text>
              <Text style={styles.mono}>
                ID 254 polls: {txDiagnostics.switchPolls} | status queued:{' '}
                {txDiagnostics.switchFramesQueued} | sent: {txDiagnostics.switchFramesSent}
              </Text>
              <Text style={styles.mono}>
                ID 99 requests: {txDiagnostics.latencyRequests} | replies queued:{' '}
                {txDiagnostics.latencyRepliesQueued} | sent: {txDiagnostics.latencyRepliesSent}
              </Text>
              <Text style={styles.mono}>
                queue depth: {txDiagnostics.queueDepth} | TX errors: {txDiagnostics.txErrors}
              </Text>
              <Text style={styles.mono}>
                TX suppressed total: {txDiagnostics.txSuppressedTotal}
              </Text>
              <Text style={styles.mono}>
                RTT replies suppressed: {txDiagnostics.latencyRepliesSuppressed} | switch frames suppressed:{' '}
                {txDiagnostics.switchFramesSuppressed}
              </Text>
              <Text style={styles.mono}>
                last: {txDiagnostics.lastTxKind ?? '—'} | age:{' '}
                {formatNumber(txDiagnostics.lastTxAgoMs, 1)} ms | write:{' '}
                {formatNumber(txDiagnostics.lastWriteDurationMs, 2)} ms | queue delay:{' '}
                {formatNumber(txDiagnostics.lastQueueDelayMs, 2)} ms
              </Text>
              <Text style={styles.mono}>last frame: {txDiagnostics.lastTxHex || '—'}</Text>
              {txDiagnostics.lastError !== null ? (
                <Text style={styles.error}>TX: {txDiagnostics.lastError}</Text>
              ) : null}
              <Text style={styles.note}>
                Odpowiedź RTT ma bajty: 08 56 CF 00 00 00 00 2D. Wartość -49 jest kodowana
                jako uint8_t 0xCF, a checksum jest sumą pierwszych siedmiu bajtów modulo 256.
              </Text>
            </View>
          </>
        ) : null}

        {mainView === 'statistics' ? (
          <>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Kanały odebrane na sekundę</Text>
          <FrameRateChart samples={frameRateHistory} />
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Transport</Text>
          <Text style={styles.mono}>czas: {formatNumber(stats.elapsedSeconds, 1)} s</Text>
          <Text style={styles.mono}>
            {eventLabel}: {stats.notifications} | avg{' '}
            {formatNumber(stats.notificationsPerSecondAverage, 2)}/s | last 1s{' '}
            {stats.notificationsPerSecond1s}/s
          </Text>
          <Text style={styles.mono}>
            bytes: {stats.bytes} | avg {formatNumber(stats.bytesPerSecondAverage, 1)} B/s | last 1s{' '}
            {stats.bytesPerSecond1s} B/s
          </Text>
          <Text style={styles.mono}>
            valid frames: {stats.validFrames} | avg{' '}
            {formatNumber(stats.validFramesPerSecondAverage, 2)}/s | last 1s{' '}
            {stats.validFramesPerSecond1s}/s
          </Text>
          <Text style={styles.mono}>
            valid frames/s min: {formatNumber(frameRateRange.min, 0)} | max:{' '}
            {formatNumber(frameRateRange.max, 0)}
          </Text>
          <Text style={styles.mono}>length histogram: {histogramText}</Text>
          <Text style={styles.mono}>active channel IDs: {stats.channelCounts.length}</Text>
          <Text style={styles.mono}>
            callback gaps [ms]: {formatDistribution(stats.notificationGapMs)}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Integralność parsera</Text>
          <Text style={styles.mono}>transport decode errors: {transportDecodeErrors}</Text>
          <Text style={styles.mono}>checksum errors: {stats.checksumErrors}</Text>
          <Text style={styles.mono}>resync dropped bytes: {stats.markerResyncDrops}</Text>
          <Text style={styles.mono}>carry bytes: {stats.carryBytes}</Text>
          <Text style={styles.mono}>
            chunk len % 5 != 0: {stats.notificationLengthsNotMultipleOf5}
          </Text>
          <Text style={styles.mono}>
            exact consecutive duplicate chunks: {stats.exactConsecutiveDuplicateNotifications}
          </Text>
          {transportMode === 'spp' ? (
            <Text style={styles.note}>
              W SPP granice callbacków są dowolne, dlatego długość niepodzielna przez 5 jest normalna. Parser zachowuje końcówkę i łączy ją z następnym callbackiem.
            </Text>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>TX: switch status i RTT</Text>
          <Text style={styles.mono}>
            control initialized: {controlState.initialized ? 'yes' : 'no'} | TX ready:{' '}
            {txWritable ? 'yes' : 'no'} | queue: {txDiagnostics.queueDepth}
          </Text>
          <Text style={styles.mono}>
            switch polls/queued/sent: {txDiagnostics.switchPolls}/
            {txDiagnostics.switchFramesQueued}/{txDiagnostics.switchFramesSent}
          </Text>
          <Text style={styles.mono}>
            RTT requests/queued/sent: {txDiagnostics.latencyRequests}/
            {txDiagnostics.latencyRepliesQueued}/{txDiagnostics.latencyRepliesSent}
          </Text>
          <Text style={styles.mono}>
            TX suppressed total: {txDiagnostics.txSuppressedTotal}
          </Text>
          <Text style={styles.mono}>
            RTT replies suppressed: {txDiagnostics.latencyRepliesSuppressed} | switch frames suppressed:{' '}
            {txDiagnostics.switchFramesSuppressed}
          </Text>
          <Text style={styles.mono}>
            TX errors: {txDiagnostics.txErrors} | last write:{' '}
            {formatNumber(txDiagnostics.lastWriteDurationMs, 2)} ms | queue delay:{' '}
            {formatNumber(txDiagnostics.lastQueueDelayMs, 2)} ms
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Kanały kontrolne</Text>
          <ChannelRow label="RPM" value={stats.rpm} />
          <ChannelRow label="IAT" value={stats.iat} />
          <ChannelRow label="CLT" value={stats.clt} />
          <Text style={styles.mono}>RPM / CLT = {formatNumber(stats.rpmToCltRatio, 3)}</Text>
          <Text style={styles.mono}>IAT / CLT = {formatNumber(stats.iatToCltRatio, 3)}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Obciążenie aplikacji</Text>
          <Text style={styles.mono}>
            {callbackLabel} [ms]: {formatDistribution(stats.callbackDurationMs)}
          </Text>
          <Text style={styles.mono}>
            JS event-loop lag [ms]: {formatDistribution(stats.jsEventLoopLagMs)}
          </Text>
          <Text style={styles.mono}>
            maksymalny JS event-loop lag od resetu: {formatNumber(stats.maxJsEventLoopLagMs, 1)} ms
          </Text>
          <Text style={styles.note}>
            Widok statystyk odświeża się 2 razy/s, a widok kanałów maksymalnie 25 razy/s.
            Callback odbiorczy dekoduje dane, aktualizuje latest-state i kolejkuje krótkie ramki
            TX; zapis do BLE/SPP jest serializowany poza parserem.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Diagnostyka backlogu RX / UI</Text>
          <Text style={styles.mono}>
            RX callbacks total: {stats.notifications} | callbacks/s: {stats.notificationsPerSecond1s}
          </Text>
          <Text style={styles.mono}>
            parsed frames/s: {stats.validFramesPerSecond1s} | last RX callback age:{' '}
            {formatNumber(stats.lastNotificationAgoMs, 0)} ms | last parser activity age:{' '}
            {formatNumber(stats.lastParserActivityAgoMs, 0)} ms
          </Text>
          <Text style={styles.mono}>
            UI refresh requested/executed/committed: {uiRefreshDiagnostics.requested}/
            {uiRefreshDiagnostics.executed}/{uiRefreshDiagnostics.committed} | coalesced:{' '}
            {uiRefreshDiagnostics.coalesced}
          </Text>
          <Text style={styles.mono}>
            UI actual interval [ms]: {formatDistribution(uiRefreshDiagnostics.actualIntervalMs)}
          </Text>
          <Text style={styles.mono}>
            UI lateness vs {BLE_CONFIG.channelUiRefreshMs} ms:{' '}
            {formatDistribution(uiRefreshDiagnostics.latenessMs)}
          </Text>
          <Text style={styles.mono}>
            snapshot preparation [ms]:{' '}
            {formatDistribution(uiRefreshDiagnostics.preparationDurationMs)}
          </Text>
          <Text style={styles.mono}>
            React commit delay [ms]: {formatDistribution(uiRefreshDiagnostics.commitDelayMs)}
          </Text>
          <Text style={styles.mono}>
            RPM latest age: {formatNumber(uiRefreshDiagnostics.rpmLatestAgeMs, 0)} ms | UI
            snapshot behind store: {Math.max(
              0,
              stats.rpm.count - uiRefreshDiagnostics.rpmSnapshotCount,
            )}{' '}
            ramek
          </Text>
          <Text style={styles.note}>
            Liczniki requested/coalesced odnoszą się do nominalnych slotów 40 ms. Następny
            snapshot jest planowany dopiero po commitcie poprzedniego, więc aplikacja nie odtwarza
            opuszczonych stanów po kolei.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Założenia testu</Text>
          {transportMode === 'ble' ? (
            <>
              <Text style={styles.mono}>transport: BLE/GATT notifications</Text>
              <Text style={styles.mono}>scan filter: NONE</Text>
              <Text style={styles.mono}>scan mode: LowLatency</Text>
              <Text style={styles.mono}>requested MTU: {BLE_CONFIG.requestedMtu}</Text>
              <Text style={styles.mono}>
                connection priority selected/requested: {selectedConnectionPriority}/
                {requestedConnectionPriority ?? '—'} | success:{' '}
                {connectionPriorityRequestSuccess === null
                  ? '—'
                  : connectionPriorityRequestSuccess
                    ? 'yes'
                    : 'no'}
              </Text>
              <Text style={styles.mono}>BLE TX: {bleTxEnabled ? 'ON' : 'OFF'}</Text>
              <Text style={styles.mono}>
                write characteristic: {connectedInfo?.transport === 'ble' ? connectedInfo.writeCharacteristicUuid ?? '—' : '—'}
              </Text>
              <Text style={styles.mono}>
                write mode: {connectedInfo?.transport === 'ble' ? connectedInfo.writeMode : '—'}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.mono}>transport: Bluetooth Classic SPP/RFCOMM</Text>
              <Text style={styles.mono}>device discovery: bonded devices only</Text>
              <Text style={styles.mono}>connection type: binary</Text>
              <Text style={styles.mono}>READ_SIZE: {SPP_READ_SIZE}</Text>
              <Text style={styles.mono}>READ_TIMEOUT: 0</Text>
              <Text style={styles.mono}>secure socket with insecure fallback</Text>
              <Text style={styles.mono}>RX bridge encoding: {classicRxEncoding}</Text>
            </>
          )}
          <Text style={styles.mono}>
            expected: RPM {BLE_CONFIG.expectedRatesHz.rpm} Hz, IAT/CLT{' '}
            {BLE_CONFIG.expectedRatesHz.clt} Hz
          </Text>
          <Text style={styles.mono}>
            TX protocol: 8 B | magic 0x55 switch status | magic 0x56 RTT reply
          </Text>
          <Text style={styles.note}>
            „rate vs nominal” jest estymacją z deklarowanych częstotliwości. Bez licznika sekwencyjnego w protokole nie da się bezpośrednio policzyć utraconych pakietów.
          </Text>
        </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f2f3f5',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0,
  },
  container: {
    padding: 14,
    paddingBottom: 40,
    gap: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111827',
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: '#374151',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 2,
    color: '#111827',
  },
  status: {
    fontWeight: '700',
    textTransform: 'uppercase',
    color: '#111827',
  },
  bodyText: {
    color: '#111827',
  },
  spinner: {
    marginVertical: 6,
  },
  error: {
    color: '#b00020',
    fontWeight: '600',
  },
  infoBlock: {
    marginTop: 4,
    gap: 2,
  },
  diagnosticOptions: {
    gap: 6,
    marginBottom: 8,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  buttonCell: {
    flex: 1,
  },
  singleButtonRow: {
    marginTop: 6,
  },
  mainViewRow: {
    flexDirection: 'row',
    gap: 6,
  },
  mainViewButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#9ca3af',
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
  },
  mainViewButtonText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#111827',
  },
  transportRow: {
    flexDirection: 'row',
    gap: 8,
  },
  transportButton: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#9ca3af',
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
  },
  priorityButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#9ca3af',
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
  },
  priorityButtonText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#111827',
  },
  transportSelected: {
    backgroundColor: '#2196f3',
    borderColor: '#2196f3',
  },
  transportText: {
    fontWeight: '700',
    color: '#111827',
  },
  transportSelectedText: {
    color: '#ffffff',
  },
  disabledControl: {
    opacity: 0.5,
  },
  mono: {
    fontFamily: Platform.select({ android: 'monospace', default: 'Courier' }),
    fontSize: 12,
    lineHeight: 18,
    color: '#111827',
  },
  chartHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  chartBody: {
    flexDirection: 'row',
  },
  chartYAxis: {
    width: 34,
    height: FRAME_RATE_CHART_HEIGHT,
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingRight: 5,
  },
  chartPlot: {
    flex: 1,
    height: FRAME_RATE_CHART_HEIGHT,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#6b7280',
    overflow: 'hidden',
  },
  chartGridLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#d1d5db',
  },
  chartBars: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  chartBarCell: {
    flex: 1,
    height: FRAME_RATE_CHART_HEIGHT,
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  chartBar: {
    width: '65%',
    minHeight: 1,
    backgroundColor: '#2563eb',
  },
  chartBarOverflow: {
    backgroundColor: '#dc2626',
  },
  chartXAxisRow: {
    marginLeft: 34,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 3,
  },
  chartAxisLabel: {
    fontFamily: Platform.select({ android: 'monospace', default: 'Courier' }),
    fontSize: 10,
    lineHeight: 12,
    color: '#4b5563',
  },
  binaryControlGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  binaryControl: {
    width: '48.5%',
    minHeight: 92,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  binaryControlOn: {
    backgroundColor: '#dcfce7',
    borderColor: '#16a34a',
  },
  binaryControlOff: {
    backgroundColor: '#f3f4f6',
    borderColor: '#9ca3af',
  },
  binaryControlValue: {
    fontSize: 25,
    lineHeight: 30,
    fontWeight: '800',
  },
  binaryControlValueOn: {
    color: '#15803d',
  },
  binaryControlValueOff: {
    color: '#4b5563',
  },
  rotaryControlGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  rotaryControl: {
    width: '23.5%',
    minHeight: 100,
    borderWidth: 1,
    borderColor: '#2563eb',
    borderRadius: 8,
    paddingHorizontal: 4,
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#eff6ff',
    gap: 3,
  },
  rotaryControlValue: {
    fontFamily: Platform.select({ android: 'monospace', default: 'Courier' }),
    fontSize: 29,
    lineHeight: 34,
    fontWeight: '800',
    color: '#1d4ed8',
  },
  controlName: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '700',
    textAlign: 'center',
    color: '#111827',
  },
  controlHint: {
    fontSize: 10,
    lineHeight: 13,
    textAlign: 'center',
    color: '#4b5563',
  },
  channelDashboardCard: {
    padding: 6,
  },
  channelGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    alignItems: 'stretch',
  },
  channelTile: {
    width: '32.45%',
    minHeight: 98,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#c7c7c7',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 6,
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
  },
  channelTileCompact: {
    minHeight: 82,
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  channelTileInactive: {
    backgroundColor: '#f3f4f6',
    opacity: 0.52,
  },
  channelTileStale: {
    borderWidth: 1.5,
    borderColor: '#dc2626',
  },
  channelTileUnknown: {
    backgroundColor: '#fff7d6',
    borderColor: '#d49b00',
    opacity: 1,
  },
  channelTileTitle: {
    minHeight: 30,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
    color: '#111827',
  },
  channelTileTitleCompact: {
    minHeight: 26,
    fontSize: 9,
    lineHeight: 12,
  },
  channelTileValue: {
    fontFamily: Platform.select({ android: 'monospace', default: 'Courier' }),
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '700',
    color: '#111827',
  },
  channelTileValueCompact: {
    fontSize: 13,
    lineHeight: 17,
  },
  channelTileRate: {
    fontFamily: Platform.select({ android: 'monospace', default: 'Courier' }),
    fontSize: 10,
    lineHeight: 13,
    color: '#374151',
  },
  channelTileRateCompact: {
    fontSize: 9,
    lineHeight: 11,
  },
  channelBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#c7c7c7',
    borderRadius: 6,
    padding: 8,
    marginVertical: 2,
  },
  channelTitle: {
    fontWeight: '700',
    marginBottom: 2,
    color: '#111827',
  },
  deviceBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#c7c7c7',
    borderRadius: 8,
    padding: 10,
    marginTop: 6,
    gap: 2,
  },
  deviceName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  deviceButton: {
    marginTop: 6,
  },
  note: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 17,
    color: '#4a4a4a',
  },
});
