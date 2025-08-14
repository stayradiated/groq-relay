export interface Env {
  // required
  GROQ_API_KEY: string

  // allow a comma-separated list of models (e.g. "llama-3.1-8b-instant,llama-3.1-70b-versatile")
  ALLOW_MODELS?: string

  // comma-separated path prefixes allowed to proxy (default below)
  // example: "/openai/v1/chat/completions,/openai/v1/models"
  ALLOW_PATHS?: string

  // optional CORS
  CORS_ORIGINS?: string // CSV allowlist; if provided we echo the request's Origin when it matches
}

const UPSTREAM_ORIGIN = 'https://api.groq.com'

const csv = (s?: string) =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

function pickOrigin(req: Request, env: Env): string {
  const fromList = csv(env.CORS_ORIGINS)
  const reqOrigin = req.headers.get('Origin')
  if (fromList.length) {
    if (reqOrigin && fromList.includes(reqOrigin)) {
      return reqOrigin
    }
    const origin = fromList[0]
    if (origin) {
      return origin
    }
  }
  return '*'
}

function withCORS(res: Response, origin: string) {
  const h = new Headers(res.headers)
  h.set('Access-Control-Allow-Origin', origin)
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (origin !== '*') {
    h.append('Vary', 'Origin')
  }
  return new Response(res.body, { status: res.status, headers: h })
}

function allowedPath(pathname: string, env: Env) {
  const defaults = [
    '/openai/v1/chat/completions',
    '/openai/v1/responses',
    '/openai/v1/embeddings',
    '/openai/v1/models',
  ]
  const allow = csv(env.ALLOW_PATHS)
  const list = allow.length ? allow : defaults
  return list.some((p) => pathname === p || pathname.startsWith(p))
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = pickOrigin(req, env)
    const url = new URL(req.url)

    // Health and preflight
    if (url.pathname === '/health') {
      return withCORS(
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        }),
        origin,
      )
    }
    if (req.method === 'OPTIONS') {
      return withCORS(new Response(null, { status: 204 }), origin)
    }

    // Path allowlist
    if (!allowedPath(url.pathname, env)) {
      return withCORS(new Response('Not found', { status: 404 }), origin)
    }

    // Build upstream URL (mirror path & query)
    const upstream = new URL(url.pathname + url.search, UPSTREAM_ORIGIN)

    // Clone headers & inject secret
    const headers = new Headers(req.headers)
    headers.set('Authorization', `Bearer ${env.GROQ_API_KEY}`)
    headers.set(
      'Content-Type',
      headers.get('Content-Type') || 'application/json',
    )
    headers.delete('Host') // will be set by fetch()

    // Prepare body: only inspect JSON POSTs to enforce model/limits
    let body: BodyInit | null = null
    if (req.method === 'POST') {
      const ct = headers.get('Content-Type') || ''
      if (ct.includes('application/json')) {
        const raw = await req.text()
        let json: unknown
        try {
          json = raw ? JSON.parse(raw) : {}
        } catch {
          return withCORS(
            new Response(JSON.stringify({ error: 'Invalid JSON' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }),
            origin,
          )
        }

        // Model enforcement
        const allowedModels = csv(env.ALLOW_MODELS)
        const requested = (
          typeof json === 'object' &&
          json !== null &&
          'model' in json &&
          typeof json.model === 'string'
            ? json.model
            : ''
        ).trim()

        if (allowedModels.length) {
          if (!requested || !allowedModels.includes(requested)) {
            return withCORS(
              new Response(
                JSON.stringify({
                  error: 'Model not allowed',
                  allowed: allowedModels,
                }),
                {
                  status: 403,
                  headers: { 'Content-Type': 'application/json' },
                },
              ),
              origin,
            )
          }
        }

        body = JSON.stringify(json)
      } else {
        // Non-JSON (e.g. multipart for audio) — forward raw
        body = req.body
      }
    }

    // Proxy the request
    const upstreamRes = await fetch(upstream.toString(), {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? null : body,
    })

    // Pass streaming bodies through unchanged (SSE, etc.)
    const resHeaders = new Headers(upstreamRes.headers)
    // add/override CORS
    const proxied = new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: resHeaders,
    })
    return withCORS(proxied, origin)
  },
}
