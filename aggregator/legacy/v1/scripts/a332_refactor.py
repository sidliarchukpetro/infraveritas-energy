import re

path = '/home/ppbar/infraveritas/aggregator/src/server.ts'
with open(path, 'r') as f:
    content = f.read()

# 1. Update imports — add logAttack, AttackType
content = content.replace(
    "import { insertSubmission, getHealthMetrics, updateSubmissionProof, updateSubmissionChain, updateSubmissionError, updateSubmissionEnergy, getSubmission, getAllSubmissions, sessionExists } from './db';",
    "import { insertSubmission, getHealthMetrics, updateSubmissionProof, updateSubmissionChain, updateSubmissionError, updateSubmissionEnergy, getSubmission, getAllSubmissions, sessionExists, logAttack, AttackType } from './db';"
)

# 2. Insert rejectAttack helper after last import line
lines = content.split('\n')
last_import_idx = 0
for i, line in enumerate(lines):
    if line.startswith('import '):
        last_import_idx = i

helper = """
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
"""
lines.insert(last_import_idx + 1, helper)
content = '\n'.join(lines)

# 3. Replace all 400 single-quoted returns with rejectAttack
content = re.sub(
    r"return res\.status\(400\)\.json\(\{ error: '([^']*)' \}\);",
    r"return rejectAttack(req, res, 'MALFORMED_PAYLOAD', 400, '\1', payload.deviceId, payload.sessionId);",
    content
)

# 4. Replace 401 signature error (backtick template)
content = content.replace(
    "return res.status(401).json({ error: `Invalid signature: ${sigCheck.error}` });",
    "return rejectAttack(req, res, 'SIGNATURE_INVALID', 401, `Invalid signature: ${sigCheck.error}`, payload.deviceId, payload.sessionId);"
)

# 5. Replace 409 replay detection (backtick template)
content = content.replace(
    "return res.status(409).json({ error: `Session ${payload.sessionId} already processed for device ${payload.deviceId}` });",
    "return rejectAttack(req, res, 'REPLAY_DETECTED', 409, `Session ${payload.sessionId} already processed for device ${payload.deviceId}`, payload.deviceId, payload.sessionId);"
)

# 6. Add TAMPER_FLAG_SET check right after tamperFlag type check
content = content.replace(
    "if (typeof payload.tamperFlag !== 'number') return rejectAttack(req, res, 'MALFORMED_PAYLOAD', 400, 'Missing tamperFlag', payload.deviceId, payload.sessionId);",
    "if (typeof payload.tamperFlag !== 'number') return rejectAttack(req, res, 'MALFORMED_PAYLOAD', 400, 'Missing tamperFlag', payload.deviceId, payload.sessionId);\n  if (payload.tamperFlag !== 0) return rejectAttack(req, res, 'TAMPER_FLAG_SET', 400, 'Device reports tamper detected', payload.deviceId, payload.sessionId);"
)

with open(path, 'w') as f:
    f.write(content)

print('Transformations applied')