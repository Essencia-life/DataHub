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
