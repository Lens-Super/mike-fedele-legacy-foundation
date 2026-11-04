import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const allowedOrigins = new Set([
  "https://mikefedelelegacy.org",
  "https://www.mikefedelelegacy.org",
]);
const bucket = "memories-pending";
const maxPhotos = 5;
const maxPhotoBytes = 4 * 1024 * 1024;
const encoder = new TextEncoder();

function corsHeaders(origin: string | null) {
  const headers = new Headers({
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  });
  if (origin && allowedOrigins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function json(body: unknown, status: number, origin: string | null) {
  const headers = corsHeaders(origin);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function isImageSignature(bytes: Uint8Array, mime: string) {
  if (mime === "image/jpeg") return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value);
  if (mime === "image/webp") return String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return false;
}

async function sha256(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (request.method !== "POST" || !origin || !allowedOrigins.has(origin)) return json({ error: "This submission request is not available." }, 403, origin);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 23 * 1024 * 1024) return json({ error: "The upload is too large. Please use up to five photos, each under 4 MB." }, 413, origin);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: "The submission service is not configured yet." }, 503, origin);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  try {
    const form = await request.formData();
    const contributorName = String(form.get("contributor_name") || "").trim();
    const contributorEmail = String(form.get("contributor_email") || "").trim().toLowerCase();
    const title = String(form.get("title") || "").trim();
    const story = String(form.get("story") || "").trim();
    const consent = form.get("permission") === "on";
    const honeypot = String(form.get("website") || "");
    const token = String(form.get("turnstile_token") || "");
    const photos = form.getAll("photos").filter((item): item is File => item instanceof File && item.size > 0);

    // Bots tend to fill the hidden field. Return a normal success to avoid teaching the check.
    if (honeypot) return json({ ok: true }, 200, origin);
    if (!contributorName || contributorName.length > 120) return json({ error: "Please enter a name under 120 characters." }, 400, origin);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contributorEmail) || contributorEmail.length > 254) return json({ error: "Please enter a valid email address." }, 400, origin);
    if (!story || story.length > 20000) return json({ error: "Please share a memory of up to 20,000 characters." }, 400, origin);
    if (title.length > 160) return json({ error: "Please keep the title under 160 characters." }, 400, origin);
    if (!consent) return json({ error: "Please confirm permission to publish your story and any selected photos." }, 400, origin);
    if (photos.length > maxPhotos) return json({ error: "Please choose no more than five photos." }, 400, origin);

    const turnstileSecret = Deno.env.get("TURNSTILE_SECRET_KEY");
    if (turnstileSecret) {
      if (!token) return json({ error: "Please complete the anti-spam check and try again." }, 400, origin);
      const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: turnstileSecret, response: token }),
      });
      const result = await verify.json();
      if (!result.success || (result.hostname && !["mikefedelelegacy.org", "www.mikefedelelegacy.org"].includes(result.hostname))) {
        return json({ error: "The anti-spam check expired. Please try again." }, 400, origin);
      }
    }

    const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
    const ipHash = await sha256(`${ip}:${Deno.env.get("RATE_LIMIT_SALT") || serviceKey}`);
    const { data: withinLimit, error: limitError } = await admin.rpc("consume_memories_submission_limit", { p_bucket_key: ipHash });
    if (limitError) throw limitError;
    if (!withinLimit) return json({ error: "A few memories have already been sent from this connection. Please try again later." }, 429, origin);

    const prepared = [] as Array<{ file: File; mime: string; ext: string; bytes: Uint8Array }>;
    for (const file of photos) {
      if (file.size > maxPhotoBytes) return json({ error: "Each photo must be 4 MB or smaller." }, 413, origin);
      const mime = file.type.toLowerCase();
      if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) return json({ error: "Photos must be JPG, PNG, or WebP images." }, 400, origin);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isImageSignature(bytes, mime)) return json({ error: "One of those files does not match its image type. Please choose another photo." }, 400, origin);
      prepared.push({ file, mime, ext: mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : "webp", bytes });
    }

    const { data: submission, error: insertError } = await admin.from("memories_submissions").insert({
      contributor_name: contributorName,
      contributor_email: contributorEmail,
      title: title || null,
      story,
      permission_granted: true,
      status: "pending",
    }).select("id").single();
    if (insertError) throw insertError;

    const uploadedPaths: string[] = [];
    try {
      for (const item of prepared) {
        const objectPath = `${submission.id}/${crypto.randomUUID()}.${item.ext}`;
        const { error } = await admin.storage.from(bucket).upload(objectPath, item.bytes, {
          contentType: item.mime,
          cacheControl: "0",
          upsert: false,
        });
        if (error) throw error;
        uploadedPaths.push(objectPath);
        const { error: photoError } = await admin.from("memories_photos").insert({
          submission_id: submission.id,
          object_path: objectPath,
          mime_type: item.mime,
          byte_size: item.file.size,
        });
        if (photoError) throw photoError;
      }
    } catch (error) {
      if (uploadedPaths.length) await admin.storage.from(bucket).remove(uploadedPaths);
      await admin.from("memories_submissions").delete().eq("id", submission.id);
      throw error;
    }
    return json({ ok: true }, 200, origin);
  } catch (error) {
    console.error("Memory submission failed", error);
    return json({ error: "We couldn't send that memory right now. Your information was not published. Please try again." }, 500, origin);
  }
});
