// Serverless endpoint powering the "Where visitors click first" widget
// on the homepage. Reads real click data already captured by PostHog
// autocapture -- no extra client-side tracking needed.
//
// Required Vercel environment variables:
//   POSTHOG_API_KEY    - a PostHog Personal API Key, read-only query scope
//   POSTHOG_PROJECT_ID - the PostHog project ID (Project Settings > General)
// Optional:
//   POSTHOG_HOST        - defaults to https://us.posthog.com
//   POSTHOG_INGEST_HOST - defaults to https://us.i.posthog.com (error reporting)

const HOST = process.env.POSTHOG_HOST || 'https://us.posthog.com';
const PROJECT_ID = process.env.POSTHOG_PROJECT_ID;
const API_KEY = process.env.POSTHOG_API_KEY;

// First $autocapture click per session on the homepage, grouped by
// element label. Excludes detected bot/crawler traffic.
const QUERY = `
SELECT label, count() as sessions
FROM (
  SELECT
    $session_id as session_id,
    coalesce(
      nullIf(properties.$el_text, ''),
      nullIf(arrayElement(elements_chain_texts, 1), ''),
      nullIf(elements_chain_href, ''),
      'Something without text'
    ) as label,
    row_number() OVER (PARTITION BY $session_id ORDER BY timestamp ASC) as rn
  FROM events
  WHERE event = '$autocapture'
    AND properties.$event_type = 'click'
    AND (properties.$pathname = '/' OR properties.$pathname = '/index.html')
    AND (properties.$virt_is_bot IS NULL OR properties.$virt_is_bot = false)
)
WHERE rn = 1
GROUP BY label
ORDER BY sessions DESC
LIMIT 8
`;

// In-memory cache: keeps this cheap and fast for a low-traffic site.
// Resets whenever the serverless instance recycles, which is fine here.
let cache = { data: null, ts: 0 };
const CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours

// Sends server-side failures to PostHog Error Tracking. Uses the public
// project token (the same one in the page snippet), so no secret is needed.
const INGEST_HOST = process.env.POSTHOG_INGEST_HOST || 'https://us.i.posthog.com';
const PROJECT_TOKEN = 'phc_qNrNa7gfWhdNXAkpo3mnKZe4uG5daH2KD9GBcKYDfSq5';

async function reportError(err, extra) {
  try {
    await fetch(INGEST_HOST + '/i/v0/e/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: PROJECT_TOKEN,
        event: '$exception',
        distinct_id: 'server-api-attention',
        properties: Object.assign({
          $exception_list: [{
            type: err.name || 'Error',
            value: err.message || String(err),
            mechanism: { handled: true, synthetic: false }
          }],
          $exception_stack_trace_raw: err.stack || '',
          $process_person_profile: false,
          source: 'api/attention'
        }, extra || {})
      })
    });
  } catch (e) {
    // Never let error reporting break the endpoint.
  }
}
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
  res.setHeader('Content-Type', 'application/json');

  if (!API_KEY || !PROJECT_ID) {
    res.status(200).end(JSON.stringify({ ready: false, reason: 'not_configured' }));
    return;
  }

  if (cache.data && Date.now() - cache.ts < CACHE_MS) {
    res.status(200).end(JSON.stringify(cache.data));
    return;
  }

  try {
    const r = await fetch(HOST + '/api/projects/' + PROJECT_ID + '/query/', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: QUERY } })
    });

    if (!r.ok) {
      await reportError(new Error('PostHog query failed with status ' + r.status), { status: r.status });
      res.status(200).end(JSON.stringify({ ready: false, reason: 'query_failed' }));
      return;
    }

    const json = await r.json();
    const rows = (json.results || [])
      .map(function (row) { return { label: String(row[0]), sessions: Number(row[1]) }; })
      .filter(function (row) { return row.sessions > 0; });

    const total = rows.reduce(function (sum, row) { return sum + row.sessions; }, 0);

    const payload = {
      ready: true,
      total: total,
      items: rows.slice(0, 5).map(function (row) {
        return {
          label: row.label.length > 34 ? row.label.slice(0, 31) + '\u2026' : row.label,
          sessions: row.sessions,
          pct: total > 0 ? Math.round((row.sessions / total) * 100) : 0
        };
      }),
      updated: new Date().toISOString()
    };

    cache = { data: payload, ts: Date.now() };
    res.status(200).end(JSON.stringify(payload));
  } catch (err) {
    await reportError(err);
    res.status(200).end(JSON.stringify({ ready: false, reason: 'error' }));
  }
};
