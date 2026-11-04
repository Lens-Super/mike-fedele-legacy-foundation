const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_PHOTOS = 5;
const MAX_PHOTO_STORAGE_BYTES = 8_000_000_000;
const MAX_STORY_CHARS = 20000;
const MAX_BODY_BYTES = 28 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function cors(origin, env) {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  });
  if (origin === env.SITE_ORIGIN || origin === "https://www.mikefedelelegacy.org") {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function json(body, status, origin, env, extra = {}) {
  const headers = cors(origin, env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(JSON.stringify(body), { status, headers });
}

function hasSignature(bytes, mime) {
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value);
  if (mime === "image/webp") return String.fromCharCode(...bytes.slice(0,4)) === "RIFF" && String.fromCharCode(...bytes.slice(8,12)) === "WEBP";
  return false;
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2,"0")).join("");
}

async function checkTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET_KEY) return false;
  if (!token) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.set("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form,
  });
  if (!response.ok) return false;
  const result = await response.json();
  return result.success === true && (!result.hostname || ["mikefedelelegacy.org","www.mikefedelelegacy.org"].includes(result.hostname));
}

async function withinLimit(request, env) {
  if (!env.RATE_LIMIT_SALT) throw new Error("Rate limit key is not configured");
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = await sha256(`${env.RATE_LIMIT_SALT}:${ip}`);
  const now = Date.now();
  const hour = Math.floor(now / 3600000);
  const day = Math.floor(now / 86400000);
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO submission_limits (ip_hash, window_type, window_start, count)
      VALUES (?, 'hour', ?, 1) ON CONFLICT(ip_hash, window_type, window_start)
      DO UPDATE SET count = count + 1 RETURNING count`).bind(key, hour),
    env.DB.prepare(`INSERT INTO submission_limits (ip_hash, window_type, window_start, count)
      VALUES (?, 'day', ?, 1) ON CONFLICT(ip_hash, window_type, window_start)
      DO UPDATE SET count = count + 1 RETURNING count`).bind(key, day),
    env.DB.prepare(`DELETE FROM submission_limits WHERE
      (window_type = 'hour' AND window_start < ?) OR (window_type = 'day' AND window_start < ?)`).bind(hour - 48, day - 2),
  ]);
  return (result[0]?.results?.[0]?.count || 0) <= 5 && (result[1]?.results?.[0]?.count || 0) <= 20;
}

async function submit(request, env, origin) {
  const declaredSize = Number(request.headers.get("Content-Length") || 0);
  if (declaredSize > MAX_BODY_BYTES) return json({ error: "The upload is too large. Use up to five photos, each no larger than 5 MB." }, 413, origin, env);
  const form = await request.formData();
  if (String(form.get("website") || "")) return json({ ok: true }, 200, origin, env);
  const name = String(form.get("contributor_name") || "").trim();
  const email = String(form.get("contributor_email") || "").trim().toLowerCase();
  const title = String(form.get("title") || "").trim();
  const story = String(form.get("story") || "").trim();
  const consent = form.get("permission") === "on";
  const photos = form.getAll("photos").filter((item) => item instanceof File && item.size > 0);
  const challenge = String(form.get("turnstile_token") || "");

  if (!name || name.length > 120) return json({ error: "Please enter a name under 120 characters." }, 400, origin, env);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Please enter a valid email address." }, 400, origin, env);
  if (!story || story.length > MAX_STORY_CHARS) return json({ error: "Please share a memory up to 20,000 characters." }, 400, origin, env);
  if (title.length > 160) return json({ error: "Please keep the title under 160 characters." }, 400, origin, env);
  if (!consent) return json({ error: "Please confirm permission to review and publish your story and any selected photos." }, 400, origin, env);
  if (photos.length > MAX_PHOTOS) return json({ error: "Choose no more than five photographs." }, 400, origin, env);
  if (!(await checkTurnstile(challenge, request, env))) return json({ error: "Please complete the anti-spam check and try again." }, 400, origin, env);
  if (!(await withinLimit(request, env))) return json({ error: "The submission limit for this connection has been reached. Please try again later." }, 429, origin, env);

  const prepared = [];
  for (const file of photos) {
    if (file.size > MAX_PHOTO_BYTES) return json({ error: "Each photo must be 5 MB or smaller." }, 413, origin, env);
    const mime = (file.type || "").toLowerCase();
    if (!ALLOWED_MIME.has(mime)) return json({ error: "Photos must be JPG, PNG, or WebP images." }, 400, origin, env);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!hasSignature(bytes, mime)) return json({ error: "A selected file does not match its image type. Please choose another photo." }, 400, origin, env);
    prepared.push({ file, mime, bytes, extension: mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : "webp" });
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const totalBytes = prepared.reduce((sum, photo) => sum + photo.file.size, 0);
  if (totalBytes) {
    const reservation = await env.DB.prepare(`UPDATE storage_quota SET bytes_used = bytes_used + ?
      WHERE id = 1 AND bytes_used + ? <= ? RETURNING bytes_used`).bind(totalBytes, totalBytes, MAX_PHOTO_STORAGE_BYTES).first();
    if (!reservation) return json({ error: "Photo storage is temporarily full. The foundation will need to make room before new photos can be accepted." }, 507, origin, env);
  }
  const stored = [];
  try {
    await env.DB.prepare(`INSERT INTO memories
      (id, contributor_name, contributor_email, title, story, permission_granted, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 'pending', ?, ?)`)
      .bind(id, name, email, title || null, story, now, now).run();
    for (const item of prepared) {
      const photoId = crypto.randomUUID();
      const objectKey = `${id}/${photoId}.${item.extension}`;
      await env.PHOTOS.put(objectKey, item.bytes, { httpMetadata: { contentType: item.mime } });
      stored.push(objectKey);
      const originalName = String(item.file.name || "memory-photo").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "memory-photo";
      await env.DB.prepare(`INSERT INTO memory_photos (id, memory_id, object_key, original_name, mime_type, byte_size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(photoId, id, objectKey, originalName, item.mime, item.file.size, now).run();
    }
  } catch (error) {
    await Promise.allSettled(stored.map((key) => env.PHOTOS.delete(key)));
    await env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(id).run();
    if (totalBytes) await env.DB.prepare("UPDATE storage_quota SET bytes_used = MAX(0, bytes_used - ?) WHERE id = 1").bind(totalBytes).run();
    console.error("Photo upload rolled back", error);
    return json({ error: "We could not save that submission. Please try again." }, 500, origin, env);
  }
  return json({ ok: true }, 201, origin, env);
}

async function publicMemories(request, env, origin) {
  const result = await env.DB.prepare(`SELECT id, contributor_name, title, story, published_at
    FROM memories WHERE status = 'approved' ORDER BY published_at DESC, created_at DESC`).all();
  const records = result.results || [];
  const photos = records.length
    ? await env.DB.prepare(`SELECT p.id, p.memory_id FROM memory_photos p JOIN memories m ON m.id = p.memory_id
       WHERE m.status = 'approved' ORDER BY p.created_at`).all()
    : { results: [] };
  const photosByMemory = new Map();
  for (const photo of photos.results || []) {
    const list = photosByMemory.get(photo.memory_id) || [];
    list.push({ id: photo.id, url: `${new URL(request.url).origin}/photos/${photo.id}` });
    photosByMemory.set(photo.memory_id, list);
  }
  const safe = records.map((row) => ({ ...row, photos: photosByMemory.get(row.id) || [] }));
  return json(safe, 200, origin, env);
}

async function publicPhoto(id, env, origin) {
  const photo = await env.DB.prepare(`SELECT p.object_key, p.mime_type FROM memory_photos p
    JOIN memories m ON m.id = p.memory_id WHERE p.id = ? AND m.status = 'approved'`).bind(id).first();
  if (!photo) return new Response("Not found", { status: 404, headers: cors(origin, env) });
  const object = await env.PHOTOS.get(photo.object_key);
  if (!object) return new Response("Not found", { status: 404, headers: cors(origin, env) });
  const headers = cors(origin, env);
  headers.set("Content-Type", photo.mime_type);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin, env) });
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true }, 200, origin, env);
    try {
      if (url.pathname === "/api/submit" && request.method === "POST") {
        if (origin !== env.SITE_ORIGIN && origin !== "https://www.mikefedelelegacy.org") return json({ error: "Origin not allowed." }, 403, origin, env);
        return await submit(request, env, origin);
      }
      if (url.pathname === "/api/memories" && request.method === "GET") return await publicMemories(request, env, origin);
      const photoMatch = url.pathname.match(/^\/photos\/([0-9a-f-]{36})$/i);
      if (photoMatch && request.method === "GET") return await publicPhoto(photoMatch[1], env, origin);
      return json({ error: "Not found." }, 404, origin, env);
    } catch (error) {
      console.error("Public memory API error", error);
      return json({ error: "The memory service is temporarily unavailable. Please try again." }, 500, origin, env);
    }
  },
};
