// Shared helper: sends server-side errors from the api/ functions to
// PostHog Error Tracking. Files starting with "_" are not exposed as routes.
// Uses the public project token (same one as the page snippet), so no secret.

const INGEST_HOST = process.env.POSTHOG_INGEST_HOST || 'https://us.i.posthog.com';
const PROJECT_TOKEN = 'phc_qNrNa7gfWhdNXAkpo3mnKZe4uG5daH2KD9GBcKYDfSq5';

async function reportError(err, source, extra) {
  try {
    await fetch(INGEST_HOST + '/i/v0/e/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: PROJECT_TOKEN,
        event: '$exception',
        distinct_id: 'server-' + source,
        properties: Object.assign({
          $exception_list: [{
            type: err.name || 'Error',
            value: err.message || String(err),
            mechanism: { handled: true, synthetic: false }
          }],
          $exception_stack_trace_raw: err.stack || '',
          $process_person_profile: false,
          source: source
        }, extra || {})
      }),
      signal: AbortSignal.timeout(3000)
    });
  } catch (e) {
    // Never let error reporting break the endpoint.
  }
}

module.exports = { reportError };
