export const REGISTRY_ABI = [
  {
    "inputs": [
      {"internalType": "uint256", "name": "deviceId", "type": "uint256"},
      {"internalType": "uint256", "name": "epochStartTs", "type": "uint256"},
      {"internalType": "int256", "name": "coarseLat", "type": "int256"},
      {"internalType": "int256", "name": "coarseLon", "type": "int256"},
      {"internalType": "uint256", "name": "totalEnergyMwh", "type": "uint256"},
      {"internalType": "bytes", "name": "proof", "type": "bytes"},
      {"internalType": "bytes32[]", "name": "publicInputs", "type": "bytes32[]"}
    ],
    "name": "submitProof",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {"internalType": "uint256", "name": "deviceId", "type": "uint256"}
    ],
    "name": "isOnline",
    "outputs": [{"internalType": "bool", "name": "", "type": "bool"}],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {"internalType": "uint256", "name": "deviceId", "type": "uint256"}
    ],
    "name": "deviceProofCount",
    "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      {"indexed": true, "internalType": "uint256", "name": "deviceId", "type": "uint256"},
      {"indexed": false, "internalType": "uint256", "name": "epochStartTs", "type": "uint256"},
      {"indexed": false, "internalType": "int256", "name": "coarseLat", "type": "int256"},
      {"indexed": false, "internalType": "int256", "name": "coarseLon", "type": "int256"},
      {"indexed": false, "internalType": "uint256", "name": "totalEnergyMwh", "type": "uint256"},
      {"indexed": false, "internalType": "address", "name": "submitter", "type": "address"}
    ],
    "name": "ProofVerified",
    "type": "event"
  }
];
