# MiCA Article 36 and Article 45 Compliance Mapping

**Document type:** Regulatory compliance mapping (pre-audit, MVP scope)
**Status:** Draft v0.2 — internal pre-audit deliverable
**Date:** 2026-05-17
**Project:** InfraVeritas Energy MVP
**Scope:** Sepolia testnet deployment — `EnergyProofRegistryV3`, `DeviceRegistry`, `P256VerifierAdapter`, aggregator pipeline, edge device firmware
**Authoritative for:** the current MVP scope on Sepolia testnet. Production deployment requires qualified MiCA legal counsel review and updated mapping.

---

## 1. Executive Summary

This document maps the technical functionality of the InfraVeritas Energy MVP to the requirements of Articles 36 and 45 of Regulation (EU) 2023/1114 on Markets in Crypto-Assets ("MiCA"). The MVP is a verification protocol for physical energy generation assets, designed to provide cryptographically secured, continuously updated attestations of physical reality that can serve as input to issuers of Asset-Referenced Tokens (ART) or Electronic Money Tokens (EMT) backed by tokenized energy infrastructure.

The MVP itself is **not** an issuer of crypto-assets under MiCA. It is verification infrastructure that ART/EMT issuers can integrate to satisfy their own due diligence and ongoing monitoring obligations. The mapping in this document therefore describes how InfraVeritas Energy supports a downstream issuer's compliance posture, not the protocol's direct subjection to MiCA.

**Coverage achieved at MVP:**
- Continuous, cryptographically verifiable physical asset attestation
- On-chain audit trail of every attestation event (`ProofSubmitted`)
- Cross-validation against three independent external reality sources
- Device-level identity binding via on-chain `DeviceRegistry`
- Tamper detection and anomaly flagging surfaced to the issuer

**Engineered upgrade path to production:**
The MVP's documented limitations (single aggregator, EOA admin, no production multisig) are **deliberate scope reductions**, not architectural constraints. Each is paired with a concrete production migration plan in §7 below. The protocol is engineered to transition from MVP to production via a **Phase 6 Production Hardening Sprint** (multisig admin migration + OperatorRegistry SBT + consent flow architecture), followed by external audit (Phase 7) and mainnet deployment (Phase 8).

**Why this matters for institutional integration:** the gap between MVP testnet and production deployment is **single-sprint scope**, not multi-quarter. Family offices and institutional investors evaluating this protocol are evaluating a system with **verifiable testnet baseline plus engineered production migration**, not a research prototype.

A qualified MiCA legal counsel review remains **mandatory** before this mapping is used in any production or investor-facing regulatory submission.

---

## 2. Scope and Applicability

### 2.1 In scope

This mapping applies to:
- Smart contracts deployed on Sepolia testnet:
  - `EnergyProofRegistryV3` at `0xf21d900e43214b0abf489f8d6862352aabb09da3`
  - `DeviceRegistry` at `0x6249935e8f293cac2a7c4ce3717a14a8b1e83e03`
  - `P256VerifierAdapter` at `0x690ee97c3c77Dd5B8Fe162eAae45c0944cfd44a0`
  - `HonkVerifier` (active) at `0xAaEaEDA7e14966a2B69c276e20190316990c08Fc`
- Off-chain aggregator pipeline (`@aztec/bb.js` 5.0.0-nightly.20260324, Postgres + TimescaleDB)
- Edge device firmware (PEM keypair MVP, ATECC608B HSM in Phase 2)
- Cross-validation layer (Open-Meteo, NASA POWER, PVGIS APIs)
- Monitoring layer (The Graph subgraph v0.0.2, public dashboard)

### 2.2 Out of scope

This mapping does **not** cover:
- Token issuance, transfer, or redemption mechanics (responsibility of downstream ART/EMT issuer)
- KYC/AML procedures for token holders (responsibility of issuer and ERC-3643 compliance modules)
- Reserve composition, custody, or investment rules (Article 37, Article 38 — issuer responsibilities)
- Whitepaper publication obligations (Title II MiCA — issuer responsibility)
- MiCA authorization or notification procedures (issuer responsibility under Article 16 et seq.)

InfraVeritas Energy provides one input — verified physical reality — to the issuer's overall compliance machinery. The issuer remains responsible for end-to-end MiCA compliance.

---

## 3. MiCA Article 36 — Due Diligence on Reserve Assets

### 3.1 Regulatory text (paraphrased, project framing)

Article 36 of MiCA (Title III, Chapter 3) governs the formation and management of the asset reserve backing Asset-Referenced Tokens. Issuers must demonstrate that the reserve assets exist, that their composition matches what is disclosed in the whitepaper, and that the reserve is managed prudently with continuous assessment.

For ARTs backed by tokenized physical infrastructure (energy generation in this case), this requirement is operationalized as: the issuer must be able to prove, at any point in time, that the physical generation capacity exists, is operational, and produces the claimed energy output.

### 3.2 InfraVeritas Energy mapping

| Article 36 requirement | InfraVeritas Energy mechanism | Evidence |
|---|---|---|
| Reserve asset existence | Edge device with P-256 signature + GPS coordinates within `DeviceRegistry` allowlist | On-chain device record, `DeviceRegistry.isAuthorized(deviceId)` returns true |
| Asset matches whitepaper specification | Device pubkey, lat/lon, and operator binding registered at provisioning; immutable post-registration | `DeviceRegistry.devices[deviceId]` returns full registration record |
| Continuous assessment | Periodic energy proofs submitted to chain at fixed cadence with monotonic timestamps | `ProofSubmitted` event stream queryable via subgraph or `eth_getLogs` |
| Prudent management — anomaly detection | Cross-validation against 3 independent weather APIs before submission | Aggregator logs + `validation_results` table in Postgres |
| Tamper resistance | ATECC608B HSM (Phase 2 production) or persistent PEM keypair (MVP) — private key never leaves device | Hardware Root of Trust per Phase 2 architectural roadmap |
| Audit trail | Every submission is an immutable on-chain event with full public input hash | `ProofSubmitted(deviceId, epochStart, energyMwh, pubInputsHash)` |

### 3.3 Acceptance criteria

A downstream ART issuer relying on InfraVeritas Energy for Article 36 due diligence support should be able to:
1. Verify that the reserve-backing energy asset is registered in `DeviceRegistry`
2. Retrieve the most recent `ProofSubmitted` event for that device
3. Verify the ZK proof on-chain via `HonkVerifier`
4. Cross-check the reported energy output against the issuer's claimed reserve composition
5. Detect deviations (anomaly flags) and trigger their own Article 36 escalation procedures

All five of the above are demonstrably possible with the MVP deployment on Sepolia and can be exercised against the public dashboard and subgraph endpoints.

---

## 4. MiCA Article 45 — Continuous Monitoring of Reserve Assets

### 4.1 Regulatory text (paraphrased, project framing)

Article 45 of MiCA imposes ongoing obligations on ART issuers to continuously monitor the reserve assets, promptly update investor-facing disclosures when material changes occur, and report significant deviations to the competent authority. The "fire-and-forget" verification model (one-time attestation at token issuance) is explicitly insufficient.

For physical-asset-backed ARTs, this means the verification mechanism must produce a continuous stream of attestations, not a single audit report.

### 4.2 InfraVeritas Energy mapping

| Article 45 requirement | InfraVeritas Energy mechanism | Cadence |
|---|---|---|
| Continuous attestation stream | Periodic energy proofs per epoch | Configurable per deployment; MVP demonstrates sub-hourly cadence |
| Monotonic timestamps | Enforced on-chain via `timestampMonotonicPerDevice` invariant (Echidna-verified, 100M tx, 0 violations) | Per-submission |
| Anomaly detection | Cross-validation aggregator with binary anomaly flag (Phase 4 closed 2026-05-15) | Per-submission |
| Immutable historical record | On-chain `ProofSubmitted` events, indexed by The Graph subgraph v0.0.2 | Per-block |
| Public disclosure | Public dashboard surfaces live and historical attestations | Per-submission |
| Severity escalation | Anomaly flag exposed via subgraph; issuer can subscribe and trigger Article 45 reporting | Per-submission |

### 4.3 "Promptly update" — operational definition

MiCA Article 45 requires "prompt" disclosure of material changes. InfraVeritas Energy operationalizes this as:
- Attestation latency: edge → aggregator → on-chain submission completes in ~11 seconds on Sepolia (Phase 1 closure benchmark, 2026-05-14)
- Cross-validation latency: ~27 seconds end-to-end including all three weather APIs (Phase 4 closure benchmark, 2026-05-15)
- Subgraph indexing latency: ~1-2 blocks after submission
- Total time from physical event to publicly disclosed on-chain record: under 1 minute on Sepolia

This latency profile supports a "prompt update" interpretation in line with Article 45 obligations. Production deployment on a settlement L2 (Arbitrum, Base, Optimism) is expected to maintain a similar profile.

### 4.4 Acceptance criteria

An ART issuer should be able to demonstrate Article 45 compliance by showing:
1. Live subgraph queries returning recent attestations for the backing asset
2. A monitoring system (their own or InfraVeritas-provided) that alerts on anomaly flags
3. A documented procedure for translating an anomaly flag into a regulator notification
4. An incident response procedure (see `incident-response-playbook.md` for InfraVeritas Energy reference template)

---

## 5. EBA Technical Standards Alignment

### 5.1 Applicable EBA framework

The EBA has published a package of Regulatory Technical Standards (RTS) and Opinions under MiCAR governing prudential matters for ART/EMT issuers — covering own funds, liquidity requirements, reserve composition, and recovery plans. The relevant RTS and Opinions are listed in the EBA's MiCAR technical standards repository (https://www.eba.europa.eu/regulation-and-policy/asset-referenced-and-e-money-tokens-mica).

InfraVeritas Energy provides physical-reality attestation that downstream ART issuers consume as input to their compliance with these EBA technical standards. The protocol itself is not directly subject to EBA prudential requirements (those apply to authorized issuers, not to verification infrastructure providers).

### 5.2 Compatibility statement

The MVP emits structured on-chain event data (Solidity events with typed fields) that can be transformed into iXBRL or any other regulatory reporting format by a downstream reporting layer. This transformation is straightforward and is in scope for post-MVP production extensions. The MVP itself does not emit regulatory reporting formats directly.

---

## 6. ERC-3643 Physical Compliance Extension Integration

### 6.1 Design intent

ERC-3643 (T-REX protocol) is the leading standard for permissioned tokens representing regulated securities. Its compliance module architecture allows pluggable "compliance checks" that gate token transfers based on KYC, jurisdiction, and other rules.

InfraVeritas Energy is designed to plug into this architecture as a **Physical Compliance Extension** — an additional compliance check that gates token transfers based on the physical state of the backing asset (e.g., refuse transfers if the asset has been offline for more than N epochs, or if anomaly flags exceed a threshold).

### 6.2 MVP integration

At MVP, the protocol exposes:
- A read-only view function on `EnergyProofRegistryV3` returning the most recent submission timestamp and anomaly flag for a given device
- A subgraph entity surfacing the same data via GraphQL

An ERC-3643 compliance module wrapper can call these surfaces to implement physical-state gating. Reference implementation is in scope for Phase 6 Production Hardening Sprint, alongside `OperatorRegistry` SBT integration.

### 6.3 Submission to ERC-3643 Association

The IPAS Standard v1.0 (separate document) has been formally submitted to the ERC-3643 Association as a candidate Physical Compliance Extension. Engagement is ongoing.

---

## 7. Production Migration Roadmap and MVP Limitations

This section explicitly articulates the engineered path from MVP testnet to production deployment. Each MVP limitation is paired with a concrete migration milestone.

### 7.1 Testnet vs. production deployment

The MVP runs on Ethereum Sepolia testnet. No real Asset-Referenced Tokens are issued against MVP attestations. The production deployment path is:

| Stage | Milestone | Scope |
|---|---|---|
| MVP (current) | Sepolia testnet operational | Full pipeline edge → aggregator → on-chain → subgraph → dashboard; pre-audit security baseline complete |
| Phase 6 | Production Hardening Sprint | Gnosis Safe multisig admin migration + `OperatorRegistry` SBT + consent flow architecture + production-grade infrastructure |
| Phase 7 | External Audit | Hacken or Sherlock retainer; bug bounty program initiation |
| Phase 8 | Mainnet deployment | Migration to production settlement L2 (Arbitrum, Base, Optimism); live ART/EMT integration |

### 7.2 Single aggregator at MVP

The MVP runs a single aggregator. This is a deliberate scope reduction per §9.5 of the MVP plan. Phase 6 hardening introduces a multi-aggregator quorum (2-of-3 or 3-of-5; see Architecture roadmap for the open decision). The architectural rationale for multi-aggregator quorum is documented and the migration is structural, not invasive — the smart contract layer is agnostic to aggregator count.

### 7.3 Admin governance migration — multisig

**MVP posture:** admin functions execute via a single operator EOA at `0xD1Cb30374a2D0D1B3fd9830eAAFf527D5FC13f5f`. This is a deliberate scope reduction per §9.5 of the MVP plan and is appropriate for testnet where no real value is at stake.

**Production posture:** Phase 6 Production Hardening Sprint migrates `DEFAULT_ADMIN_ROLE` from the single EOA to a Gnosis Safe multisig (target threshold: 2-of-3 with timelock for upgrades). Migration is **pre-mainnet** — production multisig deployment, signer onboarding, and timelock parameter selection are completed **before** the external audit engagement (Phase 7) begins.

The race condition documented in the Incident Response Playbook §6.4 for MVP admin EOA compromise is a known MVP testnet limitation that the Phase 6 multisig migration structurally eliminates. Investors evaluating this protocol should understand:
- The MVP race window is testnet-only — no real value is at risk during this window.
- The structural fix (multisig + timelock) is engineered, scoped, and on the immediate production critical path — not deferred to mainnet.

### 7.4 Consent flow and operator categories

The `OperatorRegistry` SBT (deployed in Phase 6) supports multiple operator categories from baseline design, not as an afterthought:
- Legal-person operators (energy companies, infrastructure operators) — primary commercial target
- Natural-person operators (sole proprietors, family-owned generation facilities, residential installations)
- Consortium operators (multi-stakeholder arrangements)

For natural-person operators, the OperatorRegistry includes a documented consent flow at registration time, ensuring GDPR-compatible onboarding. See `gdpr-review.md` §3.4 and §6.2 for detail.

### 7.5 Regulator notification channel

The MVP does not include a formal regulator notification channel for material anomalies. An ART issuer integrating InfraVeritas Energy must implement its own translation layer between anomaly flags and regulator notifications. Reference template is provided in `incident-response-playbook.md`.

### 7.6 Qualified counsel review

This mapping has not been reviewed by qualified MiCA legal counsel. Production deployment supporting real ART issuance **requires** such review and is a documented Phase 6 / pre-mainnet precondition. The cost and timeline for qualified counsel engagement are anticipated and scoped within Phase 6 budget.

---

## 8. References

### 8.1 Regulatory sources

- Regulation (EU) 2023/1114 — Markets in Crypto-Assets (MiCAR)
- EBA technical standards under MiCAR — published at https://www.eba.europa.eu/regulation-and-policy/asset-referenced-and-e-money-tokens-mica
- ERC-3643 — T-REX protocol specification

### 8.2 Project documents

- `InfraVeritas_Energy_Architecture_updated.md` — full architectural roadmap (Phase 0–8)
- `InfraVeritas_MVP_Plan_v1_4_extended.md` — MVP scope and deliverables
- `docs/specs/V3_design.md` — V3 contract design specification
- `docs/security/pre-audit-security-report.md` — composite pre-audit security results
- `IPAS_Verification_Standard_v1.0.pdf` — Physical Compliance Extension submission

### 8.3 On-chain artifacts

- Sepolia chain ID: 11155111
- Deployment manifest: `deployments/sepolia-mvp-2026-05.json`
- Subgraph: hosted Phase 5 monitoring layer v0.0.2

---

## 9. Revision History

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-05-17 | InfraVeritas Energy team | Initial draft as part of Phase 5 compliance package |
| 0.2 | 2026-05-17 | InfraVeritas Energy team | Fixed EBA citation accuracy; removed unverified cross-references; reframed multisig migration as Phase 6 (pre-audit, pre-mainnet); added explicit production migration roadmap section; investment-grade framing for engineered upgrade path |

---

*End of document.*
