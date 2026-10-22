import { Pool, PoolClient } from 'pg';

let pool: Pool | undefined;

export function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      max: 5,
      ssl:
        process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false,
    });
  }

  return pool;
}

export type SensorSampleRecord = {
  deviceId: string;
  source: string;
  sensorName: string;
  metricName: string;
  value: number;
  unit: string;
  capturedAt: string;
  metadata?: Record<string, unknown>;
};

export async function insertSensorSample(record: SensorSampleRecord): Promise<{ ok: true }> {
  const client: PoolClient = await getPool().connect();

  try {
    await client.query(
      `
        INSERT INTO sensor_measurements (
          device_id,
          source,
          sensor_name,
          metric_name,
          value,
          unit,
          captured_at,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT DO NOTHING
      `,
      [
        record.deviceId,
        record.source,
        record.sensorName,
        record.metricName,
        Number(record.value),
        record.unit,
        new Date(record.capturedAt),
        record.metadata ?? {},
      ],
    );

    return { ok: true };
  } finally {
    client.release();
  }
}

const BATCH_SIZE = 500;

/**
 * Inserts many samples with a few multi-row statements (one connection, no per-row round trip).
 * Rows that already exist (see scripts/001-unique-sample-index.sql) are skipped, so the same
 * time window can be exported repeatedly. Returns the number of rows actually inserted.
 */
export async function insertSensorSamplesBatch(records: SensorSampleRecord[]): Promise<number> {
  if (records.length === 0) {
    return 0;
  }

  const client: PoolClient = await getPool().connect();

  try {
    let inserted = 0;

    for (let start = 0; start < records.length; start += BATCH_SIZE) {
      const chunk = records.slice(start, start + BATCH_SIZE);

      const result = await client.query(
        `
          INSERT INTO sensor_measurements (
            device_id, source, sensor_name, metric_name, value, unit, captured_at, metadata
          )
          SELECT t.device_id, t.source, t.sensor_name, t.metric_name, t.value, t.unit,
                 t.captured_at, t.metadata::jsonb
          FROM unnest(
            $1::text[], $2::text[], $3::text[], $4::text[],
            $5::float8[], $6::text[], $7::timestamptz[], $8::text[]
          ) AS t(device_id, source, sensor_name, metric_name, value, unit, captured_at, metadata)
          ON CONFLICT DO NOTHING
        `,
        [
          chunk.map((record) => record.deviceId),
          chunk.map((record) => record.source),
          chunk.map((record) => record.sensorName),
          chunk.map((record) => record.metricName),
          chunk.map((record) => Number(record.value)),
          chunk.map((record) => record.unit),
          chunk.map((record) => new Date(record.capturedAt).toISOString()),
          chunk.map((record) => JSON.stringify(record.metadata ?? {})),
        ],
      );

      inserted += result.rowCount ?? 0;
    }

    return inserted;
  } finally {
    client.release();
  }
}
