# === Part 1: append DB helpers ===
db_path = '/home/ppbar/infraveritas/aggregator/src/db.ts'
with open(db_path, 'r') as f:
    db_content = f.read()

db_helpers = """

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
"""

if 'getAttackCountsByType' in db_content:
    print('db.ts already has getAttackCountsByType — skip append')
else:
    db_content += db_helpers
    with open(db_path, 'w') as f:
        f.write(db_content)
    print('db.ts updated with 2 new functions')

# === Part 2: update server.ts ===
srv_path = '/home/ppbar/infraveritas/aggregator/src/server.ts'
with open(srv_path, 'r') as f:
    srv_content = f.read()

old_import = "import { insertSubmission, getHealthMetrics, updateSubmissionProof, updateSubmissionChain, updateSubmissionError, updateSubmissionEnergy, getSubmission, getAllSubmissions, sessionExists, logAttack, AttackType } from './db';"
new_import = "import { insertSubmission, getHealthMetrics, updateSubmissionProof, updateSubmissionChain, updateSubmissionError, updateSubmissionEnergy, getSubmission, getAllSubmissions, sessionExists, logAttack, AttackType, getAttackCountsByType, getSubmissionCountsByStatus } from './db';"

if old_import not in srv_content:
    raise SystemExit('imports pattern not found in server.ts — abort')
srv_content = srv_content.replace(old_import, new_import)

old_health_block = """app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'InfraVeritas Aggregator', timestamp: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()), ...getHealthMetrics() });
});"""

metrics_endpoint = r"""

// A.3.4: Prometheus-format /metrics for observability
app.get('/metrics', readLimiter, (req: Request, res: Response) => {
  const attacks = getAttackCountsByType();
  const submissions = getSubmissionCountsByStatus();
  const uptime = Math.floor(process.uptime());

  let output = '';
  output += '# HELP infraveritas_attacks_total Total security/validation events by type\n';
  output += '# TYPE infraveritas_attacks_total counter\n';
  for (const [type, count] of Object.entries(attacks)) {
    output += `infraveritas_attacks_total{type="${type}"} ${count}\n`;
  }
  output += '\n# HELP infraveritas_submissions_total Total submissions by chain status\n';
  output += '# TYPE infraveritas_submissions_total counter\n';
  for (const [status, count] of Object.entries(submissions)) {
    output += `infraveritas_submissions_total{status="${status}"} ${count}\n`;
  }
  output += '\n# HELP infraveritas_aggregator_uptime_seconds Process uptime in seconds\n';
  output += '# TYPE infraveritas_aggregator_uptime_seconds gauge\n';
  output += `infraveritas_aggregator_uptime_seconds ${uptime}\n`;

  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(output);
});"""