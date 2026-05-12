export interface EnergyReading {
  voltage_mv: number;
  current_ma: number;
  timestamp_ms: number;
}

export interface SubmitPayload {
  deviceId: number;
  sessionId: number;
  epochStartTs: number;
  lat: number;
  lon: number;
  lightLevel: number;
  tamperFlag: number;
  minTotalEnergy: number;
  readings: EnergyReading[];
  signature: string;
}

export interface StoredSubmission {
  receivedAt: string;
  payload: SubmitPayload;
}
