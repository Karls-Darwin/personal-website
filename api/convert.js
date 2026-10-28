// Serverless endpoint powering the Recipe Grid tool (/other-tools/recipe-grid/).
// Takes a recipe as a URL, pasted text, or photos and returns structured JSON:
// metadata, mise en place, ingredients, steps, and which ingredients each step uses.
//
// Required Vercel environment variable:
//   ANTHROPIC_API_KEY - Anthropic API key
// Optional:
//   ANTHROPIC_MODEL   - defaults to claude-sonnet-5-5
//   RECIPE_RATE_LIMIT - requests per IP per hour, defaults to 10

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');

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
  additionalProperties: false,
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
        additionalProperties: false,
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
        additionalProperties: false,
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

// ---- Safe page fetching ----
// Only public internet addresses may be fetched. The address is checked when
// the connection is actually made (not just when the URL is read), so DNS
// tricks and redirects to internal addresses are blocked too.

// Errors with a message that is safe to show the visitor.
class UserError extends Error {}

const MAX_REDIRECTS = 5;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;

const BLOCKED = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
].forEach(([a, p]) => BLOCKED.addSubnet(a, p, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
].forEach(([a, p]) => BLOCKED.addSubnet(a, p, 'ipv6'));

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !BLOCKED.check(address, 'ipv4');
  if (family === 6) {
    // IPv4-mapped (::ffff:1.2.3.4) addresses: check the IPv4 part.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return !BLOCKED.check(mapped[1], 'ipv4');
    return !BLOCKED.check(address, 'ipv6');
  }
  return false;
}

// Used as the socket's DNS lookup: every address the name resolves to must be public.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) {
      return callback(new UserError('That URL isn\'t allowed.'));
    }
    if (options && options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function checkUrl(raw, base) {
  let u;
  try { u = new URL(raw, base); } catch (e) { throw new UserError('That URL doesn\'t look right.'); }
  if (!/^https?:$/.test(u.protocol)) throw new UserError('Only http and https links work.');
  if (u.username || u.password) throw new UserError('That URL isn\'t allowed.');
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (port !== '80' && port !== '443') throw new UserError('That URL isn\'t allowed.');
  // Literal IP addresses never go through DNS lookup, so check them here.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !isPublicAddress(host)) throw new UserError('That URL isn\'t allowed.');
  return u;
}

function getOnce(u, deadline) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, {
      lookup: safeLookup,
      headers: {
        'User-Agent': 'Mozilla/5.0 (RecipeGrid; +https://karlkrecke.com/other-tools/recipe-grid/)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      timeout: Math.max(1, deadline - Date.now())
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: res.headers.location });
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return reject(new UserError(`Couldn't open that page (status ${status}). Try pasting the text instead.`));
      }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip())
        : enc === 'deflate' ? res.pipe(zlib.createInflate())
        : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
        : res;
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > MAX_PAGE_BYTES) {
          req.destroy();
          reject(new UserError('That page is too large. Try pasting the recipe text instead.'));
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new UserError('That page took too long to load. Try pasting the text instead.')));
    req.on('error', reject);
  });
}

async function fetchRecipePage(url) {
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let u = checkUrl(url);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    let result;
    try {
      result = await getOnce(u, deadline);
    } catch (err) {
      if (err instanceof UserError) throw err;
      throw new UserError('Couldn\'t open that page. Try pasting the text instead.');
    }
    if (result.body !== undefined) return htmlToText(result.body);
    u = checkUrl(result.redirect, u);
  }
  throw new UserError('That link redirects too many times. Try pasting the text instead.');
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, obj) => res.status(code).end(JSON.stringify(obj));

  if (req.method !== 'POST') return send(405, { error: 'Use POST.' });
  if (!API_KEY) return send(503, { error: 'The tool isn\'t configured yet.' });

  // Vercel sets x-real-ip itself, so visitors can't fake it to dodge the limit.
  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
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
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        // Room for the model's thinking plus a long recipe.
        max_tokens: 16000,
        system: SYSTEM,
        // Reply is JSON that matches SCHEMA (structured outputs). Newer models
        // no longer accept a forced tool call for this.
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        // If the model declines, Anthropic retries on its recommended fallback model.
        fallbacks: 'default',
        messages: [{ role: 'user', content }]
      }),
      signal: AbortSignal.timeout(55000)
    });
    if (!r.ok) {
      console.error('Anthropic error', r.status, await r.text());
      return send(502, { error: 'The recipe model had a problem. Try again in a minute.' });
    }
    const data = await r.json();
    if (data.stop_reason === 'refusal') return send(422, { error: 'Couldn\'t convert that one. Try a different recipe.' });
    if (data.stop_reason === 'max_tokens') return send(422, { error: 'That recipe is too long to convert. Try pasting just the recipe part.' });
    const replyText = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    let recipe;
    try { recipe = JSON.parse(replyText); } catch (e) {
      console.error('Unparseable recipe JSON', data.stop_reason, replyText.slice(0, 200));
      return send(502, { error: 'Couldn\'t read a recipe from that.' });
    }
    return send(200, { recipe });
  } catch (err) {
    if (err instanceof UserError) return send(400, { error: err.message });
    console.error('convert error', err);
    return send(500, { error: 'Something went wrong. Try again in a minute.' });
  }
};

module.exports.config = { maxDuration: 60 };
