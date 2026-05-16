/**
 * V3 event handlers v0.0.2 — створюють Submission, агрегують DailyStat.
 *
 * IMPORTANT (v0.0.2 design change):
 *   V3.ProofSubmitted emit-ить `deviceId` як bytes32 cast of payload's
 *   uint64 device_id field — це НЕ pubKeyHash. Тому ми НЕ робимо
 *   Device.load() — Submission зберігається з його own deviceIdBytes,
 *   незалежно від DeviceRegistry events.
 *
 *   Detail: payload.deviceId=42 → emit `0x000...02a` (bytes32 of 42).
 *   pubKeyHash у DeviceRegistry = keccak256(pubkey) — повністю різний
 *   набір 32 байт.
 */

import { ProofSubmitted } from "../generated/EnergyProofRegistryV3/EnergyProofRegistryV3";
import { Submission, DailyStat } from "../generated/schema";
import {
  loadOrCreateProtocol,
  getDayStartTs,
  makeDailyStatId,
} from "./utils";

export function handleProofSubmitted(event: ProofSubmitted): void {
  let sessionKey = event.params.sessionKey.toHexString();
  let deviceIdBytes = event.params.deviceId;

  // Створюємо Submission (immutable — ніколи не змінюється після створення)
  let submission = new Submission(sessionKey);
  submission.deviceIdBytes = deviceIdBytes;
  submission.timestamp = event.params.timestamp;
  submission.blockNumber = event.block.number;
  submission.blockTimestamp = event.block.timestamp;
  submission.gapFromPrevious = event.params.gapFromPrevious;
  submission.postDisconnection = event.params.postDisconnection;
  submission.txHash = event.transaction.hash;
  submission.save();

  // Оновлюємо DailyStat — load-or-create pattern.
  // Key by raw deviceIdBytes hex (not pubKeyHash — see header comment).
  let dayStartTs = getDayStartTs(event.block.timestamp);
  let deviceIdHex = deviceIdBytes.toHexString();
  let dailyId = makeDailyStatId(dayStartTs, deviceIdHex);
  let daily = DailyStat.load(dailyId);
  if (daily == null) {
    daily = new DailyStat(dailyId);
    daily.dayStartTs = dayStartTs;
    daily.deviceIdBytes = deviceIdBytes;
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
