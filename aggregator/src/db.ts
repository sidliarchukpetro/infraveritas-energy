import Database from 'better-sqlite3';
import path from 'path';
const DB_PATH = path.join(__dirname, '..', 'submissions.db');
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at TEXT NOT NULL,
    device_id INTEGER NOT NULL,
    session_id INTEGER NOT NULL,
    epoch_start_ts INTEGER NOT NULL,
    min_total_energy INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    proof_json TEXT,
    proof_error TEXT,
    tx_hash TEXT,
    chain_status TEXT
  )
`);

// A.3.0.2: schema migration — add total_energy_mwh for existing DBs (idempotent)
const cols = db.prepare("PRAGMA table_info(submissions)").all() as any[];
if (!cols.some((c: any) => c.name === 'total_energy_mwh')) {
  db.exec(`ALTER TABLE submissions ADD COLUMN total_energy_mwh INTEGER`);
}

export function insertSubmission(data: {
  receivedAt: string;
  deviceId: number;
  sessionId: number;
  epochStartTs: number;
  minTotalEnergy: number;
  payloadJson: string;
}): number {
  const stmt = db.prepare(`
    INSERT INTO submissions (received_at, device_id, session_id, epoch_start_ts, min_total_energy, payload_json)
    VALUES (@receivedAt, @deviceId, @sessionId, @epochStartTs, @minTotalEnergy, @payloadJson)
  `);
  const result = stmt.run(data);
  return result.lastInsertRowid as number;
}
export function updateSubmissionProof(id: number, proofJson: string): void {
  db.prepare(`UPDATE submissions SET proof_json = ? WHERE id = ?`).run(proofJson, id);
}
// A.3.0.2: store computed totalEnergyMwh from ZK proof public output
export function updateSubmissionEnergy(id: number, totalEnergyMwh: number): void {
  db.prepare(`UPDATE submissions SET total_energy_mwh = ? WHERE id = ?`).run(totalEnergyMwh, id);
}
export function updateSubmissionChain(id: number, txHash: string, chainStatus: string): void {
  db.prepare(`UPDATE submissions SET tx_hash = ?, chain_status = ? WHERE id = ?`).run(txHash, chainStatus, id);
}
export function updateSubmissionError(id: number, error: string): void {
  db.prepare(`UPDATE submissions SET proof_error = ? WHERE id = ?`).run(error, id);
}
export function getSubmission(id: number) {
  return db.prepare(`SELECT * FROM submissions WHERE id = ?`).get(id);
}
export function getAllSubmissions() {
  return db.prepare(`SELECT * FROM submissions ORDER BY id DESC`).all();
}
export function sessionExists(deviceId: number, sessionId: number): boolean {
  const row = db.prepare(
    `SELECT id FROM submissions WHERE device_id = ? AND session_id = ?`
  ).get(deviceId, sessionId);
  return !!row;
}

// A.3.2: health endpoint metrics - last confirmed submission, pending count, totals
export function getHealthMetrics() {
  const lastConfirmed = db.prepare(`SELECT received_at, tx_hash FROM submissions WHERE chain_status = 'confirmed' ORDER BY id DESC LIMIT 1`).get() as any;
  const pending = db.prepare(`SELECT COUNT(*) as cnt FROM submissions WHERE chain_status IS NULL OR chain_status = 'failed'`).get() as any;
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM submissions`).get() as any;
  return {
    lastConfirmedAt: lastConfirmed?.received_at || null,
    lastConfirmedTxHash: lastConfirmed?.tx_hash || null,
    pendingSubmissions: pending?.cnt || 0,
    totalSubmissions: total?.cnt || 0
  };
}

// A.3.3: attack events logging table + function
db.exec(`
  CREATE TABLE IF NOT EXISTS attack_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    attack_type TEXT NOT NULL,
    device_id INTEGER,
    session_id INTEGER,
    ip_address TEXT,
    details TEXT
  )
`);

export type AttackType =
  | 'SIGNATURE_INVALID'
  | 'REPLAY_DETECTED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'TAMPER_FLAG_SET'
  | 'MALFORMED_PAYLOAD';

export function logAttack(
  type: AttackType,
  context: {
    deviceId?: number;
    sessionId?: number;
    ipAddress?: string;
    details?: any;
  }
): void {
  db.prepare(
    `INSERT INTO attack_events (ts, attack_type, device_id, session_id, ip_address, details) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    type,
    context.deviceId ?? null,
    context.sessionId ?? null,
    context.ipAddress ?? null,
    context.details ? JSON.stringify(context.details) : null
  );
}


// A.3.4: aggregated counters for /metrics endpoint
export function getAttackCountsByType(): Record<string, number> {
  const rows = db.prepare(`SELECT attack_type, COUNT(*) as cnt FROM attack_events GROUP BY attack_type`).all() as any[];
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.attack_type] = row.cnt;
  }
  return result;
}

export function getSubmissionCountsByStatus(): Record<string, number> {
  const rows = db.prepare(`SELECT COALESCE(chain_status, 'pending') as status, COUNT(*) as cnt FROM submissions GROUP BY chain_status`).all() as any[];
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.status] = row.cnt;
  }
  return result;
}
