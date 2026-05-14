# InfraVeritas Energy — Security Notes

**Last audit:** 2026-05-14
**Auditor:** Internal review (Petro + Claude, partnership mode)
**Scope:** Edge → Aggregator → V3 contract transport and validation layer.

---

## Threat model summary

**Assets protected:**
1. **Payload integrity** — measurements must reach chain unmodified
2. **Submission authenticity** — only genuine signed edge devices submit
3. **Operator key** — chain submission authority must not leak
4. **System availability** — DoS attacks must not block legitimate edge submissions

**Adversaries considered:**

| Adversary | Capability | Mitigation |
|---|---|---|
| Network eavesdropper | Read plaintext traffic | TLS 1.3 (Step 3) |
| MITM attacker | Modify, redirect, replay packets | TLS server auth + payload-level P-256 sig + sessionKey replay protection |
| DoS attacker | Flood public endpoints | Rate limiting (10 submissions/IP/min) + cheap pre-validation |
| Compromised edge | Sign arbitrary data with stolen key | HSM (ATECC608B) production deployment — key never extractable |
| Compromised aggregator host | Use operator key, replay caught payloads | Docker secrets for key, replay protection on chain (sessionKey) |
| Garbage-data flooder | Send well-formed but invalid payloads | P-256 pre-check (~1ms) before expensive proof gen (~3s) |

---

## Audit findings status

### HIGH severity

| # | Finding | Status | Closed by |
|---|---|---|---|
| 1 | HTTP (no TLS) — edge ↔ aggregator plaintext | ⏳ Designed | `docs/specs/deployment.md` (Caddy reverse proxy); deployment-time |
| 2 | Edge HTTP client wire format alignment unverified | ✓ Closed | Step 1: `edge/network/client.py` + contract test `test_wire_format_matches_server_schema` |
| 3 | DoS surface — no rate limiting on /submissions | ✓ Closed | Step 2A: `@fastify/rate-limit` 10/min/IP |

### MEDIUM severity

| # | Finding | Status | Closed by |
|---|---|---|---|
| 4 | uint64/int64 bound checks missing | ✓ Closed | Step 2B: zod refine with `BigInt` range checks |
| 5 | No local sig pre-check before expensive proof gen | ✓ Closed | Step 2D: worker P-256 verify before witness gen |
| 6 | Geographic / physical bounds not validated | ✓ Closed | Step 2C: lat ±90°, lon ±180°, tamper_flag ∈ {0,1} |

### LOW severity

| # | Finding | Status | Notes |
|---|---|---|---|
| 7 | Operator private key in env var | 📝 Documented | Migrate to Docker secret (`OPERATOR_PRIVATE_KEY_FILE`) — small code change for follow-up. Production via Vault / AWS Secrets Manager longer-term |
| 8 | CORS policy not explicit | 📝 Documented | Caddy strips `Access-Control-Allow-Origin` — aggregator is not a browser API, no CORS needed. Document in deployment.md |
| 9 | Edge → aggregator URL provisioning integrity | 📝 Documented | Production firmware should hardcode URL (avoid DNS spoofing risk on initial provisioning); pin TLS cert if customer demands stronger guarantee |

---

## Defense-in-depth layers

The system has **three independent layers** that an attacker must
defeat to inject a fraudulent submission:

```
Layer 1 — TLS (Step 3 deployment)
   ├─ Encrypts traffic against eavesdropping
   ├─ Authenticates server to edge (MITM blocked)
   └─ Optional: client cert / mTLS if customer demands

Layer 2 — Payload-level cryptography
   ├─ P-256 ECDSA signature on every payload (device authenticity)
   ├─ Poseidon hash binds canonical encoding to signed value
   ├─ Low-s normalization prevents signature malleability
   └─ sessionKey = keccak256(deviceId || sessionId) — one-time use

Layer 3 — Zero-knowledge proof
   ├─ Noir v08 circuit verifies all 4 checks atomically
   ├─ HonkVerifier.sol re-verifies on-chain
   └─ Anyone can re-verify proof off-chain forever (auditability)
```

Compromising any one layer is insufficient. Compromising all three
requires (a) breaking TLS, (b) extracting an HSM-protected P-256 key,
and (c) finding a circuit-level vulnerability — all simultaneously.

---

## Cross-cutting concerns

### Logging hygiene

- **Never log:** operator private key, edge device private keys (none stored on aggregator anyway), full payload contents in error messages
- **Safe to log:** sessionKey, deviceId, error codes, timing metrics
- Worker uses structured logging via Fastify's pino integration — review log fields when adding new error paths
- Caddy access logs are JSON-formatted, suitable for ingestion into ELK / Loki / Datadog

### Operator key handling

| Stage | Storage | Notes |
|---|---|---|
| Local dev | `.env` (gitignored) | `OPERATOR_PRIVATE_KEY` env var |
| Pilot / staging | Docker secret file | Read via `OPERATOR_PRIVATE_KEY_FILE` env (TODO code change) |
| Production | AWS Secrets Manager / HashiCorp Vault | Mount at startup, rotate quarterly |

**Rotation procedure:**
1. Generate new operator wallet (offline machine)
2. Grant OPERATOR_ROLE to new address via V3 admin
3. Wait 1 epoch for in-flight submissions to drain
4. Update Docker secret / Vault, restart aggregator
5. Revoke OPERATOR_ROLE from old address
6. Sweep remaining ETH from old wallet to treasury

### Edge URL provisioning

- **Firmware bake:** hardcode `https://api.infraveritas.pro` at compile time. Reduces attack surface vs reading from device config that could be tampered.
- **Cert validation:** trust system CA chain by default. Pin only if customer requires stronger guarantee (then accept rotation pain).
- **Multi-tenant:** if multiple aggregators exist (e.g. per-customer), use distinct subdomains and bake the correct URL per fleet. Avoid runtime URL switching.

---

## Future security work (post-MVP)

### High-priority (production rollout)

- [ ] **HSM integration** — ATECC608B for production edge devices (already designed in `edge/hal/signing.py` docstring; needs firmware integration on Тарас side)
- [ ] **Operator key migration** — Docker secret file → Vault when scaling beyond single deployment
- [ ] **Trust-proxy in Fastify** — needed once Caddy is in front, for correct rate-limit IP detection
- [ ] **Structured audit logging** — every submission to a separate audit log stream (immutable, append-only) for compliance review

### Medium-priority (scaling)

- [ ] **mTLS option** — for customers requiring device-level cert authentication on top of payload sig
- [ ] **Cert pinning** — if a customer's threat model demands resistance to CA compromise
- [ ] **Redis-backed queue** — replace InMemoryQueue when scaling to multi-instance aggregator (currently MVP single-flight)
- [ ] **Metrics + alerting** — Prometheus exporters on /metrics endpoint; alerts on quarantine spike, queue depth, proof gen latency
- [ ] **Periodic key compromise drills** — operator key rotation rehearsal, edge key rotation procedure

### Long-term (research)

- [ ] **Post-quantum readiness** — monitor NIST PQC standardization; plan migration path for P-256 (ECDSA is broken by Shor's algorithm)
- [ ] **Cross-chain submission** — aggregator-to-multichain routing if multiple destinations needed
- [ ] **Hardware enclave (TEE)** — if attackers gain physical aggregator access, run proof gen inside SGX / SEV-SNP enclave
- [ ] **Threshold signing** — split operator role across multiple signers (k-of-n) for higher security than single-key

---

## Periodic review

This document should be revisited:

- **Before every production rollout** (new customer, new region)
- **After every security-relevant code change** (auth, crypto, network, validation)
- **At least once per quarter** even without changes — threat landscape evolves
- **After any incident** (real or near-miss)

Review checklist:
1. Are all findings still mitigated?
2. Have any new attack vectors emerged in the dependency chain?
   (Check `npm audit`, `pip-audit`, advisories for fastify/viem/cryptography)
3. Are the assumptions in the threat model still accurate?
4. Has anything in production exposed weaknesses not anticipated here?

---

## Closed audit reference

The Round 1 security hardening (Step 2 of integration plan) was
implemented in commit `5a3b19e` (2026-05-14). 23/23 tests pass post-fix.
TLS deployment design is in `docs/specs/deployment.md` and is ready to
execute when the aggregator goes live.

This audit was conducted under the partnership-mode workflow: findings
were not pre-approved by either party; both Petro and Claude flagged
issues independently, then triaged by severity with full reasoning made
explicit. Petro's intuition about HTTP + 64-bit flagged the two highest
items before formal review even started.
