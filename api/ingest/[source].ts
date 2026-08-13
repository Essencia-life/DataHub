import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { insertSensorSample } from '../../lib/db';
import {
  normalizeGenericPayload,
  normalizeLoraTankPayload,
  normalizeManualMeasurementPayload,
  normalizeStuderXcomPayload,
} from '../../lib/validation';

const API_KEY = process.env.API_SHARED_SECRET ?? 'dev-secret';

function ensureAuthorized(req: VercelRequest): void {
  const providedKey = req.headers['x-api-key'];
  const headerValue = Array.isArray(providedKey) ? providedKey[0] : providedKey;

  if (headerValue !== API_KEY) {
    throw new Error('Unauthorized');
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    ensureAuthorized(req);

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, message: 'Method not allowed' });
    }

    const source = Array.isArray(req.query.source) ? req.query.source[0] : req.query.source;

    if (!source) {
      return res.status(400).json({ ok: false, message: 'Missing source parameter' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    let normalizedRows;

    switch (source) {
      case 'generic':
        normalizedRows = normalizeGenericPayload(body);
        break;
      case 'lora-tank':
        normalizedRows = normalizeLoraTankPayload(body);
        break;
      case 'studer-xcom':
        normalizedRows = normalizeStuderXcomPayload(body);
        break;
      case 'manual':
        normalizedRows = normalizeManualMeasurementPayload(body);
        break;
      default:
        return res.status(400).json({ ok: false, message: `Unsupported source: ${source}` });
    }

    const inserts = await Promise.all(
      normalizedRows.map(async (row) => insertSensorSample(row)),
    );

    return res.status(200).json({
      ok: true,
      source,
      inserted: inserts.length,
      message: 'Data ingested successfully',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        ok: false,
        message: 'Validation failed',
        issues: error.issues,
      });
    }

    if ((error as Error).message === 'Unauthorized') {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    console.error(error);

    return res.status(500).json({
      ok: false,
      message: 'Internal server error',
    });
  }
}
