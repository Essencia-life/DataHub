import type { SensorSampleRecord } from './db';
import { GRAFANA_MEASUREMENT } from './sinks/grafana';

/**
 * Archive export: reads the recent samples back from Grafana Cloud (Prometheus HTTP API)
 * and turns them into rows for the Neon archive table.
 *
 * Uses an instant query with a range selector (`{...}[30h]`), which returns the raw stored
 * samples with their original timestamps (no step grid, no staleness repeats).
 */

type Env = Record<string, string | undefined>;

export type GrafanaQueryConfig = {
  /** Query endpoint of the Prometheus card, e.g. https://prometheus-prod-xx.grafana.net/api/prom */
  url: string;
  /** Metrics instance ID (Basic auth username). */
  user: string;
  /** Cloud access policy token with metrics:read (Basic auth password). */
  token: string;
};

export function getGrafanaQueryConfig(env: Env = process.env): GrafanaQueryConfig | null {
  const url = env.GRAFANA_QUERY_URL?.trim().replace(/\/+$/, '');
  const user = env.GRAFANA_USER?.trim();
  const token = env.GRAFANA_READ_TOKEN?.trim();

  if (!url || !user || !token) {
    return null;
  }

  return { url, user, token };
}

export type PromSeries = {
  metric: Record<string, string>;
  values: Array<[number, string]>;
};

export const DEFAULT_BUCKETS = 'studer-xcom=300';

/**
 * "source=seconds" list. Sources listed here are exported as averages over fixed
 * time buckets (aligned to the epoch); all other sources are exported raw.
 */
export function parseBuckets(value: string | undefined = DEFAULT_BUCKETS): Map<string, number> {
  const buckets = new Map<string, number>();

  for (const entry of value.split(',')) {
    const [source, seconds] = entry.split('=').map((part) => part.trim());
    const size = Number(seconds);

    if (source && Number.isInteger(size) && size >= 60 && size <= 86400) {
      buckets.set(source, size);
    }
  }

  return buckets;
}

export async function queryRecentSeries(
  config: GrafanaQueryConfig,
  lookbackHours: number,
  nowMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PromSeries[]> {
  const body = new URLSearchParams({
    query: `{__name__=~"${GRAFANA_MEASUREMENT}_.+"}[${Math.ceil(lookbackHours)}h]`,
    time: String(nowMs / 1000),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetchImpl(`${config.url}/api/v1/query`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.user}:${config.token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`Grafana query failed: HTTP ${response.status} ${detail}`.trim());
    }

    const payload = (await response.json()) as {
      status?: string;
      data?: { resultType?: string; result?: PromSeries[] };
    };

    if (payload.status !== 'success' || payload.data?.resultType !== 'matrix' || !payload.data.result) {
      throw new Error('Grafana query returned an unexpected response');
    }

    return payload.data.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Converts Prometheus series into archive rows.
 * - Sources with a bucket size are averaged per bucket; only buckets that are already complete
 *   are exported, so a later run can never produce a different value for the same bucket.
 * - Other sources are exported raw, one row per stored sample.
 */
export function buildExportRows(
  series: PromSeries[],
  nowMs: number,
  buckets: Map<string, number>,
): SensorSampleRecord[] {
  const prefix = `${GRAFANA_MEASUREMENT}_`;
  const rows: SensorSampleRecord[] = [];
  const nowSeconds = nowMs / 1000;

  for (const entry of series) {
    const name = entry.metric.__name__;
    const deviceId = entry.metric.device_id;
    const source = entry.metric.source;

    if (!name || !name.startsWith(prefix) || !deviceId || !source) {
      continue;
    }

    const base = {
      deviceId,
      source,
      sensorName: entry.metric.sensor ?? source,
      metricName: name.slice(prefix.length),
      unit: entry.metric.unit ?? '',
    };

    const samples = entry.values
      .map(([timestamp, value]) => [Number(timestamp), Number(value)] as const)
      .filter(([timestamp, value]) => Number.isFinite(timestamp) && Number.isFinite(value));

    const bucketSize = buckets.get(source);

    if (!bucketSize) {
      for (const [timestamp, value] of samples) {
        rows.push({
          ...base,
          value,
          capturedAt: new Date(Math.round(timestamp * 1000)).toISOString(),
          metadata: { rawSource: source, via: 'grafana-export' },
        });
      }
      continue;
    }

    const cutoff = Math.floor(nowSeconds / bucketSize) * bucketSize;
    const grouped = new Map<number, { sum: number; count: number }>();

    for (const [timestamp, value] of samples) {
      const bucketStart = Math.floor(timestamp / bucketSize) * bucketSize;

      if (bucketStart >= cutoff) {
        continue; // bucket is still being filled
      }

      const current = grouped.get(bucketStart) ?? { sum: 0, count: 0 };
      current.sum += value;
      current.count += 1;
      grouped.set(bucketStart, current);
    }

    for (const [bucketStart, { sum, count }] of grouped) {
      rows.push({
        ...base,
        value: sum / count,
        capturedAt: new Date(bucketStart * 1000).toISOString(),
        metadata: { rawSource: source, via: 'grafana-export', bucketSeconds: bucketSize, samples: count },
      });
    }
  }

  return rows;
}
