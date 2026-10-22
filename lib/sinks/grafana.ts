import type { NormalizedSample } from '../validation';

/**
 * Grafana Cloud sink: pushes samples as Influx line protocol.
 *
 * Every sample becomes one point:
 *   datahub,device_id=<id>,sensor=<name>,source=<source>,unit=<unit> <metric>=<value> <timestamp_ns>
 *
 * Grafana Cloud stores each field as its own series named `<measurement>_<field>`,
 * so e.g. metric `water_level_pct` ends up as `datahub_water_level_pct{device_id=..., ...}`.
 */

export const GRAFANA_MEASUREMENT = 'datahub';
export const GRAFANA_PUSH_TIMEOUT_MS = 8000;

/**
 * Grafana refused the data itself (HTTP 400), e.g. a sample older than its out-of-order window
 * ("out of bounds"). Sending the same data again can never succeed, in contrast to timeouts,
 * rate limits (429), server errors (5xx) or a wrong token (401/403).
 */
export class GrafanaRejectedError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Grafana rejected the data: HTTP ${status} ${detail}`.trim());
    this.name = 'GrafanaRejectedError';
    this.status = status;
  }
}

export type GrafanaConfig = {
  /** Full push URL, e.g. https://<metrics-endpoint>/api/v1/push/influx/write */
  url: string;
  /** Metrics instance ID (Basic auth username). */
  user: string;
  /** Cloud access policy token with metrics:write (Basic auth password). */
  token: string;
};

type Env = Record<string, string | undefined>;

export function getGrafanaConfig(env: Env = process.env): GrafanaConfig | null {
  const url = env.GRAFANA_INFLUX_URL?.trim();
  const user = env.GRAFANA_USER?.trim();
  const token = env.GRAFANA_WRITE_TOKEN?.trim();

  if (!url || !user || !token) {
    return null;
  }

  return { url, user, token };
}

function escapeMeasurement(value: string): string {
  return value.replace(/[\\\r\n]/g, '').replace(/([, ])/g, '\\$1');
}

function escapeTag(value: string): string {
  return value.replace(/[\\\r\n]/g, '').replace(/([,= ])/g, '\\$1');
}

/** Field keys become part of a Prometheus metric name, so keep them to [a-zA-Z0-9_]. */
export function sanitizeFieldKey(metric: string): string {
  const cleaned = metric.trim().replace(/[^a-zA-Z0-9_]/g, '_');
  return cleaned.length > 0 ? cleaned : 'value';
}

export function toLineProtocol(samples: NormalizedSample[]): string[] {
  const lines: string[] = [];

  for (const sample of samples) {
    const value = Number(sample.value);
    const timestampMs = Date.parse(sample.capturedAt);

    // Line protocol has no NaN/Infinity, and a point without a valid time is useless.
    if (!Number.isFinite(value) || !Number.isFinite(timestampMs)) {
      continue;
    }

    const tags: Array<[string, string]> = [
      ['device_id', sample.deviceId],
      ['sensor', sample.sensorName],
      ['source', sample.source],
      ['unit', sample.unit],
    ];

    const tagString = tags
      .map(([key, tagValue]) => [key, escapeTag(String(tagValue ?? ''))] as const)
      .filter(([, tagValue]) => tagValue.length > 0) // empty tag values are invalid
      .map(([key, tagValue]) => `${key}=${tagValue}`)
      .join(',');

    const head = tagString
      ? `${escapeMeasurement(GRAFANA_MEASUREMENT)},${tagString}`
      : escapeMeasurement(GRAFANA_MEASUREMENT);

    // Timestamps are nanoseconds; Date.parse gives whole milliseconds.
    lines.push(`${head} ${sanitizeFieldKey(sample.metricName)}=${value} ${timestampMs}000000`);
  }

  return lines;
}

export async function pushToGrafana(
  samples: NormalizedSample[],
  config: GrafanaConfig | null = getGrafanaConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: number }> {
  if (!config) {
    throw new Error('Grafana is not configured (GRAFANA_INFLUX_URL / GRAFANA_USER / GRAFANA_WRITE_TOKEN)');
  }

  const lines = toLineProtocol(samples);

  if (lines.length === 0) {
    return { sent: 0 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAFANA_PUSH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.user}:${config.token}`).toString('base64')}`,
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: lines.join('\n'),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);

      if (response.status === 400) {
        throw new GrafanaRejectedError(response.status, detail);
      }

      throw new Error(`Grafana push failed: HTTP ${response.status} ${detail}`.trim());
    }

    return { sent: lines.length };
  } finally {
    clearTimeout(timer);
  }
}
