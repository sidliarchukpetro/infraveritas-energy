# InfraVeritas Energy Module — Aggregator Backend

> Zero-Knowledge proof pipeline for physical energy asset verification on Ethereum

## What This Is

A backend service that accepts energy readings from IoT edge devices, generates ZK proofs (Noir/UltraHonk), and submits cryptographic attestations on-chain to Sepolia testnet.

**Live contracts on Sepolia:**
- HonkVerifier: `0x07afB15603D836117C274ef0A2fD84C3548DBBe2`
- EnergyProofRegistry: `0xa0e889Bb34fb1AedA24aCA71EDA90cb71b3eFe6d`

## Architecture

IoT Device (Edge Node)
│
│  signed JSON payload (50 readings)
▼
Aggregator Backend (Node.js/Express)
├── verifyDeviceSignature()   — Ethereum-style ECDSA
├── sessionExists()           — replay attack protection
├── generateProof()           — Noir circuit + bb prove
└── submitProofOnChain()      — ethers.js → Sepolia
│
▼
EnergyProofRegistry.sol
│
▼
Permanent on-chain attestation
(Etherscan verifiable)

## ZK Circuit

Circuit: `circuits/energy_v05/` (Noir/UltraHonk)

```rust
fn main(
    readings: [(u64, u64); 50],   // PRIVATE: voltage_mv, current_ma
    device_id: pub u64,            // PUBLIC
    epoch_start_ts: pub u64,       // PUBLIC
    min_total_energy: pub u64      // PUBLIC
)
```

Constraints: `voltage_mv ≤ 10000`, `current_ma ≤ 5000`, `0 < deviceId < 1000000`

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env: PRIVATE_KEY, SEPOLIA_RPC, CONTRACT_ADDRESS, DEVICE_42_ADDRESS

# Start server
npm run dev
```

## API Reference

### POST /submit
Submit energy readings for ZK proof generation and on-chain attestation.

```bash
curl -X POST http://localhost:3000/submit \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": 42,
    "sessionId": 1,
    "epochStartTs": 1777700000,
    "minTotalEnergy": 100,
    "signature": "0x...",
    "readings": [
      {"voltage_mv": 5500, "current_ma": 250, "timestamp_ms": 1777700000000},
      ... (50 total)
    ]
  }'
```

Response:
```json
{
  "status": "proof_generated",
  "submissionId": 1,
  "receivedAt": "2026-05-06T06:45:18.938Z",
  "proofGenerationTimeMs": 502,
  "txHash": "0xf1f535a934e507724a8e422a5402a250b826804666e3c4515707707b5131e7f6",
  "chainStatus": "confirmed"
}
```

**Error responses:**
- `400` — Invalid payload (missing fields, out-of-range values)
- `401` — Invalid device signature
- `409` — Session already processed (replay protection)

### GET /submissions
List all submissions from SQLite.

```bash
curl http://localhost:3000/submissions
```

### GET /submissions/:id
Get full submission detail including proof and public inputs.

```bash
curl http://localhost:3000/submissions/1
```

### GET /submissions/:id/onchain
Get Etherscan link for on-chain transaction.

```bash
curl http://localhost:3000/submissions/1/onchain
```

Response:
```json
{
  "txHash": "0xf1f535a...",
  "chainStatus": "confirmed",
  "etherscanUrl": "https://sepolia.etherscan.io/tx/0xf1f535a..."
}
```

### GET /health
Service status check.

```bash
curl http://localhost:3000/health
```

## Verified Transactions (Sepolia Testnet)

| Block | TxHash | Date |
|-------|--------|------|
| 10799524 | [0x5366...](https://sepolia.etherscan.io/tx/0x5366149e764463f2ccd6de34358ee942f0d3b4616191d2f960975dc9a8f1ddef) | 2026-05-06 |
| 10799678 | [0x08f0...](https://sepolia.etherscan.io/tx/0x08f045ec68fee79039919156b1c5d7ba4dbea8eb3ccb3cf0bc0a25fe54f2db36) | 2026-05-06 |
| 10799718 | [0xf1f5...](https://sepolia.etherscan.io/tx/0xf1f535a934e507724a8e422a5402a250b826804666e3c4515707707b5131e7f6) | 2026-05-06 |

## Security Model

- **Device authentication**: Ethereum ECDSA signature over `infraveritas:{deviceId}:{sessionId}:{epochStartTs}`
- **Replay protection**: SQLite unique constraint on `(device_id, session_id)`
- **ZK privacy**: Raw sensor readings never leave the device — only the cryptographic proof is submitted on-chain
- **On-chain permanence**: Every verified epoch is immutably recorded on Ethereum

## Stack

- **ZK**: Noir (Aztec) + Barretenberg (UltraHonk)
- **Blockchain**: ethers.js v6 + Sepolia testnet
- **Backend**: Node.js + Express + TypeScript
- **Storage**: SQLite (better-sqlite3)
- **Smart contracts**: Solidity 0.8.x (verified on Blockscout + Sourcify)

---

*InfraVeritas Protocol — Physical Asset Verification for RWA Tokenization*  
*USPTO Provisional Patent #63/876,031*
