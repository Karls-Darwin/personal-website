// Serverless endpoint powering the Recipe Grid tool (/other-tools/recipe-grid/).
// Takes a recipe as a URL, pasted text, or photos and returns structured JSON:
// metadata, mise en place, ingredients, steps, and which ingredients each step uses.
//
// Required Vercel environment variable:
//   ANTHROPIC_API_KEY - Anthropic API key
// Optional:
//   ANTHROPIC_MODEL   - defaults to claude-sonnet-5-5
//   RECIPE_RATE_LIMIT - requests per IP per hour, defaults to 10

const { reportError } = require('./_posthog');

// Errors caused by the visitor's input (bad link, blocked page). These are
// shown to the visitor but not sent to Error Tracking.
function userError(msg) { const e = new Error(msg); e.expected = true; return e; }

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const LIMIT = parseInt(process.env.RECIPE_RATE_LIMIT || '10', 10);
const WINDOW_MS = 60 * 60 * 1000;
const MAX_TEXT = 40000;
const MAX_IMAGES = 4;

// Best-effort per-IP limit. Lives in function memory, so it resets on cold
// starts and isn't shared across instances. Good enough for a portfolio page.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    servings: { type: 'string' },
    prep_time: { type: 'string' },
    cook_time: { type: 'string' },
    total_time: { type: 'string' },
    mise_en_place: { type: 'array', items: { type: 'string' }, description: 'Prep tasks to do before cooking starts, e.g. "Dice 1 onion"' },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short id like i1, i2' },
          name: { type: 'string' },
          quantity: { type: 'string' },
          unit: { type: 'string' },
          prep: { type: 'string', description: 'e.g. diced, room temperature' },
          group: { type: 'string', description: 'Optional section like Sauce or Dough' }
        },
        required: ['id', 'name']
      }
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short id like s1, s2' },
          action: { type: 'string', description: 'Short verb label for the grid column, e.g. Saute, Whisk, Bake' },
          text: { type: 'string' },
          ingredient_ids: { type: 'array', items: { type: 'string' } }
        },
        required: ['id', 'action', 'text', 'ingredient_ids']
      }
    },
    notes: { type: 'array', items: { type: 'string' } }
  },
  required: ['title', 'ingredients', 'steps', 'mise_en_place']
};

const SYSTEM = `You convert recipes into clean, structured data.
Rules:
- Always answer by calling the save_recipe tool exactly once. Do not reply with plain text.
- Only use what is in the source. Do not invent ingredients, quantities, or times. Leave unknown fields empty.
- Strip blog stories, ads, and comments.
- Every ingredient gets an id. Every step lists the ids of the ingredients it uses.
- Keep step text close to the original, but tidy it.
- "action" is a 1-2 word verb label for the step.
- If the input is not a recipe, return title "Not a recipe" with empty lists.`;

function htmlToText(html) {
  // Prefer schema.org Recipe JSON-LD if the page has it; it's cleaner than the page text.
  const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]).filter((s) => /Recipe/.test(s));
  if (ld.length) return ld.join('\n').slice(0, MAX_TEXT);
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

async function fetchRecipePage(url) {
  let u;
  try { u = new URL(url); } catch (e) { throw userError('That URL doesn\'t look right.'); }
  if (!/^https?:$/.test(u.protocol)) throw userError('Only http and https links work.');
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname)) throw userError('That URL isn\'t allowed.');
  const r = await fetch(u.toString(), {
    headers: { 'User-Agent': 'Mozilla/5.0 (RecipeGrid; +https://karlkrecke.com/other-tools/recipe-grid/)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw userError(`Couldn't open that page (status ${r.status}). Try pasting the text instead.`);
  return htmlToText(await r.text());
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, obj) => res.status(code).end(JSON.stringify(obj));

  if (req.method !== 'POST') return send(405, { error: 'Use POST.' });
  if (!API_KEY) {
    await reportError(new Error('ANTHROPIC_API_KEY is not set'), 'api/convert');
    return send(503, { error: 'The tool isn\'t configured yet.' });
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return send(429, { error: `Limit is ${LIMIT} conversions per hour. Try again later.` });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { mode, url, text, images } = body || {};

  try {
    const content = [];
    if (mode === 'url') {
      if (!url) return send(400, { error: 'Add a recipe link.' });
      const pageText = await fetchRecipePage(url);
      content.push({ type: 'text', text: `Recipe page (${url}):\n\n${pageText}` });
    } else if (mode === 'text') {
      if (!text || !text.trim()) return send(400, { error: 'Paste a recipe first.' });
      content.push({ type: 'text', text: `Recipe text:\n\n${String(text).slice(0, MAX_TEXT)}` });
    } else if (mode === 'image') {
      const imgs = Array.isArray(images) ? images.slice(0, MAX_IMAGES) : [];
      if (!imgs.length) return send(400, { error: 'Add at least one photo.' });
      for (const img of imgs) {
        const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(img || '');
        if (!m) return send(400, { error: 'Photos must be JPG, PNG, WebP, or GIF.' });
        content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      }
      content.push({ type: 'text', text: 'These photos show a recipe (ingredients and/or steps). Convert it.' });
    } else {
      return send(400, { error: 'Unknown input type.' });
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM,
        tools: [{ name: 'save_recipe', description: 'Save the structured recipe.', input_schema: SCHEMA }],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content }]
      }),
      signal: AbortSignal.timeout(55000)
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error('Anthropic error', r.status, detail);
      await reportError(new Error('Anthropic API error ' + r.status + ': ' + detail.slice(0, 300)), 'api/convert', { status: r.status, model: MODEL });
      return send(502, { error: 'The recipe model had a problem. Try again in a minute.' });
    }
    const data = await r.json();
    const block = (data.content || []).find((b) => b.type === 'tool_use');
    if (!block) {
      await reportError(new Error('Anthropic response had no tool_use block'), 'api/convert', { model: MODEL });
      return send(502, { error: 'Couldn\'t read a recipe from that.' });
    }
    return send(200, { recipe: block.input });
  } catch (err) {
    if (!err.expected) await reportError(err, 'api/convert');
    return send(400, { error: err.message || 'Something went wrong.' });
  }
};

module.exports.config = { maxDuration: 60 };
