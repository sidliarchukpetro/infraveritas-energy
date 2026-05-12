path = '/home/ppbar/infraveritas/aggregator/src/server.ts'
with open(path, 'r') as f:
    content = f.read()

# Replace submitLimiter with multi-line version including handler
old_submit = "const submitLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: 'Rate limit exceeded for /submit (10 req/min)' }, standardHeaders: true, legacyHeaders: false });"
new_submit = """const submitLimiter = rateLimit({
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
});"""

if old_submit not in content:
    raise SystemExit('submitLimiter pattern not found — abort')
content = content.replace(old_submit, new_submit)

# Replace readLimiter likewise
old_read = "const readLimiter = rateLimit({ windowMs: 60 * 1000, max: 100, message: { error: 'Rate limit exceeded for read endpoints (100 req/min)' }, standardHeaders: true, legacyHeaders: false });"
new_read = """const readLimiter = rateLimit({
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
});"""

if old_read not in content:
    raise SystemExit('readLimiter pattern not found — abort')
content = content.replace(old_read, new_read)

with open(path, 'w') as f:
    f.write(content)

print('A.3.3.3 transformations applied')