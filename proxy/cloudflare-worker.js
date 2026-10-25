/**
 * TorBox CORS proxy — Cloudflare Worker.
 *
 * Locked down to the hosts the TorBox Lampa plugin actually needs:
 *  - api.torbox.app — TorBox API (Authorization is attached server-side)
 *  - public parser gateways — search only, no credentials forwarded
 *
 * The client sends the TorBox API key in the `X-Api-Key` header; the worker
 * converts it to `Authorization: Bearer <key>` ONLY for api.torbox.app, so the
 * key can never leak to a parser or any other host.
 *
 * Deploy: npx wrangler deploy (from this directory).
 */

const TORBOX_HOST = 'api.torbox.app';

// Add your custom parser domains here if you use any (plugin setting
// `torbox_custom_parsers`) — requests to hosts outside this list are rejected.
const ALLOWED_HOSTS = new Set([
  TORBOX_HOST,
  'jr.maxvol.pro',
  'jacred.xyz',
]);

const ALLOWED_METHODS = new Set(['GET', 'POST', 'HEAD']);

// Only these request headers are forwarded to the target — cookies and
// anything else the client attaches stay on the worker boundary.
const FORWARDED_HEADERS = ['accept', 'content-type', 'range'];

function corsHeaders(request) {
  const requested = request.headers.get('Access-Control-Request-Headers');
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': requested || 'Authorization, Content-Type, X-Api-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// Every response — including errors — must carry CORS headers, otherwise the
// browser hides the status/body from the plugin and it reports a generic
// network error instead of the real cause.
function corsError(request, message, status) {
  return new Response(message, { status, headers: corsHeaders(request) });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (!ALLOWED_METHODS.has(request.method)) {
      return corsError(request, 'Method not allowed.', 405);
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) {
      return corsError(request, 'Bad request: "url" parameter is missing.', 400);
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return corsError(request, 'Bad request: "url" is not a valid URL.', 400);
    }

    if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
      return corsError(request, 'Bad request: only http(s) targets are allowed.', 400);
    }

    if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
      return corsError(request, `Forbidden: host "${targetUrl.hostname}" is not allowed.`, 403);
    }

    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const apiKey = request.headers.get('X-Api-Key');
    if (apiKey && targetUrl.hostname === TORBOX_HOST) {
      headers.set('Authorization', `Bearer ${apiKey}`);
    }

    let response;
    try {
      response = await fetch(targetUrl.toString(), {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'follow',
      });
    } catch (e) {
      return corsError(request, e && e.message ? e.message : 'Upstream fetch failed.', 502);
    }

    const responseHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(request))) {
      responseHeaders.set(key, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};
