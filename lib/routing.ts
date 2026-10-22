import { insertSensorSample } from './db';
import { getGrafanaConfig, GrafanaRejectedError, pushToGrafana } from './sinks/grafana';
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
 * - If Grafana refuses the data itself (HTTP 400, e.g. samples older than its 2 h out-of-order
 *   window after a long outage), retrying cannot help and would block the sender's queue forever.
 *   The samples are then written to Neon instead and the request still succeeds.
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

export type WriteResult = {
  grafana: number;
  neon: number;
  /** Number of samples Grafana refused permanently; they were stored in Neon instead. */
  grafanaRejected: number;
};

/**
 * Writes samples to all targets of the source. Every target is attempted; if any of them
 * fails temporarily the error is thrown afterwards, so the sender gets a 5xx and retries instead
 * of silently losing the data on one side.
 */
export async function writeSamples(source: string, samples: NormalizedSample[]): Promise<WriteResult> {
  const targets = resolveTargets(source);
  const result: WriteResult = { grafana: 0, neon: 0, grafanaRejected: 0 };
  const failures: unknown[] = [];
  let rejectedByGrafana = false;

  const jobs: Array<Promise<void>> = [];

  if (targets.grafana) {
    jobs.push(
      pushToGrafana(samples).then(
        ({ sent }) => {
          result.grafana = sent;
        },
        (error: unknown) => {
          if (error instanceof GrafanaRejectedError) {
            rejectedByGrafana = true;
            console.error(`${error.message} (source ${source}, ${samples.length} samples)`);
            return;
          }

          throw error;
        },
      ),
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

  if (rejectedByGrafana) {
    result.grafanaRejected = samples.length;

    // Not yet written to Neon (stream writes are switched off): keep the data there.
    if (!targets.neon && failures.length === 0) {
      try {
        await Promise.all(samples.map((sample) => insertSensorSample(sample)));
        result.neon = samples.length;
      } catch (error) {
        failures.push(error);
      }
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
