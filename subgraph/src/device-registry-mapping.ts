/**
 * DeviceRegistry event handlers — Device entity lifecycle.
 *
 * Events:
 *   DeviceRegistered(bytes32 pubKeyHash, int32 latE7, int32 lonE7, uint64 registeredAt, address operator)
 *   DeviceRevoked(bytes32 pubKeyHash, address operator)
 *   DeviceReactivated(bytes32 pubKeyHash, address operator)
 *   DeviceSuspended(bytes32 pubKeyHash, address operator)
 *
 * pubKeyHash — це id Device у subgraph. Той самий хеш V3 емітіть як `deviceId`
 * у ProofSubmitted, тому join працює.
 */

import { log } from "@graphprotocol/graph-ts";
import {
  DeviceRegistered,
  DeviceRevoked,
  DeviceReactivated,
  DeviceSuspended,
} from "../generated/DeviceRegistry/DeviceRegistry";
import { Device } from "../generated/schema";
import { loadOrCreateProtocol } from "./utils";

const STATUS_ACTIVE = "Active";
const STATUS_REVOKED = "Revoked";
const STATUS_SUSPENDED = "Suspended";

// -----------------------------------------------------------
// Registered — новий пристрій. Створюємо Device entity.
// -----------------------------------------------------------
export function handleDeviceRegistered(event: DeviceRegistered): void {
  let deviceId = event.params.pubKeyHash.toHexString();

  // Захист від дублікату (повторна реєстрація після revoke не emit DeviceRegistered
  // у V3 design — лише Reactivated. Тому повторного registered не очікуємо. Але defensive.)
  let existing = Device.load(deviceId);
  if (existing != null) {
    log.warning("DeviceRegistered повторно для {} — пропускаю create", [deviceId]);
    return;
  }

  let device = new Device(deviceId);
  device.latE7 = event.params.latE7;
  device.lonE7 = event.params.lonE7;
  device.registeredAt = event.params.registeredAt;
  device.registeredBy = event.params.operator;
  device.status = STATUS_ACTIVE;
  device.submissionCount = 0;
  device.postDisconnectionCount = 0;
  device.save();

  let protocol = loadOrCreateProtocol();
  protocol.totalDevices = protocol.totalDevices + 1;
  protocol.activeDevices = protocol.activeDevices + 1;
  protocol.save();
}

// -----------------------------------------------------------
// Revoked — permanent block. Status → Revoked.
// -----------------------------------------------------------
export function handleDeviceRevoked(event: DeviceRevoked): void {
  let deviceId = event.params.pubKeyHash.toHexString();
  let device = Device.load(deviceId);
  if (device == null) {
    log.warning("DeviceRevoked для невідомого {} — пропускаю", [deviceId]);
    return;
  }

  let prevStatus = device.status;
  device.status = STATUS_REVOKED;
  device.revokedAt = event.block.timestamp;
  device.save();

  let protocol = loadOrCreateProtocol();
  if (prevStatus == STATUS_ACTIVE) {
    protocol.activeDevices = protocol.activeDevices - 1;
  } else if (prevStatus == STATUS_SUSPENDED) {
    protocol.suspendedDevices = protocol.suspendedDevices - 1;
  }
  protocol.revokedDevices = protocol.revokedDevices + 1;
  protocol.save();
}

// -----------------------------------------------------------
// Reactivated — restore from Revoked або Suspended до Active.
// -----------------------------------------------------------
export function handleDeviceReactivated(event: DeviceReactivated): void {
  let deviceId = event.params.pubKeyHash.toHexString();
  let device = Device.load(deviceId);
  if (device == null) {
    log.warning("DeviceReactivated для невідомого {} — пропускаю", [deviceId]);
    return;
  }

  let prevStatus = device.status;
  device.status = STATUS_ACTIVE;
  device.reactivatedAt = event.block.timestamp;
  device.save();

  let protocol = loadOrCreateProtocol();
  if (prevStatus == STATUS_REVOKED) {
    protocol.revokedDevices = protocol.revokedDevices - 1;
  } else if (prevStatus == STATUS_SUSPENDED) {
    protocol.suspendedDevices = protocol.suspendedDevices - 1;
  }
  protocol.activeDevices = protocol.activeDevices + 1;
  protocol.save();
}

// -----------------------------------------------------------
// Suspended — temporary disable. Active → Suspended.
// -----------------------------------------------------------
export function handleDeviceSuspended(event: DeviceSuspended): void {
  let deviceId = event.params.pubKeyHash.toHexString();
  let device = Device.load(deviceId);
  if (device == null) {
    log.warning("DeviceSuspended для невідомого {} — пропускаю", [deviceId]);
    return;
  }

  let prevStatus = device.status;
  device.status = STATUS_SUSPENDED;
  device.suspendedAt = event.block.timestamp;
  device.save();

  let protocol = loadOrCreateProtocol();
  // Only Active → Suspended is valid у V3 design; інші переходи unexpected.
  if (prevStatus == STATUS_ACTIVE) {
    protocol.activeDevices = protocol.activeDevices - 1;
  }
  protocol.suspendedDevices = protocol.suspendedDevices + 1;
  protocol.save();
}
