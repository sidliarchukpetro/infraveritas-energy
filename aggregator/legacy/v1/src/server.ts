import express, { Request, Response } from 'express';
import { SubmitPayload } from './types';
import { generateProof } from './prover';
import { submitProofOnChain } from './chain';
import { insertSubmission, getHealthMetrics, updateSubmissionProof, updateSubmissionChain, updateSubmissionError, updateSubmissionEnergy, getSubmission, getAllSubmissions, sessionExists, logAttack, AttackType } from './db';
import { verifyDeviceSignature } from './verify';
import rateLimit from 'express-rate-limit';

// A.3.3.2: combined logAttack + reject for security/validation failures
function rejectAttack(
  req: Request,
  res: Response,
  type: AttackType,
  statusCode: number,
  reason: string,
  deviceId?: number,
  sessionId?: number
) {
  logAttack(type, {
    deviceId,
    sessionId,
    ipAddress: req.ip,
    details: { reason }
  });
  return res.status(statusCode).json({ error: reason });
}


const app = express();
const PORT = 3000;
app.use(express.json({ limit: '10mb' }));
app.use((req: any, res: any, next: any) => { res.header('Access-Control-Allow-Origin', '*'); res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.header('Access-Control-Allow-Headers', 'Content-Type'); if (req.method === 'OPTIONS') { return res.sendStatus(200); } next(); });
const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    logAttack('RATE_LIMIT_EXCEEDED', {
      ipAddress: req.ip,
      details: { endpoint: req.path, limit: '10 req/min' }
    });
    res.status(429).json({ error: 'Rate limit exceeded for /submit (10 req/min)' });
  }
});
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    logAttack('RATE_LIMIT_EXCEEDED', {
      ipAddress: req.ip,
      details: { endpoint: req.path, limit: '100 req/min' }
    });
    res.status(429).json({ error: 'Rate limit exceeded for read endpoints (100 req/min)' });
  }
});

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'InfraVeritas Aggregator', timestamp: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()), ...getHealthMetrics() });
});

app.post('/submit', submitLimiter, async (req: Request, res: Response) => {
  const payload = req.body as SubmitPayload;

  // Basic field presence
  if (!payload.deviceId || !payload.sessionId) return rejectAttack(req, res, 'MALFORMED_PAYLOAD', 400, 'Missing deviceId or sessionId', payload.deviceId, payload.sessionId);
  if (!payload.epochStartTs) return rejectAttack(req, res, 'MALFORMED_PAYLOAD', 400, 'Missing epochStartTs', payload.deviceId, payload.sessionId);
  if (payload.epochStartTs < 1700000000 || payload.epochStartTs > 2000000000) return rejectAttack(req, res, 'MALFORMED_PAYLOAD', 400, 'epochStartTs out of valid range', payload.deviceId, payload.sessionId);
  if (payload.deviceId <= 0 || payload.deviceId >= 1000000) return rejectAttack(req, res, 'MALFORMED_PAYLOAD', 400, 'deviceId out of valid range', payload.deviceId, payload.sessionId);

  // v2.0 environment fields
  if (typeof payload.lat !== 'number') return rejectAttack(req, res, 'MALFORMED_PAYLOAD', 400, 'Missing lat', payload.deviceId, payload.sessionId);
  if (typeof payload.lon !== 'number') return rejectAttack(req, res, 'MALFORMED_PAYLOAD', 400, 'Missing lon', payload.deviceId, payload.sessionId);
  if (typeof payload.lightLevel !== 'number') return rejectAttack(req, res, 'MALFORMED_PAYLOAD', 400, 'Missing lightLevel', payload.deviceId, payload.sessionId);
  if (typeof payload.tamperFlag !== 'number') return rejectAttack(req, res, 'MALFORMED_PAYLOAD', 400, 'Missing tamperFlag', payload.deviceId, payload.sessionId);
  if (payload.tamperFlag !== 0) return rejectAttack(req, res, 'TAMPER_FLAG_SET', 400, 'Device reports tamper detected', payload.deviceId, payload.sessionId);

  // Readings + signature
  if (!Array.isArray(payload.readings) || payload.readings.length !== 100) return rejectAttack(req, res, 'MALFORMED_PAYLOAD', 400, 'readings must have exactly 100 items', payload.deviceId, payload.sessionId);
  if (!payload.signature) return rejectAttack(req, res, 'MALFORMED_PAYLOAD', 400, 'Missing signature', payload.deviceId, payload.sessionId);

  const sigCheck = verifyDeviceSignature(payload);
  if (!sigCheck.valid) {
    return rejectAttack(req, res, 'SIGNATURE_INVALID', 401, `Invalid signature: ${sigCheck.error}`, payload.deviceId, payload.sessionId);
  }
  const duplicate = sessionExists(payload.deviceId, payload.sessionId);
  if (duplicate) {
    return rejectAttack(req, res, 'REPLAY_DETECTED', 409, `Session ${payload.sessionId} already processed for device ${payload.deviceId}`, payload.deviceId, payload.sessionId);
  }

  console.log(`-> Received submission: device=${payload.deviceId}, session=${payload.sessionId}`);
  const receivedAt = new Date().toISOString();
  const dbId = insertSubmission({
    receivedAt, deviceId: payload.deviceId, sessionId: payload.sessionId,
    epochStartTs: payload.epochStartTs, minTotalEnergy: 0,
    payloadJson: JSON.stringify(payload)
  });

  let proofResult: any = null;
  let proofError: string | undefined;
  let txHash: string | undefined;
  let chainStatus: string | undefined;

  try {
    proofResult = await generateProof(payload);
    updateSubmissionProof(dbId, JSON.stringify(proofResult));
    updateSubmissionEnergy(dbId, proofResult.totalEnergyMwh);
    try {
      const onchain = await submitProofOnChain(
        payload.deviceId,
        payload.epochStartTs,
        proofResult.coarseLat,
        proofResult.coarseLon,
        proofResult.totalEnergyMwh,
        proofResult.proof,
        proofResult.publicInputs
      );
      txHash = onchain.txHash;
      chainStatus = onchain.status;
      updateSubmissionChain(dbId, txHash!, chainStatus!);
    } catch (chainError: any) {
      console.error(`  X On-chain failed: ${chainError.message}`);
      chainStatus = 'failed';
    }
  } catch (error: any) {
    console.error(`  X Proof failed: ${error.message}`);
    proofError = error.message;
    updateSubmissionError(dbId, proofError!);
  }

  return res.json({
    status: proofResult ? 'proof_generated' : 'proof_failed',
    submissionId: dbId,
    receivedAt,
    proofGenerationTimeMs: proofResult?.generationTimeMs,
    totalEnergyMwh: proofResult?.totalEnergyMwh,
    coarseLat: proofResult?.coarseLat,
    coarseLon: proofResult?.coarseLon,
    txHash,
    chainStatus,
    proofError
  });
});

app.get('/submissions', readLimiter, (req: Request, res: Response) => {
  const rows = getAllSubmissions() as any[];
  res.json({ count: rows.length, items: rows.map((r: any) => ({ id: r.id, receivedAt: r.received_at, deviceId: r.device_id, sessionId: r.session_id, totalEnergyMwh: r.total_energy_mwh, txHash: r.tx_hash, chainStatus: r.chain_status })) });
});

app.get('/submissions/:id', readLimiter, (req: Request, res: Response) => {
  const row = getSubmission(parseInt(req.params.id as string)) as any;
  if (!row) return res.status(404).json({ error: 'Submission not found' });
  res.json(row);
});

app.get('/submissions/:id/onchain', readLimiter, (req: Request, res: Response) => {
  const row = getSubmission(parseInt(req.params.id as string)) as any;
  if (!row) return res.status(404).json({ error: 'Submission not found' });
  if (!row.tx_hash) return res.status(404).json({ error: 'No on-chain transaction' });
  res.json({ txHash: row.tx_hash, chainStatus: row.chain_status, etherscanUrl: `https://sepolia.etherscan.io/tx/${row.tx_hash}` });
});

app.listen(PORT, () => {
  console.log(`Aggregator running on http://localhost:${PORT}`);
  console.log(`Health: GET  /health`);
  console.log(`Submit: POST /submit`);
  console.log(`List:   GET  /submissions`);
  console.log(`Detail: GET  /submissions/:id`);
});