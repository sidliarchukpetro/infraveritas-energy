-- Phase 4 migration — TimescaleDB + device_readings_history hypertable
-- Spec: docs/specs/phase4_design.md §6
--
-- Apply: psql -U infraveritas -d infraveritas_energy -f 001_phase4_timescale_init.sql
-- Або mount у /docker-entrypoint-initdb.d/ для auto-run при першому старті контейнера.
--
-- Idempotent — safe to re-run. Усі CREATE/SELECT з if_not_exists / IF NOT EXISTS guards.

BEGIN;

-- ---------- Extension ----------

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------- Main hypertable ----------

CREATE TABLE IF NOT EXISTS device_readings_history (
    -- Submission identification (NOT NULL — основні fields)
    submitted_at        TIMESTAMPTZ NOT NULL,
    device_id           BIGINT NOT NULL,
    session_id          BIGINT NOT NULL,

    -- Spatial coordinates (з payload)
    lat_e7              BIGINT NOT NULL,
    lon_e7              BIGINT NOT NULL,

    -- Claim з payload
    epoch_start_ts      BIGINT NOT NULL,
    total_energy_mwh    BIGINT NOT NULL,

    -- Cross-validation result (nullable — може бути unavailable)
    ensemble_ghi            DOUBLE PRECISION,
    ensemble_status         TEXT,              -- 'ok' | 'degraded' | 'divergent' | 'unavailable'
    ensemble_std_dev        DOUBLE PRECISION,
    ensemble_relative_div   DOUBLE PRECISION,
    providers_responded     SMALLINT,

    -- Per-provider raw data для tracing (JSONB — простіше за окремі колонки)
    -- Shape: [{"provider": "open-meteo", "point": {...}}, {"provider": "...", "error": {...}}]
    provider_details        JSONB,

    -- Statistics
    energy_zscore           DOUBLE PRECISION,
    anomaly_flag            TEXT[],            -- e.g. {'energy_inconsistent_with_weather', 'divergent_weather_sources'}

    -- Chain reference (filled після submitProof)
    session_key             BYTEA,             -- keccak256(device_id || session_id), 32 bytes
    tx_hash                 BYTEA,
    submitted_to_chain      BOOLEAN DEFAULT FALSE
);

-- Convert to hypertable, partitioned by submitted_at з 1-day chunks
SELECT create_hypertable(
    'device_readings_history',
    'submitted_at',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- ---------- Indexes ----------

-- Per-device queries з time ordering (most common access pattern)
CREATE INDEX IF NOT EXISTS idx_drh_device_time
    ON device_readings_history (device_id, submitted_at DESC);

-- Lookup by session_key (links to V3 contract events)
CREATE INDEX IF NOT EXISTS idx_drh_session_key
    ON device_readings_history (session_key)
    WHERE session_key IS NOT NULL;

-- GIN index на anomaly_flag array — щоб "find all submissions з flag X" було швидко
CREATE INDEX IF NOT EXISTS idx_drh_anomaly_flag
    ON device_readings_history USING GIN (anomaly_flag);

-- Status filter index (для "submitted_to_chain=FALSE" recovery queries)
CREATE INDEX IF NOT EXISTS idx_drh_chain_pending
    ON device_readings_history (submitted_at DESC)
    WHERE submitted_to_chain = FALSE;

-- ---------- Retention + compression policies ----------

-- Keep 2 роки повних даних, drop старі автоматично
SELECT add_retention_policy(
    'device_readings_history',
    INTERVAL '2 years',
    if_not_exists => TRUE
);

-- Enable compression на chunks (segmentby device_id — typical pattern для per-entity time series)
ALTER TABLE device_readings_history SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id',
    timescaledb.compress_orderby = 'submitted_at DESC'
);

-- Compress chunks старіших за 7 днів — рідко модифікуються після
SELECT add_compression_policy(
    'device_readings_history',
    INTERVAL '7 days',
    if_not_exists => TRUE
);

-- ---------- Sanity check views (optional, корисні для dashboard роботи у Phase 5) ----------

CREATE OR REPLACE VIEW v_device_recent_24h AS
SELECT
    device_id,
    COUNT(*) AS submissions_24h,
    AVG(total_energy_mwh)::BIGINT AS avg_energy_mwh,
    AVG(ensemble_ghi) AS avg_ghi,
    SUM(CASE WHEN ensemble_status = 'divergent' THEN 1 ELSE 0 END) AS divergent_count,
    SUM(CASE WHEN array_length(anomaly_flag, 1) > 0 THEN 1 ELSE 0 END) AS flagged_count
FROM device_readings_history
WHERE submitted_at >= NOW() - INTERVAL '24 hours'
GROUP BY device_id;

COMMIT;
