-- Run once in Neon (SQL editor) BEFORE switching NEON_STREAM_WRITES to "false".
--
-- Makes every sample unique, so the Grafana export and sender retries can never store
-- the same value twice (inserts use ON CONFLICT DO NOTHING).
--
-- If this fails with "could not create unique index" there are duplicates from earlier
-- retries. Remove them first (keeps the oldest row):
--
--   DELETE FROM sensor_measurements a
--   USING sensor_measurements b
--   WHERE a.id > b.id
--     AND a.device_id = b.device_id
--     AND a.source = b.source
--     AND a.sensor_name = b.sensor_name
--     AND a.metric_name = b.metric_name
--     AND a.captured_at = b.captured_at;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sensor_measurements_sample
  ON sensor_measurements (device_id, source, sensor_name, metric_name, captured_at);
