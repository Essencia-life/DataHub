import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../lib/db';

const FALLBACK_LEVEL = 0;

function renderHtml(level: number | null, timestamp: Date): string {
  const displayLevel = typeof level === 'number' && Number.isFinite(level) ? `${level.toFixed(1)}%` : 'unavailable';
  const readableTimestamp = timestamp.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Europe/Lisbon',
  });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Refresh" content="60" />
    <title>Water Tank Status</title>
  </head>
  <body>
    <h1>Water tank level: ${displayLevel}</h1>
    <b>Last update:</b>
    <time>${readableTimestamp}</time>
  </body>
</html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const pool = getPool();
    const result = await pool.query<{ value: number, captured_at: Date }>(`
      SELECT value, captured_at
      FROM sensor_measurements
      WHERE sensor_name = 'water_tank'
        AND metric_name = 'water_level_pct'
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `);

    const currentLevel = result.rows[0]?.value ?? FALLBACK_LEVEL;
    const timestamp = result.rows[0]?.captured_at ?? new Date();

    return res
      .status(200)
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      .send(renderHtml(currentLevel, timestamp));
  } catch (error) {
    console.error('Failed to fetch water tank level', error);

    return res
      .status(200)
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      .send(renderHtml(FALLBACK_LEVEL, new Date()));
  }
}
