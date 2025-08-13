export interface Env {
  GROQ_API_KEY: string;
}

// set to your blog’s origin for CORS, e.g. "https://yourblog.com"
const CORS_ORIGIN = "https://george.czabania.com";

interface RequestBody {
  system?: string;
  user: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string;
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      ...extra,
    },
  });
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsPreflight();
    }

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname !== "/chat") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let body: RequestBody;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const {
      system = "You are a helpful assistant.",
      user,
      model = "llama-3.1-8b-instant",
      temperature = 1,
      max_tokens = 1024, // your client can pass this; we’ll map below
      top_p = 1,
      stop, // optional
    } = body ?? {};

    if (!user || typeof user !== "string") {
      return json({ error: "Missing 'user' (string) in body" }, 400);
    }

    // Build OpenAI-compatible payload for Groq
    const payload: Record<string, unknown> = {
      model,
      temperature,
      top_p,
      stream: true,
      // Groq supports max_completion_tokens (keep to match your current code)
      max_completion_tokens: max_tokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    if (stop != null) payload.stop = stop;

    const groqRes = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    // Bubble up non-OK errors in JSON so your client can show them nicely
    if (!groqRes.ok || !groqRes.body) {
      let details = "";
      try {
        details = await groqRes.text();
      } catch {}
      return json(
        {
          error: "Upstream Groq error",
          status: groqRes.status,
          details: details?.slice(0, 2000),
        },
        groqRes.status,
      );
    }

    // Stream the SSE straight through
    const headers = new Headers();
    headers.set("Content-Type", "text/event-stream");
    headers.set("Cache-Control", "no-cache");
    headers.set("Connection", "keep-alive");
    headers.set("Access-Control-Allow-Origin", CORS_ORIGIN);
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");

    return new Response(groqRes.body, { status: 200, headers });
  },
};
