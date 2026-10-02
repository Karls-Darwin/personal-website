// Serverless endpoint powering the "Where visitors click first" widget
// on the homepage. Reads real click data already captured by PostHog
// autocapture -- no extra client-side tracking needed.
//
// Required Vercel environment variables:
//   POSTHOG_API_KEY    - a PostHog Personal API Key, read-only query scope
//   POSTHOG_PROJECT_ID - the PostHog project ID (Project Settings > General)
// Optional:
//   POSTHOG_HOST        - defaults to https://us.posthog.com

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
    res.status(200).end(JSON.stringify({ ready: false, reason: 'error' }));
  }
};
