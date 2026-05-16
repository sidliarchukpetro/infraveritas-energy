/**
 * Shared utilities для event handlers.
 *
 * AssemblyScript-specific: лімітований TypeScript, нема optional chaining,
 * null безпека вимагає explicit checks.
 */

import { BigInt } from "@graphprotocol/graph-ts";
import { Protocol } from "../generated/schema";

const PROTOCOL_ID = "0";
const SECONDS_PER_DAY = 86400;

/**
 * Завантажує Protocol singleton або створює з нулями. Зберігає одразу,
 * щоб обробник може просто modify і save знов.
 */
export function loadOrCreateProtocol(): Protocol {
  let protocol = Protocol.load(PROTOCOL_ID);
  if (protocol == null) {
    protocol = new Protocol(PROTOCOL_ID);
    protocol.totalDevices = 0;
    protocol.activeDevices = 0;
    protocol.revokedDevices = 0;
    protocol.suspendedDevices = 0;
    protocol.totalSubmissions = 0;
    protocol.totalPostDisconnections = 0;
    protocol.save();
  }
  return protocol;
}

/**
 * Обчислює Unix timestamp початку UTC-доби для заданого моменту.
 * Приклад: timestamp 1747380000 (16 травня 2025 12:00 UTC) → 1747353600 (день старт).
 */
export function getDayStartTs(timestamp: BigInt): BigInt {
  let secondsInDay = BigInt.fromI32(SECONDS_PER_DAY);
  return timestamp.div(secondsInDay).times(secondsInDay);
}

/**
 * Формує ID для DailyStat у форматі "dayStartTs-deviceId".
 */
export function makeDailyStatId(dayStartTs: BigInt, deviceId: string): string {
  return dayStartTs.toString() + "-" + deviceId;
}
