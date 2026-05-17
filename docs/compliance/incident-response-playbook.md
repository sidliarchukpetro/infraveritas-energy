# Incident Response Playbook

**Document type:** Operational runbook
**Status:** Draft v0.2 — internal pre-audit deliverable
**Date:** 2026-05-17
**Project:** InfraVeritas Energy MVP
**Scope:** Sepolia testnet deployment + Phase 6 production roadmap

---

## 1. Purpose and Scope

This playbook defines how the InfraVeritas Energy team detects, contains, eradicates, recovers from, and learns from security and operational incidents affecting the protocol. It covers smart contracts, the aggregator service, edge device firmware, the cross-validation pipeline, and the monitoring layer.

The playbook is **operational reference material** to be executed under time pressure. It is deliberately concrete: named roles, specific tools, exact commands where applicable. It is not a policy document — for that see `mica-article-36-45-mapping.md` and `gdpr-review.md`.

This playbook is also a recommended **reference template** for ART/EMT issuers integrating InfraVeritas Energy: any issuer adopting the protocol for MiCA Article 45 continuous monitoring should have an equivalent procedure that translates protocol-level anomaly signals into regulator notifications under their own MiCA obligations.

**Investment-grade framing:** the existence of this playbook ahead of external audit (Phase 7) reflects standard institutional security engineering practice. Investors evaluating InfraVeritas Energy are evaluating a protocol with **incident response procedures documented, scoped, and exercisable on testnet** — not improvised under stress. MVP-specific limitations (single admin EOA, testnet posture) are explicitly identified throughout this document, and each is paired with the corresponding Phase 6 production hardening migration. The gap between MVP and production-ready incident response is engineered, not aspirational.

---

## 2. Roles and Responsibilities

### 2.1 Team

| Role | Responsibilities during incident | Contact |
|---|---|---|
| **Incident Commander (IC)** — Petro Сідлярчук, founder | Overall coordination, external communication, go/no-go decisions | *[contact placeholder]* |
| **Security Lead** — Олександр Сідлярчук, CTO | Smart contract analysis, on-chain forensics, security sign-off on remediation | *[contact placeholder]* |
| **Operations Lead** — Тарас Сідлярчук, ops/firmware | Edge device coordination, aggregator runtime, infrastructure recovery | *[contact placeholder]* |

For incidents at MVP scale, the IC role is held by Petro. As the team scales (Phase 7+), an on-call rotation may be introduced; until then, the IC is the named individual or a documented delegate.

### 2.2 External contacts (placeholder — populated during Phase 6 hardening sprint)

- Legal counsel (MiCA-qualified): *[to be retained during Phase 6]*
- Data Protection Officer or counsel (GDPR): *[to be retained during Phase 6]*
- External security advisor / audit firm contact: *[Hacken or Sherlock retainer, Phase 7]*
- Hosting / infrastructure provider emergency contact: *[populated per deployment]*
- Supervisory authority contact (for MiCA Art. 45 / GDPR Art. 33 notifications): *[Phase 6 onboarding]*

---

## 3. Severity Classification

| Severity | Definition | Initial response time | Examples |
|---|---|---|---|
| **P0** | Active loss event or imminent loss; protocol integrity compromised | Immediate (< 15 min acknowledgement) | Smart contract exploit in progress; admin EOA key confirmed leaked; aggregator submitting fraudulent proofs |
| **P1** | Material malfunction without immediate loss; high probability of escalation | Within 1 hour | Aggregator down for > 30 min; cross-validation pipeline producing false anomalies at scale; subgraph indexing halted; edge device confirmed compromised |
| **P2** | Significant degradation without integrity impact | Within 4 hours | Single edge device offline; one of three weather API providers down; monitoring dashboard inaccessible |
| **P3** | Minor degradation or potential issue under investigation | Within 1 business day | Slither finding in newly proposed contract change; suspicious-but-unconfirmed activity in logs |

Severity is set by the first responder and confirmed by the IC. Severity may be upgraded or downgraded as the incident develops; downgrades require IC approval.

---

## 4. Detection Sources

Incidents may be detected via:
- Public dashboard alerts (anomaly flag triggers)
- Subgraph health checks (indexing lag > threshold)
- Aggregator self-health endpoints
- Edge device heartbeat absence
- On-chain monitoring (`ProofSubmitted` event cadence deviations)
- External reports (security researchers, bug bounty submitters, community)
- Routine review of audit logs

Every detection source must funnel into a single triage point — at MVP this is a shared messaging channel monitored by the IC and the Security Lead.

---

## 5. Incident Response Lifecycle

The team follows the standard six-phase NIST 800-61 incident response lifecycle:

1. **Preparation** — see §8 (Drills and Maintenance)
2. **Detection and Analysis** — confirm incident is real, classify severity, scope blast radius
3. **Containment** — stop the bleeding; prevent escalation
4. **Eradication** — remove the root cause from the environment
5. **Recovery** — restore normal operations with verification
6. **Post-Incident Activity** — document, learn, improve

§§ 6 and 7 below detail the specific procedures for each common incident type.

---

## 6. Common Incident Types — Response Procedures

### 6.1 Smart contract bug discovered post-deployment

**Severity:** P0 if exploitable, P1 if not exploitable but material.

**Containment:**
1. IC calls Pause on `EnergyProofRegistryV3` via admin EOA: `cast send <V3_ADDRESS> "pause()" --rpc-url $SEPOLIA_RPC --private-key $ADMIN_KEY` (MVP) or via Gnosis Safe multisig (Phase 6 production).
2. Security Lead confirms pause is in effect: `cast call <V3_ADDRESS> "paused()(bool)" --rpc-url $SEPOLIA_RPC` should return `true`.
3. Operations Lead notifies any subscribed downstream consumers (issuers, dashboard users).

**Eradication:**
1. Security Lead reproduces the issue in a local fork.
2. Security Lead drafts a patch and accompanying test that demonstrates the fix.
3. Security Lead runs the full security regression: `forge test`, `slither .`, `forge coverage --ir-minimum`, Echidna fuzz against the patched contract.
4. IC approves the patch.

**Recovery:**
1. Deploy new implementation contract.
2. UUPS upgrade via `_authorizeUpgrade` (admin EOA at MVP; multisig + timelock at Phase 6 production).
3. Verify upgrade: `cast call <PROXY> "implementation()(address)"` returns new impl address.
4. Run end-to-end smoke test: `edge/scripts/sepolia_smoke.py`.
5. Unpause: `cast send <V3_ADDRESS> "unpause()"`.

**Compliance triggers:**
- If the bug affected attestations consumed by a real ART issuer (production scope only): MiCA Article 45 material event notification within issuer's required window.
- GDPR Article 33: only if personal data was exposed (not applicable at MVP).

### 6.2 Aggregator compromise

**Severity:** P0 — compromised aggregator can produce false proofs that pass cryptographic verification.

**Containment:**
1. Operations Lead immediately stops aggregator service.
2. Operations Lead rotates aggregator service credentials (Postgres password, any API keys).
3. Security Lead pauses on-chain contract while investigation runs (see §6.1 containment step).

**Eradication:**
1. Operations Lead provisions a clean aggregator host from a known-good snapshot.
2. Operations Lead deploys aggregator from a verified Git commit (signed tag).
3. Operations Lead loads only the encrypted Postgres backup from before the suspected compromise window.
4. Security Lead reviews the audit log for any submissions that occurred during the compromise window. Any suspicious submissions are flagged for downstream consumers.

**Recovery:**
1. Resume aggregator service.
2. Re-run end-to-end smoke test.
3. Unpause contract.
4. Communicate to subscribed consumers: dates/times of suspect submissions, recommended action (re-verify or discard).

**Compliance triggers:**
- MiCA Article 45 material event notification (production scope).
- GDPR Article 33: only if aggregator stored PII (Phase 6 scope only — not MVP).

### 6.3 Edge device compromise

**Severity:** P1 (single device) or P0 (multiple devices, indicating systemic firmware vulnerability).

**Containment:**
1. Operations Lead revokes device via `DeviceRegistry.revoke(deviceAddress)` — admin EOA call at MVP, multisig at Phase 6 production.
2. Verify revocation: `cast call <DEVICE_REGISTRY> "isAuthorized(address)(bool)" <DEVICE> --rpc-url $SEPOLIA_RPC` returns `false`.
3. Operations Lead physically isolates compromised device (power off, network disconnect).

**Eradication:**
1. Operations Lead performs forensic capture of device state (image of storage, log capture).
2. Security Lead reviews firmware and provisioning logs for the attack vector.
3. If firmware vulnerability is confirmed: emergency firmware patch is prepared and signed.
4. All other devices running affected firmware are flagged for immediate patch.

**Recovery:**
1. Reprovision the affected device with a new keypair (generate fresh, re-register in `DeviceRegistry`).
2. Patch all other affected devices.
3. Resume normal operation.

**Compliance triggers:**
- MiCA Article 45 notification if device backed a real ART (production scope).
- GDPR Article 33: not applicable (device pubkey is not personal data).

### 6.4 Admin EOA / multisig key exposure

**Severity:** P0 — admin authority is the protocol's highest privilege.

#### 6.4.1 MVP testnet posture — known limitation acknowledged

At MVP the protocol uses a single operator EOA (`0xD1Cb30374a2D0D1B3fd9830eAAFf527D5FC13f5f`) as the `DEFAULT_ADMIN_ROLE` holder. This is a deliberate scope reduction per §9.5 of the MVP plan, appropriate for testnet where **no real value is at stake**.

A compromised admin EOA on Sepolia testnet has the following blast radius:
- Attacker can pause, upgrade implementation, or transfer admin role on testnet contracts
- No real ART/EMT tokens are at risk (none exist on Sepolia)
- No real user funds are exposed
- No production reserve assets are affected

This containment procedure is therefore documented as **MVP testnet posture** — it would not be appropriate for production. The Phase 6 Production Hardening Sprint structurally eliminates the race-condition class of issues described below via Gnosis Safe multisig + timelock migration (see §6.4.3).

#### 6.4.2 MVP containment — legitimate operator wins by default

The MVP containment procedure assumes a discovery sequence where the legitimate operator becomes aware of key compromise **before the attacker has acted**. Under that assumption, the legitimate operator wins by being **first to broadcast**, not by winning a gas-priority race:

**Step 1 — Pre-stage the new admin (out-of-band, before any broadcast).** Operations Lead generates a fresh EOA on a clean machine and securely stores its private key. The new admin's public address is shared with the IC and Security Lead off-chain. **The compromised key holder has no visibility into this preparation.**

**Step 2 — IC broadcasts `grantRole` from the still-authoritative compromised EOA, with max gas price.**

```bash
cast send <V3_ADDRESS> "grantRole(bytes32,address)" \
  0x0000000000000000000000000000000000000000000000000000000000000000 \
  <NEW_ADMIN_ADDRESS> \
  --rpc-url $SEPOLIA_RPC \
  --private-key $OLD_ADMIN_KEY \
  --priority-gas-price 50gwei
```

This grants the new admin `DEFAULT_ADMIN_ROLE`. At this point, both old and new admins have authority. The attacker, if unaware of compromise discovery, has not yet acted.

**Step 3 — New admin broadcasts `revokeRole` against the compromised EOA, also with max gas price.**

```bash
cast send <V3_ADDRESS> "revokeRole(bytes32,address)" \
  0x0000000000000000000000000000000000000000000000000000000000000000 \
  <OLD_COMPROMISED_ADDRESS> \
  --rpc-url $SEPOLIA_RPC \
  --private-key $NEW_ADMIN_KEY \
  --priority-gas-price 50gwei
```

This revokes the compromised EOA's authority. The compromised key is now powerless.

**Step 4 — Verify revocation on-chain.**

```bash
cast call <V3_ADDRESS> "hasRole(bytes32,address)(bool)" \
  0x0000000000000000000000000000000000000000000000000000000000000000 \
  <OLD_COMPROMISED_ADDRESS> \
  --rpc-url $SEPOLIA_RPC
# Expected: false
```

```bash
cast call <V3_ADDRESS> "hasRole(bytes32,address)(bool)" \
  0x0000000000000000000000000000000000000000000000000000000000000000 \
  <NEW_ADMIN_ADDRESS> \
  --rpc-url $SEPOLIA_RPC
# Expected: true
```

**Race condition acknowledgement.** If the attacker is actively monitoring on-chain state and acts simultaneously, the outcome may depend on transaction priority. This is a known MVP testnet limitation, not a defensible production posture. The structural fix (multisig + timelock) is in Phase 6 production hardening (§6.4.3 below). On testnet, this race is acceptable because no real value is at risk and the legitimate operator typically discovers compromise via internal monitoring (off-chain alerts) before the attacker has acted.

#### 6.4.3 Phase 6 production containment — multisig + timelock

At Phase 6 production, `DEFAULT_ADMIN_ROLE` is held by a Gnosis Safe multisig (target threshold: 2-of-3). Admin actions are gated by a timelock (typically 48 hours).

**Containment procedure for compromised signer (one of N multisig signers exposed):**

1. Other multisig members initiate a Safe transaction removing the compromised signer and adding a replacement signer.
2. The 48-hour timelock delay applies. During this delay:
   - Protocol can be paused via the multisig (separate role with shorter timelock, or no timelock for pause-only operations)
   - Investigation proceeds in parallel
3. After timelock elapses, the signer removal/replacement executes.
4. Compromised signer is permanently removed.

**Why this is structurally stronger than MVP:**
- No single signer compromise enables unilateral malicious action — threshold N-of-M means attacker needs to compromise M-N+1 signers minimum to act.
- Timelock provides response window — even if M-N+1 signers were compromised, malicious transactions are visible during timelock and can be cancelled by remaining honest signers.
- No gas-priority race — the attacker cannot rush a malicious transaction past honest signers because honest signers control execution timing.

#### 6.4.4 Eradication (shared MVP and production)

1. Security Lead investigates the exposure vector (phishing, infrastructure compromise, insider, etc.).
2. Document root cause; update operational security procedures.
3. If exposure traces to a systemic vulnerability (not isolated phishing), all admin/signer credentials are rotated as preventive measure.

#### 6.4.5 Recovery (shared MVP and production)

1. Resume normal operation under new admin / new signer set.
2. Communicate the rotation to downstream consumers via established notification channels.

#### 6.4.6 Compliance triggers

- MiCA Article 45 material event notification (production scope only — MVP testnet does not back real ART).
- GDPR Article 33: only if exposed key protected PII (Phase 6 scope).

### 6.5 Database corruption

**Severity:** P1 if recent (< 24h), P2 if historical backup available.

**Containment:**
1. Operations Lead stops aggregator writes to prevent further corruption.
2. Operations Lead takes a snapshot of the current (corrupted) DB state for forensics.

**Eradication and Recovery:**
1. Restore Postgres from the most recent verified daily backup.
2. Replay on-chain `ProofSubmitted` events from the backup timestamp to present to reconstruct the indexed state.
3. Re-run smoke test.
4. Resume operations.

**Compliance triggers:** none unless personal data was lost (Phase 6 scope only).

### 6.6 Cross-validation provider outage

**Severity:** P2 (1 of 3 providers down) or P1 (2+ providers down).

**Containment:**
1. Operations Lead confirms via direct API health check (`curl` to each provider).
2. If 1 of 3 down: aggregator marks attestations as `ensemble_status=degraded` (existing behavior, Phase 4 closure). No action required — system continues operating with reduced validation strength.
3. If 2 of 3 down: aggregator pauses submissions to avoid attestations with insufficient cross-validation. IC decides whether to pause `EnergyProofRegistryV3` entirely.

**Recovery:**
1. Wait for provider(s) to recover, or
2. Add an alternative provider to the ensemble (requires aggregator config change and review).

**Compliance triggers:** none.

---

## 7. Communication Tree

### 7.1 Internal communication during incident

```
Detection
    ↓
First Responder (any team member)
    ↓ (within 15 min for P0/P1)
Incident Commander (Petro)
    ↓
Security Lead (Олександр) + Operations Lead (Тарас)
    ↓
Coordinated response per §6
```

### 7.2 External communication (Phase 6 production scope)

| Audience | Trigger | Timing | Owner |
|---|---|---|---|
| Subscribed ART/EMT issuers | P0/P1 affecting attestations | Within 1 hour of containment | IC |
| Dashboard / public users | P0/P1 with public-facing impact | Public status update within 4 hours | IC |
| Supervisory authority (MiCA Art. 45) | Material event affecting attestations consumed by ART issuer | Per issuer's MiCA obligations (issuer notifies; we provide technical evidence) | IC + Legal counsel |
| Supervisory authority (GDPR Art. 33) | Personal data breach | Within 72 hours of awareness | DPO + IC |
| Bug bounty / security researcher (if reported) | Acknowledgement of report | Within 24 hours | Security Lead |

---

## 8. Drills and Maintenance

### 8.1 Drill schedule

| Frequency | Drill type |
|---|---|
| Quarterly | Tabletop exercise: walk through one P0 scenario from §6 |
| Semi-annually | Live drill: actually execute pause, key rotation, recovery in test environment |
| Before each major release | Smoke-test the incident detection path end-to-end |
| After each real incident | Update playbook based on lessons learned |

### 8.2 Playbook maintenance

- This document is reviewed by the IC and Security Lead at minimum every six months.
- After every real incident, the post-incident review (see §9) identifies playbook updates.
- All updates are tracked in §11 (Revision History).

---

## 9. Post-Incident Review Template

Every P0 and P1 incident produces a post-incident review document, completed within 7 days of incident closure. Template:

```
# Post-Incident Review: [INC-YYYY-MM-DD-NN]

**Severity:** P0 | P1
**Detection time:** YYYY-MM-DD HH:MM UTC
**Containment time:** YYYY-MM-DD HH:MM UTC
**Resolution time:** YYYY-MM-DD HH:MM UTC
**Total impact duration:** [hours]

## 1. Summary
[Single paragraph — what happened, what was affected, how it was resolved]

## 2. Timeline
[Chronological log of all actions taken, with timestamps]

## 3. Root cause analysis
[Five-whys or equivalent technique — the underlying cause, not just the symptom]

## 4. What went well
[Specific actions, decisions, or capabilities that worked]

## 5. What went poorly
[Specific gaps in detection, response, or recovery]

## 6. Action items
| ID | Action | Owner | Due |
|---|---|---|---|
| AI-1 | ... | ... | ... |

## 7. Customer / consumer impact
[Who was affected, how, and what communication was issued]

## 8. Compliance reporting
[Any regulator notifications issued, any pending]

## 9. Sign-off
- IC: ...
- Security Lead: ...
- Operations Lead: ...
```

The completed review is archived in `docs/incidents/` (private subdirectory) with the assigned incident ID.

---

## 10. References

- NIST SP 800-61 Rev. 2 — Computer Security Incident Handling Guide
- Regulation (EU) 2023/1114 — MiCA Article 45 (continuous monitoring obligations)
- Regulation (EU) 2016/679 — GDPR Article 33 (breach notification)
- `InfraVeritas_Energy_Architecture_updated.md` — full architectural roadmap
- `mica-article-36-45-mapping.md` — companion compliance document
- `gdpr-review.md` — companion data protection document
- `docs/security/pre-audit-security-report.md` — current security posture baseline

---

## 11. Revision History

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-05-17 | InfraVeritas Energy team | Initial draft as part of Phase 5 compliance package |
| 0.2 | 2026-05-17 | InfraVeritas Energy team | Rewrote §6.4 admin EOA compromise: lead with legitimate-operator-wins path (`grantRole` from old admin → `revokeRole` from new admin), acknowledge race condition as MVP testnet limitation explicitly tied to no-real-value-at-stake context, separate §6.4.3 documenting Phase 6 multisig+timelock as structural elimination of race class; aligned all Phase references to Phase 6 production hardening sprint; added investment-grade framing in §1 about institutional security engineering standards; removed unverified Architecture document cross-references |

---

*End of document.*
