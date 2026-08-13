CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS sensor_measurements (
  id BIGSERIAL PRIMARY KEY,
  device_id TEXT NOT NULL,
  source TEXT NOT NULL,
  sensor_name TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

SELECT create_hypertable('sensor_measurements', 'captured_at', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_sensor_measurements_device_time
  ON sensor_measurements (device_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_sensor_measurements_source_metric_time
  ON sensor_measurements (source, metric_name, captured_at DESC);
