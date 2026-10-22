import { insertSensorSample } from './db';
import { getGrafanaConfig, pushToGrafana } from './sinks/grafana';
import type { NormalizedSample } from './validation';

/**
 * Where does a source go?
 *
 * - "Stream" sources (continuous sensor data) go to Grafana Cloud once it is configured.
 *   Alerting and dashboards live there.
 * - Everything else (e.g. `manual` entries) is rare event data and is written straight to Neon.
 * - Without Grafana credentials everything is written to Neon, exactly like before.
 * - NEON_STREAM_WRITES=false switches the direct Neon writes for stream sources off
 *   (do this once the daily export from Grafana to Neon is running). Default: keep writing.
 */

type Env = Record<string, string | undefined>;

export const DEFAULT_STREAM_SOURCES = ['lora-tank', 'studer-xcom', 'generic'];

export type Targets = { grafana: boolean; neon: boolean };

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) {
    return fallback;
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function resolveTargets(source: string, env: Env = process.env): Targets {
  const isStream = parseList(env.GRAFANA_SOURCES, DEFAULT_STREAM_SOURCES).includes(source);

  if (!isStream || getGrafanaConfig(env) === null) {
    return { grafana: false, neon: true };
  }

  return { grafana: true, neon: env.NEON_STREAM_WRITES !== 'false' };
}

export type WriteResult = { grafana: number; neon: number };

/**
 * Writes samples to all targets of the source. Every target is attempted; if any of them
 * fails the error is thrown afterwards, so the sender gets a 5xx and retries instead of
 * silently losing the data on one side.
 */
export async function writeSamples(source: string, samples: NormalizedSample[]): Promise<WriteResult> {
  const targets = resolveTargets(source);
  const result: WriteResult = { grafana: 0, neon: 0 };
  const failures: unknown[] = [];

  const jobs: Array<Promise<void>> = [];

  if (targets.grafana) {
    jobs.push(
      pushToGrafana(samples).then(({ sent }) => {
        result.grafana = sent;
      }),
    );
  }

  if (targets.neon) {
    jobs.push(
      Promise.all(samples.map((sample) => insertSensorSample(sample))).then(() => {
        result.neon = samples.length;
      }),
    );
  }

  const settled = await Promise.allSettled(jobs);

  for (const entry of settled) {
    if (entry.status === 'rejected') {
      failures.push(entry.reason);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error('Sample write failed', failure);
    }
    throw failures[0] instanceof Error ? failures[0] : new Error('Sample write failed');
  }

  return result;
}
