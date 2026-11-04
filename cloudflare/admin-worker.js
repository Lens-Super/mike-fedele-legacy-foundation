let cachedJwks;
let cachedJwksUntil = 0;

function b64url(value) {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function verifyAccess(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
    if (header.alg !== "RS256" || !header.kid) return null;
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
    if (claims.iss !== issuer || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) return null;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(env.ACCESS_AUD) || String(claims.email || "").toLowerCase() !== "stephanie@mikefedelelegacy.org") return null;
    if (!cachedJwks || Date.now() > cachedJwksUntil) {
      const response = await fetch(`${issuer}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600, cacheEverything: true } });
      if (!response.ok) return null;
      cachedJwks = await response.json();
      cachedJwksUntil = Date.now() + 3600000;
    }
    const jwk = cachedJwks.keys?.find((key) => key.kid === header.kid && key.kty === "RSA");
    if (!jwk) return null;
    const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, b64url(parts[2]), signed);
    return valid ? claims : null;
  } catch {
    return null;
  }
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

async function allSubmissions(env, status) {
  const query = status && status !== "all"
    ? env.DB.prepare("SELECT * FROM memories WHERE status = ? ORDER BY created_at DESC").bind(status)
    : env.DB.prepare("SELECT * FROM memories ORDER BY created_at DESC");
  const result = await query.all();
  const rows = result.results || [];
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const marks = ids.map(() => "?").join(",");
  const photoResult = await env.DB.prepare(`SELECT * FROM memory_photos WHERE memory_id IN (${marks}) ORDER BY created_at`).bind(...ids).all();
  const photoMap = new Map();
  for (const photo of photoResult.results || []) {
    const photos = photoMap.get(photo.memory_id) || [];
    photos.push({
      id: photo.id,
      memory_id: photo.memory_id,
      original_name: photo.original_name,
      mime_type: photo.mime_type,
      byte_size: photo.byte_size,
      url: `/api/admin/photos/${photo.id}?inline=1`,
      download_url: `/api/admin/photos/${photo.id}`,
    });
    photoMap.set(photo.memory_id, photos);
  }
  return rows.map((row) => ({ ...row, photos: photoMap.get(row.id) || [] }));
}

async function manage(request, env, url) {
  if (request.method === "GET" && url.pathname === "/api/admin/submissions") {
    const status = url.searchParams.get("status") || "pending";
    return json(await allSubmissions(env, status));
  }
  if (request.method === "GET" && url.pathname === "/api/admin/export") {
    const memories = await allSubmissions(env, "all");
    const exportRows = memories.map(({ photos, ...memory }) => ({
      ...memory,
      photos: photos.map(({ url: _url, download_url: _download, ...photo }) => photo),
    }));
    const date = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify({ exported_at: new Date().toISOString(), memories: exportRows }, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="memories-of-mike-${date}.json"` },
    });
  }
  const photoRoute = url.pathname.match(/^\/api\/admin\/photos\/([0-9a-f-]{36})$/i);
  if (request.method === "GET" && photoRoute) {
    const photo = await env.DB.prepare("SELECT object_key, mime_type, original_name FROM memory_photos WHERE id = ?").bind(photoRoute[1]).first();
    if (!photo) return new Response("Not found", { status: 404 });
    const object = await env.PHOTOS.get(photo.object_key);
    if (!object) return new Response("Not found", { status: 404 });
    const safeName = String(photo.original_name || "memory-photo").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    const disposition = url.searchParams.get("inline") === "1" ? "inline" : "attachment";
    return new Response(object.body, { headers: {
      "Content-Type": photo.mime_type,
      "Content-Length": String(object.size),
      "Content-Disposition": `${disposition}; filename="${safeName || "memory-photo"}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  }
  const memoryRoute = url.pathname.match(/^\/api\/admin\/submissions\/([0-9a-f-]{36})$/i);
  if (memoryRoute && request.method === "PATCH") {
    const id = memoryRoute[1];
    const body = await request.json();
    const title = String(body.title || "").trim();
    const story = String(body.story || "").trim();
    const action = body.action;
    if (title.length > 160 || !story || story.length > 20000) return json({ error: "Check the title and story length." }, 400);
    if (!["save", "approve", "reject"].includes(action)) return json({ error: "Unsupported action." }, 400);
    const existing = await env.DB.prepare("SELECT id, status FROM memories WHERE id = ?").bind(id).first();
    if (!existing) return json({ error: "Memory not found." }, 404);
    const now = Date.now();
    const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : existing.status;
    const publishedAt = action === "approve" ? now : action === "reject" ? null : undefined;
    if (publishedAt === undefined) {
      await env.DB.prepare("UPDATE memories SET title = ?, story = ?, updated_at = ? WHERE id = ?").bind(title || null, story, now, id).run();
    } else {
      await env.DB.prepare("UPDATE memories SET title = ?, story = ?, status = ?, published_at = ?, updated_at = ? WHERE id = ?")
        .bind(title || null, story, status, publishedAt, now, id).run();
    }
    return json({ ok: true, status });
  }
  if (memoryRoute && request.method === "DELETE") {
    const memory = await env.DB.prepare("SELECT id FROM memories WHERE id = ?").bind(memoryRoute[1]).first();
    if (!memory) return json({ error: "Memory not found." }, 404);
    const rows = await env.DB.prepare("SELECT object_key, byte_size FROM memory_photos WHERE memory_id = ?").bind(memoryRoute[1]).all();
    await Promise.all((rows.results || []).map((row) => env.PHOTOS.delete(row.object_key)));
    await env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(memoryRoute[1]).run();
    const bytes = (rows.results || []).reduce((sum, row) => sum + row.byte_size, 0);
    if (bytes) await env.DB.prepare("UPDATE storage_quota SET bytes_used = MAX(0, bytes_used - ?) WHERE id = 1").bind(bytes).run();
    return json({ ok: true });
  }
  return json({ error: "Not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && origin !== url.origin) {
      return json({ error: "Cross-origin requests are not allowed." }, 403);
    }
    const claims = await verifyAccess(request, env);
    if (!claims) return json({ error: "Administrator sign-in is required." }, 401);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return await env.ASSETS.fetch(new Request(new URL("/index.html", url), { method: "GET", headers: request.headers }));
      }
      if (url.pathname.startsWith("/api/admin/")) return await manage(request, env, url);
      if (request.method === "GET") return await env.ASSETS.fetch(request);
      return json({ error: "Not found." }, 404);
    } catch (error) {
      console.error("Admin memory API error", error);
      return json({ error: "The review dashboard could not complete that action." }, 500);
    }
  },
};
