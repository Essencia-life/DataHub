import { timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { insertSensorSamplesBatch } from '../lib/db';
import { buildExportRows, getGrafanaQueryConfig, parseBuckets, queryRecentSeries } from '../lib/export';

/**
 * Daily archive export: Grafana Cloud -> Neon.
 *
 * Triggered by Vercel Cron (see vercel.json). Vercel sends `Authorization: Bearer $CRON_SECRET`
 * when the CRON_SECRET environment variable is set. For manual runs or backfills you can call it
 * with `x-api-key: $API_SHARED_SECRET`, optionally `?hours=72` (max 336) and `?force=1`.
 */

const DEFAULT_LOOKBACK_HOURS = 30;
const MAX_LOOKBACK_HOURS = 336; // Grafana Cloud free keeps 14 days of metrics

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isAuthorized(req: VercelRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const authorization = firstValue(req.headers.authorization);

  if (cronSecret && authorization && safeEqual(authorization, `Bearer ${cronSecret}`)) {
    return true;
  }

  const sharedSecret = process.env.API_SHARED_SECRET;
  const apiKey = firstValue(req.headers['x-api-key']);

  return Boolean(sharedSecret && apiKey && safeEqual(apiKey, sharedSecret));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ ok: false, message: 'Method not allowed' });
    }

    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    // While stream sources are still written to Neon directly, exporting would store the
    // same data a second time (5-minute averages next to the raw rows).
    if (process.env.NEON_STREAM_WRITES !== 'false' && firstValue(req.query.force) !== '1') {
      return res.status(200).json({
        ok: true,
        skipped: 'NEON_STREAM_WRITES is not "false"; stream sources are still written to Neon directly.',
      });
    }

    const config = getGrafanaQueryConfig();

    if (!config) {
      return res.status(500).json({
        ok: false,
        message: 'Grafana query settings missing (GRAFANA_QUERY_URL, GRAFANA_USER, GRAFANA_READ_TOKEN)',
      });
    }

    const requestedHours = Number(firstValue(req.query.hours) ?? process.env.EXPORT_LOOKBACK_HOURS ?? DEFAULT_LOOKBACK_HOURS);
    const lookbackHours = Number.isFinite(requestedHours)
      ? Math.min(Math.max(Math.ceil(requestedHours), 1), MAX_LOOKBACK_HOURS)
      : DEFAULT_LOOKBACK_HOURS;

    const now = Date.now();
    const series = await queryRecentSeries(config, lookbackHours, now);
    const rows = buildExportRows(series, now, parseBuckets(process.env.EXPORT_BUCKETS));
    const inserted = await insertSensorSamplesBatch(rows);

    return res.status(200).json({
      ok: true,
      lookbackHours,
      series: series.length,
      samples: rows.length,
      inserted,
    });
  } catch (error) {
    console.error('Export failed', error);

    return res.status(500).json({ ok: false, message: 'Export failed' });
  }
}
