# DataHub

Small Vercel service that receives sensor and manual data for Essência and forwards it to
Grafana Cloud (live data, dashboards, alerting) and Neon (long-term archive).

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /api/ingest/<source>` | Receive data. Header `x-api-key: <API_SHARED_SECRET>`. Sources: `lora-tank`, `studer-xcom`, `generic`, `manual`. See `examples/`. |
| `GET /api/export` | Daily archive export Grafana -> Neon (Vercel Cron, see below). |
| `GET /api/health` | Health check. |

A sender gets a 2xx only after all targets accepted the data. On a 5xx it should retry
(the water tank receiver and the Studer sensor keep unsent readings in a queue).

`unit` of a metric is optional (status and counter values such as an operating state have none); it is
stored as an empty string and the Grafana label `unit` is left out.

## Where data goes

- **Stream sources** (`lora-tank`, `studer-xcom`, `generic`) are pushed to Grafana Cloud as Influx line protocol
  once the `GRAFANA_*` variables are set. Each metric becomes the series `datahub_<metric>` with the labels
  `device_id`, `sensor`, `source` and `unit`, e.g. `datahub_water_level_pct{device_id="essencia-water-tank-01"}`.
- **Manual entries** (`manual`: firewood, fuel, waste, ...) are rare events and are written directly to Neon.
- Without `GRAFANA_*` variables everything is written to Neon, as before.
- While `NEON_STREAM_WRITES` is not `false`, stream sources are also written to Neon (migration phase).

**Data Grafana refuses:** Grafana Cloud only accepts samples up to 2 hours behind the newest sample of a
series. After a longer outage a sender delivers its backlog with the original timestamps, and Grafana may
answer HTTP 400. Retrying cannot fix that and would block the sender's queue (the water tank receiver
retries the oldest reading forever), so the Datahub answers with 2xx, stores those samples in Neon instead
and reports `grafanaRejected` in the response. Look for `Grafana rejected the data` in the Vercel logs.
Temporary problems (timeout, 429, 5xx) and a wrong token (401/403) still return 5xx, so the sender retries.

Adding a new sensor needs no Grafana-side code: send it to `generic` (or add a normalizer in
`lib/validation.ts`) and the metrics show up in Grafana automatically.

## Setup of Grafana Cloud (free plan)

1. Grafana Cloud portal, your stack, card **InfluxDB** (Configure): note the push URL (ends with
   `/api/v1/push/influx/write`) and the user ID, then generate a write token.
2. Vercel, project, Settings, Environment Variables (Production): set `GRAFANA_INFLUX_URL`, `GRAFANA_USER`,
   `GRAFANA_WRITE_TOKEN`, then redeploy.
3. Send a test payload (see `examples/`) and look for `datahub_...` metrics in Grafana, Explore.
4. Alerting: in Grafana create alert rules on the `datahub_*` series (low level, fast drop, no data) and a
   Telegram contact point.

## Archive: daily export Grafana -> Neon

`GET /api/export` runs once a day via Vercel Cron (`vercel.json`, Hobby plan: once per day, the exact
time can vary by up to an hour). It reads the last 30 hours of `datahub_*` series back from Grafana
Cloud and stores them in `sensor_measurements`: the water tank raw, `studer-xcom` as 5-minute values
(`EXPORT_BUCKETS`): the average, except for metrics without a unit (states, counters) and cumulative ones
like `*_today_*`, which keep the last value of the bucket (`EXPORT_LAST_VALUE_PATTERN`). Only complete buckets are exported and existing rows are skipped, so runs can overlap
and a missed day is caught up by the next one. Neon therefore wakes up about once a day.

Switch-over, in this order:

1. Run `scripts/001-unique-sample-index.sql` once in Neon.
2. Set in Vercel: `GRAFANA_QUERY_URL`, `GRAFANA_READ_TOKEN` (access policy token with `metrics:read`),
   `CRON_SECRET` (any long random string), then redeploy.
3. Set `NEON_STREAM_WRITES=false`. Until then the export skips itself, because the data would be stored twice.

Manual run or backfill (Grafana keeps 14 days):
`curl -H "x-api-key: $API_SHARED_SECRET" "https://<your-app>/api/export?hours=72"`

## Local development

```
cp .env.example .env
npm install
npm run dev
```

## Database

`scripts/init-db.sql` creates the `sensor_measurements` table (TimescaleDB hypertable).
