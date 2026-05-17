# GDPR Compliance Review

**Document type:** Data protection compliance review (pre-audit, MVP scope)
**Status:** Draft v0.2 — internal pre-audit deliverable
**Date:** 2026-05-17
**Project:** InfraVeritas Energy MVP
**Regulation:** Regulation (EU) 2016/679 — General Data Protection Regulation (GDPR)
**Scope:** Sepolia testnet deployment + Phase 6 production roadmap (OperatorRegistry layer)

---

## 1. Executive Summary

The InfraVeritas Energy MVP is designed with a **data minimization** posture from the outset: at the MVP layer, the protocol collects and processes **no personal data** as defined under Article 4(1) GDPR. All on-chain identifiers are cryptographic device public keys, and all off-chain processing operates on energy measurement readings without subject identifiers.

This minimal posture is **deliberate and structural**, not incidental. The architecture keeps data subjects (where they later exist as operators) outside the cryptographic verification path entirely. Personal data enters the system only at the Phase 6 `OperatorRegistry` layer, where operators of physical assets undergo KYC for production-grade deployments — and there, by design, all personal data remains off-chain with only cryptographic hash commitments on-chain.

**This Privacy-by-Design architecture is an institutional credibility advantage**, not a happy accident. Many blockchain protocols struggle to reconcile immutability with Article 17 (right to erasure). InfraVeritas Energy resolves this tension at the architectural layer: on-chain artifacts contain no personal data, all personal data lives in controlled off-chain storage that supports lawful deletion. The pattern is well-aligned with prevailing EDPB and national DPA guidance on blockchain protocols, subject to confirmation by qualified counsel.

This document:
1. Confirms the MVP's "no PII" status with article-by-article analysis
2. Maps the Phase 6 production scope to GDPR requirements
3. Addresses the blockchain–immutability vs. right-to-erasure tension (Article 17)
4. Documents residual risks and recommended mitigations
5. Articulates the consent flow architecture that handles all operator categories (legal persons and natural persons) from baseline OperatorRegistry design

**Headline finding:** at MVP scope, GDPR exposure is essentially nil. At Phase 6 production scope, GDPR obligations attach and a Data Processing Agreement (DPA) plus a Data Protection Impact Assessment (DPIA) become mandatory before live deployment. Both are explicitly scoped within Phase 6 milestones, not deferred indefinitely.

---

## 2. Scope and Data Flow Analysis

### 2.1 What data flows through the MVP?

| Data category | Where it lives | Personal data? |
|---|---|---|
| Device public key (P-256 ECDSA) | On-chain `DeviceRegistry`, edge device PEM, aggregator DB | No — cryptographic artifact, not linked to a natural person at MVP |
| Device geographic coordinates (lat/lon as int32, scaled 1e7) | On-chain `DeviceRegistry` | Depends — see §2.3 below |
| Energy readings (voltage_mv, current_ma, timestamp_ms) | Edge device, aggregator Postgres, hypertable | No — physical measurements, no subject linkage |
| Session keys, signatures, ZK proofs | Aggregator + on-chain | No — cryptographic artifacts |
| Aggregator operator credentials (admin EOA) | Off-chain | No at MVP — single operator EOA, not subject to KYC |
| Weather/grid API responses (Open-Meteo, NASA POWER, PVGIS) | Aggregator validation pipeline | No — third-party public data |

### 2.2 What data is **not** collected at MVP?

The MVP explicitly does not collect:
- Names, addresses, contact details of any natural person
- Email addresses, phone numbers
- Government identifiers (national ID, tax ID)
- Financial account information
- Biometric or special-category data (Article 9)
- IP addresses linked to identifiable users (aggregator logs may capture IP for security purposes only; see §3.6)

### 2.3 Operator categories and the coordinate-as-identifier question

Device geographic coordinates are stored on-chain at high precision (decimal-degree × 10^7, sub-meter resolution). Whether these coordinates constitute personal data depends on operator category.

**Operator categories supported by InfraVeritas Energy (from baseline OperatorRegistry design):**

| Category | Examples | Coordinate-as-PII status |
|---|---|---|
| **Legal-person operators** | Energy companies, infrastructure operators, utility cooperatives | Not personal data — coordinates identify a corporate facility, not a natural person |
| **Consortium operators** | Multi-stakeholder agreements, energy communities | Generally not personal data (entity is the data subject), but consent flow required for transparency |
| **Natural-person operators** | Sole proprietors, family-owned generation facilities, residential installations | **Coordinates may indirectly identify the natural person** under Article 4(1) GDPR |

**Mitigation at MVP (testnet only):** documented operational practice that test devices are deployed at non-residential locations (research facilities, commercial energy installations). No real personal residence coordinates appear in MVP `DeviceRegistry` records.

**Mitigation at Phase 6 production (architectural baseline):**
1. The `OperatorRegistry` SBT design supports all three operator categories from day one — natural-person operators are a **first-class category**, not an edge-case afterthought.
2. For natural-person operators, the registration flow includes an explicit **consent layer** at provisioning time, satisfying Articles 6(1)(a) and 7 GDPR.
3. The privacy notice presented at registration covers coordinate precision, retention period, and the operator's GDPR rights including erasure (see §3.4).
4. Coordinate precision may be configurable per operator category — full precision for legal persons, optionally truncated for residential installations where exact location is not required for verification utility.

The consent flow is part of the **baseline OperatorRegistry implementation in Phase 6**, not a future addition. Treating natural-person operators as a first-class category rather than an edge case is a deliberate architectural choice that scales the protocol toward broader DePIN-style adoption without retroactive GDPR retrofits.

---

## 3. Article-by-Article Analysis

### 3.1 Article 5 — Principles relating to processing

| Principle | MVP posture | Production posture (Phase 6) |
|---|---|---|
| Lawfulness, fairness, transparency | N/A at MVP (no personal data) | Consent (Art. 6(1)(a)) for natural-person operators; contract (Art. 6(1)(b)) for legal-person operators |
| Purpose limitation | N/A | Limited to operator verification + regulatory compliance |
| Data minimization | Structurally enforced — no PII collected | Only KYC data strictly required for ERC-3643 compliance; coordinate precision configurable by category |
| Accuracy | N/A | Operator can update profile data; immutable on-chain hash only |
| Storage limitation | N/A | Off-chain PII retained for regulatory retention period only |
| Integrity and confidentiality | Cryptographic device authentication + TLS | Plus encryption at rest (SQLCipher / Postgres TDE) for off-chain PII |
| Accountability | This document + architectural docs | Plus DPIA + DPO designation if scale warrants |

### 3.2 Article 6 — Lawful basis for processing

At MVP: no processing of personal data, so Article 6 is not triggered.

At Phase 6 production:
- **Article 6(1)(a)** — consent: explicit consent at registration time for natural-person operators (baseline OperatorRegistry consent flow)
- **Article 6(1)(b)** — performance of a contract: operator KYC is required to onboard operators under the protocol's terms of service
- **Article 6(1)(c)** — legal obligation: KYC may be required under MiCA, AMLD5/6, or national law applicable to the issuer
- **Article 6(1)(f)** — legitimate interest: limited use (e.g., security audit logs) where contract basis does not apply

A formal Records of Processing Activities (Article 30) document will be required before Phase 6 production deployment.

### 3.3 Article 15 — Right of access

At MVP: not applicable (no personal data).

At production: data subjects (operators) have the right to receive a copy of their personal data. The protocol architecture supports this because:
- All operator personal data lives off-chain in a controlled Postgres database
- Only operator pubkey + identifier hash is committed on-chain via `OperatorRegistry` SBT
- An access request can be fulfilled by querying the off-chain DB without touching the chain

### 3.4 Article 17 — Right to erasure ("right to be forgotten")

**This is the single most consequential GDPR consideration for blockchain protocols and warrants explicit treatment.**

#### 3.4.1 The tension

Article 17 GDPR confers a right to erasure of personal data when one of the grounds in Article 17(1) applies. Public permissionless blockchains are, by design, immutable: once data is committed on-chain it cannot be deleted.

If personal data is written directly to a blockchain, the controller cannot satisfy a valid erasure request without forking the chain — which is not a controlled action available to a single protocol operator.

#### 3.4.2 InfraVeritas Energy approach

The protocol architecture is **designed to mitigate this tension** by ensuring:

1. **No personal data is written directly on-chain.** On-chain `OperatorRegistry` (Phase 6) stores only:
   - Operator pubkey (cryptographic identifier, not personal data per se)
   - A hash of the operator's KYC record
   - A status flag (active / revoked)

2. **All personal data lives off-chain in a controlled database.** The off-chain database can be modified, deleted, or selectively redacted by the data controller.

3. **An erasure request is fulfilled by:**
   - Deleting the personal data record off-chain
   - Recording a revocation event on-chain (which marks the operator as "withdrawn" but does not contain personal data)
   - Notifying the data subject that the on-chain hash will remain, but is not personal data because the off-chain record it commits to has been destroyed

4. **The on-chain hash without the off-chain record is treated as non-personal data under the prevailing interpretation.** Under EDPB and national DPA guidance on blockchain protocols (including CNIL's published guidance), a cryptographic hash of personal data, in isolation, is generally not treated as personal data once the underlying record is destroyed and re-identification is computationally infeasible. **This interpretation is jurisdiction-dependent and must be confirmed with qualified counsel before production deployment.** This document does not constitute legal advice and should not be relied upon as the sole basis for compliance decisions.

#### 3.4.3 Operational procedure for an erasure request

| Step | Action | Responsible |
|---|---|---|
| 1 | Receive erasure request (email, written) | Data Protection Officer / Phase 6 operator-relations function |
| 2 | Verify requester identity | DPO |
| 3 | Confirm no legal basis for retention overrides (e.g., AML retention obligations) | Legal counsel |
| 4 | Delete off-chain PII record | Database administrator |
| 5 | Submit on-chain `OperatorRegistry.revoke(operatorAddress)` transaction | Multisig signers (Phase 6 governance) |
| 6 | Issue written confirmation of erasure to subject | DPO |
| 7 | Log the entire procedure in the audit trail | DPO |

This procedure must be implemented before Phase 6 production deployment. The MVP does not implement it because no personal data is collected.

### 3.5 Article 25 — Data protection by design and by default

The "no PII at MVP, hash-only at production" architecture is itself a Privacy-by-Design implementation. Key features:

- **By design:** the protocol's verification mathematics does not require subject identification. Energy proofs verify physical reality, not natural persons.
- **By default:** the default registration flow does not request optional personal data. KYC fields are strictly limited to what is required for the issuer's ERC-3643 compliance module.
- **By category:** the OperatorRegistry handles natural-person operators (residential, sole proprietor) as a first-class category with explicit consent flow, not as a retrofit.

### 3.6 Article 32 — Security of processing

At MVP, the only data flow with security implications is the aggregator's operational logs, which may contain IP addresses of edge devices for diagnostic purposes.

**MVP security measures:**
- TLS termination at aggregator ingress (HTTPS only)
- Authentication of edge submissions via P-256 ECDSA signatures
- Postgres credentials via environment variables (not committed to repo)
- Edge device PEM keys stored at `0600` permissions, gitignored
- No exposure of internal services to public internet (reverse proxy + firewall)

**Phase 6 production additions:**
- Encryption at rest for off-chain PII (SQLCipher or Postgres TDE)
- Network segmentation between aggregator and KYC subsystem
- Hardware Security Module (HSM) for KYC data encryption keys
- Audit logging of all PII access events
- Penetration testing before production launch (Phase 7 audit scope)

### 3.7 Article 33 — Notification of personal data breach

At MVP: not applicable (no personal data).

At production: a personal data breach must be notified to the supervisory authority within 72 hours of becoming aware of it. The Incident Response Playbook (`incident-response-playbook.md`) includes the 72-hour notification procedure as a P0/P1 incident response item.

### 3.8 Article 35 — Data Protection Impact Assessment (DPIA)

At MVP: not applicable (no high-risk processing).

At production: a DPIA is **likely mandatory** because the production scope involves:
- Systematic monitoring (Article 35(3)(c)) — continuous on-chain attestation linked to operator identities
- Use of new technological solutions (blockchain + zero-knowledge proofs)
- Potential cross-border data transfer (if operators are based outside EU/EEA)

The DPIA must be completed before Phase 6 production deployment. A DPIA template will be authored as a separate deliverable when Phase 6 implementation begins.

---

## 4. Cross-Border Data Transfer Considerations

The MVP does not transfer personal data (because it processes none). At production, if any operator is established outside the EU/EEA:

- Transfers to adequacy-decision countries: no additional safeguards required (Article 45 GDPR)
- Transfers to non-adequacy countries: Standard Contractual Clauses (SCCs) under the 2021 EU SCCs, or appropriate alternative safeguard under Article 46
- Schrems II considerations: documented Transfer Impact Assessment for transfers to high-risk jurisdictions

This will be revisited as part of the DPIA in Phase 6.

---

## 5. Data Processing Agreement (DPA) — Phase 6 Template Reference

The MVP does not require a DPA because there is no controller-processor relationship over personal data.

At production (Phase 6), where InfraVeritas Energy may process operator KYC data on behalf of ART/EMT issuers, a DPA under Article 28 will be required. Reference template scope:

- Subject matter and duration of processing
- Nature and purpose of processing
- Type of personal data and categories of data subjects
- Obligations and rights of the controller (issuer)
- Processor obligations: confidentiality, security, sub-processor management, assistance with DSR, deletion at end of contract
- Audit rights
- Sub-processor list

A reference DPA template will be authored alongside the DPIA when Phase 6 implementation begins.

---

## 6. Residual Risks and Open Items

### 6.1 Residual risks at MVP

| Risk | Severity | Mitigation |
|---|---|---|
| Device coordinates indirectly identify a natural person | Low | Documented operational practice — non-residential test deployments only at MVP |
| Aggregator logs capture identifying metadata (e.g., diagnostic IP addresses) | Low | Log retention policy: 30 days, no cross-correlation with external identifiers |
| Edge device PEM key compromise reveals device identity | N/A | Not a GDPR risk — pubkey is not personal data |

### 6.2 Phase 6 production prerequisites — engineered, not deferred

The Phase 6 Production Hardening Sprint includes the following GDPR-mandatory deliverables. These are not "later" items — they are scoped within the same sprint as multisig admin migration and OperatorRegistry SBT deployment:

- [ ] Qualified data protection counsel review of this document
- [ ] DPIA completion
- [ ] DPA template authoring
- [ ] Records of Processing Activities (Article 30)
- [ ] DPO designation (if processing scale warrants)
- [ ] Privacy notice authoring (data subject-facing)
- [ ] Consent flow implementation for natural-person operators (baseline OperatorRegistry design)
- [ ] SCC/TIA preparation for non-EU operator onboarding
- [ ] Penetration testing of off-chain PII subsystem

The cost and timeline for qualified DPO/counsel engagement are anticipated and scoped within Phase 6 budget. None of these items are deferred to mainnet or post-launch.

---

## 7. Conclusion

The InfraVeritas Energy MVP is, by architectural design, outside the operative scope of the GDPR: no personal data is collected, processed, stored, or transferred at the MVP layer. This is a deliberate Privacy-by-Design property, not an accident.

Production deployment (Phase 6) introduces personal data via the `OperatorRegistry` KYC layer. At that point, a full GDPR compliance program — DPIA, DPA, RoPA, DPO designation (if required), privacy notice, consent flows for natural-person operators, breach notification procedures — must be in place before live operation. All of these obligations are explicitly scoped within the Phase 6 sprint, not deferred to mainnet or post-launch.

The architectural separation of "on-chain cryptographic commitments + off-chain personal data" is **designed to mitigate** the well-known blockchain–GDPR tension around Article 17 (right to erasure), aligned with prevailing EDPB and national DPA guidance — **subject to qualified counsel review before production deployment**.

This design property is one of the protocol's institutional credibility advantages and should be highlighted in regulatory dialogue. Investors evaluating this protocol are evaluating Privacy-by-Design as a baseline architectural property, not a future feature commitment.

---

## 8. References

- Regulation (EU) 2016/679 — General Data Protection Regulation
- EDPB guidance on personal data on public blockchains (consult current EDPB document repository: https://www.edpb.europa.eu/our-work-tools/our-documents/opinions_en)
- CNIL guidance on blockchain and GDPR (consult current CNIL publication index)
- Court of Justice judgment in Schrems II (Case C-311/18)
- `InfraVeritas_Energy_Architecture_updated.md` — full architectural roadmap
- `mica-article-36-45-mapping.md` — companion compliance document
- `incident-response-playbook.md` — companion operational document (Article 33 procedure)

---

## 9. Revision History

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-05-17 | InfraVeritas Energy team | Initial draft as part of Phase 5 compliance package |
| 0.2 | 2026-05-17 | InfraVeritas Energy team | Reframed natural-person operators from "edge case" to first-class operator category; added consent flow as baseline OperatorRegistry design; generalized EDPB/CNIL references pending verification; tightened §7 conclusion to match §3.4.2 nuance; removed unverified cross-references; investment-grade Privacy-by-Design framing |

---

*End of document.*
