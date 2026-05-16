/**
 * V3 event handlers — оновлюють Device counters, створюють Submission, агрегують DailyStat.
 *
 * Event: ProofSubmitted(bytes32 deviceId, bytes32 sessionKey, uint64 timestamp,
 *                       uint64 gapFromPrevious, bool postDisconnection)
 *
 * Зауваження по deviceId: V3 емітить `deviceId` як bytes32 — це той самий pubKeyHash
 * що DeviceRegistry використовує як storage key. Тобто join на DeviceRegistry events
 * через цей хеш — natural.
 */

import { log } from "@graphprotocol/graph-ts";
import { ProofSubmitted } from "../generated/EnergyProofRegistryV3/EnergyProofRegistryV3";
import { Device, Submission, DailyStat } from "../generated/schema";
import {
  loadOrCreateProtocol,
  getDayStartTs,
  makeDailyStatId,
} from "./utils";

export function handleProofSubmitted(event: ProofSubmitted): void {
  let deviceId = event.params.deviceId.toHexString();
  let sessionKey = event.params.sessionKey.toHexString();

  // Завантажуємо Device. V3 enforce-ить що пристрій registered у DeviceRegistry,
  // але через event ordering subgraph може ще не побачити DeviceRegistered.
  // Якщо так — warn і skip submission. Це rare edge case, не worth aborting.
  let device = Device.load(deviceId);
  if (device == null) {
    log.warning(
      "ProofSubmitted for device {} not yet seen у DeviceRegistry events. Skipping.",
      [deviceId],
    );
    return;
  }

  // Створюємо Submission (immutable — ніколи не змінюється після створення)
  let submission = new Submission(sessionKey);
  submission.device = deviceId;
  submission.timestamp = event.params.timestamp;
  submission.blockNumber = event.block.number;
  submission.blockTimestamp = event.block.timestamp;
  submission.gapFromPrevious = event.params.gapFromPrevious;
  submission.postDisconnection = event.params.postDisconnection;
  submission.txHash = event.transaction.hash;
  submission.save();

  // Інкрементуємо Device counters
  device.submissionCount = device.submissionCount + 1;
  if (event.params.postDisconnection) {
    device.postDisconnectionCount = device.postDisconnectionCount + 1;
  }
  device.save();

  // Оновлюємо DailyStat — load-or-create pattern.
  // Day basis: UTC midnight of block timestamp (не event timestamp, бо це reflect
  // chain accept time, не device claim time).
  let dayStartTs = getDayStartTs(event.block.timestamp);
  let dailyId = makeDailyStatId(dayStartTs, deviceId);
  let daily = DailyStat.load(dailyId);
  if (daily == null) {
    daily = new DailyStat(dailyId);
    daily.dayStartTs = dayStartTs;
    daily.device = deviceId;
    daily.submissionCount = 0;
    daily.postDisconnectionCount = 0;
  }
  daily.submissionCount = daily.submissionCount + 1;
  if (event.params.postDisconnection) {
    daily.postDisconnectionCount = daily.postDisconnectionCount + 1;
  }
  daily.save();

  // Оновлюємо Protocol singleton counters
  let protocol = loadOrCreateProtocol();
  protocol.totalSubmissions = protocol.totalSubmissions + 1;
  if (event.params.postDisconnection) {
    protocol.totalPostDisconnections = protocol.totalPostDisconnections + 1;
  }
  protocol.save();
}
