import { z } from 'zod';

export const inboundMetricSchema = z.object({
  metric: z.string().min(1),
  value: z.number(),
  unit: z.string().min(1),
});

export const genericPayloadSchema = z.object({
  deviceId: z.string().min(1),
  timestamp: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'timestamp must be a valid ISO date string',
  }),
  values: z.array(inboundMetricSchema).min(1),
});

export type NormalizedSample = {
  deviceId: string;
  source: string;
  sensorName: string;
  metricName: string;
  value: number;
  unit: string;
  capturedAt: string;
  metadata: Record<string, string>;
};

export function normalizeGenericPayload(rawBody: unknown): NormalizedSample[] {
  const parsed = genericPayloadSchema.parse(rawBody);

  return parsed.values.map((entry) => ({
    deviceId: parsed.deviceId,
    source: 'generic',
    sensorName: 'generic',
    metricName: entry.metric,
    value: Number(entry.value),
    unit: entry.unit,
    capturedAt: new Date(parsed.timestamp).toISOString(),
    metadata: { rawSource: 'generic' },
  }));
}

export function normalizeLoraTankPayload(rawBody: unknown): NormalizedSample[] {
  const parsed = z
    .object({
      deviceId: z.string().min(1),
      timestamp: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
        message: 'timestamp must be a valid ISO date string',
      }),
      state: z.number().int().optional(),
      waterLevelPercent: z.number().optional(),
      waterlevel: z.number().optional(),
      levelCm: z.number().optional(),
      signalDbm: z.number().optional(),
    })
    .parse(rawBody);

  const entries: NormalizedSample[] = [];

  const waterLevelValue = parsed.waterLevelPercent ?? parsed.waterlevel;

  if (waterLevelValue !== undefined) {
    entries.push({
      deviceId: parsed.deviceId,
      source: 'lora-tank',
      sensorName: 'water_tank',
      metricName: 'water_level_pct',
      value: Number(waterLevelValue),
      unit: '%',
      capturedAt: new Date(parsed.timestamp).toISOString(),
      metadata: {
        rawSource: 'lora-tank',
        sensorState: parsed.state !== undefined ? String(parsed.state) : 'unknown',
      },
    });
  }

  if (parsed.levelCm !== undefined) {
    entries.push({
      deviceId: parsed.deviceId,
      source: 'lora-tank',
      sensorName: 'water_tank',
      metricName: 'level_cm',
      value: Number(parsed.levelCm),
      unit: 'cm',
      capturedAt: new Date(parsed.timestamp).toISOString(),
      metadata: {
        rawSource: 'lora-tank',
        sensorState: parsed.state !== undefined ? String(parsed.state) : 'unknown',
      },
    });
  }

  if (parsed.signalDbm !== undefined) {
    entries.push({
      deviceId: parsed.deviceId,
      source: 'lora-tank',
      sensorName: 'water_tank',
      metricName: 'signal_dbm',
      value: Number(parsed.signalDbm),
      unit: 'dBm',
      capturedAt: new Date(parsed.timestamp).toISOString(),
      metadata: {
        rawSource: 'lora-tank',
        sensorState: parsed.state !== undefined ? String(parsed.state) : 'unknown',
      },
    });
  }

  if (entries.length === 0) {
    throw new Error('No recognized LoRa tank metrics found');
  }

  return entries;
}

export function normalizeStuderXcomPayload(rawBody: unknown): NormalizedSample[] {
  const parsed = z
    .object({
      deviceId: z.string().min(1),
      timestamp: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
        message: 'timestamp must be a valid ISO date string',
      }),
      values: z.array(
        z.object({
          metric: z.string().min(1),
          value: z.number(),
          unit: z.string().min(1),
        }),
      ),
    })
    .parse(rawBody);

  return parsed.values.map((entry) => ({
    deviceId: parsed.deviceId,
    source: 'studer-xcom',
    sensorName: 'studer_xcom',
    metricName: entry.metric,
    value: Number(entry.value),
    unit: entry.unit,
    capturedAt: new Date(parsed.timestamp).toISOString(),
    metadata: { rawSource: 'studer-xcom' },
  }));
}

export function normalizeManualMeasurementPayload(rawBody: unknown): NormalizedSample[] {
  const parsed = z
    .object({
      deviceId: z.string().min(1),
      timestamp: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
        message: 'timestamp must be a valid ISO date string',
      }),
      category: z
        .enum(['fuel', 'wood', 'waste', 'maintenance', 'other'])
        .default('other'),
      value: z.number(),
      unit: z.string().min(1),
      metric: z.string().min(1),
      note: z.string().optional(),
    })
    .parse(rawBody);

  return [
    {
      deviceId: parsed.deviceId,
      source: 'manual',
      sensorName: parsed.category,
      metricName: parsed.metric,
      value: Number(parsed.value),
      unit: parsed.unit,
      capturedAt: new Date(parsed.timestamp).toISOString(),
      metadata: {
        rawSource: 'manual',
        note: parsed.note ?? '',
        category: parsed.category,
      },
    },
  ];
}
