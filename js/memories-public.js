(() => {
  const cfg = window.MEMORIES_CONFIG || {};
  const form = document.getElementById("memory-form");
  const status = document.getElementById("memory-form-status");
  const gallery = document.getElementById("approved-memories");
  const setupNotice = document.getElementById("memories-setup-notice");
  const endpoint = `${String(cfg.supabaseUrl || "").replace(/\/$/, "")}/functions/v1/submit-memory`;
  const configured = /^https:\/\/[\w-]+\.supabase\.co$/.test(cfg.supabaseUrl || "") && !!cfg.supabaseAnonKey;
  const esc = (value) => String(value || "");

  function message(text, kind) {
    status.textContent = text;
    status.dataset.kind = kind || "";
    status.hidden = !text;
  }

  if (!configured) {
    form.hidden = true;
    setupNotice.hidden = false;
    setupNotice.textContent = "The memory form is being connected. Please check back soon — nothing is published without Stephanie’s approval.";
    gallery.innerHTML = "";
    return;
  }

  setupNotice.hidden = true;
  form.hidden = false;
  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  if (cfg.turnstileSiteKey) {
    const renderChallenge = () => {
      if (!window.turnstile || form.dataset.turnstileRendered) return;
      form.dataset.turnstileRendered = "true";
      window.turnstile.render(document.getElementById("memory-turnstile"), {
        sitekey: cfg.turnstileSiteKey,
        callback: (token) => { form.dataset.turnstileToken = token; },
        "expired-callback": () => { form.dataset.turnstileToken = ""; },
        "error-callback": () => { form.dataset.turnstileToken = ""; }
      });
    };
    document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')?.addEventListener("load", renderChallenge, { once: true });
    renderChallenge();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    message("Sending your memory…", "busy");
    const data = new FormData(form);
    data.set("turnstile_token", form.dataset.turnstileToken || "");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { apikey: cfg.supabaseAnonKey }, body: data });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Please try again.");
      form.reset();
      form.dataset.turnstileToken = "";
      window.turnstile?.reset();
      message("Thank you for sharing a piece of Mike. Stephanie will review it before anything appears here.", "success");
    } catch (error) {
      message(error.message || "We couldn't send that memory right now. Please try again.", "error");
    } finally {
      button.disabled = false;
    }
  });

  function cardFor(memory, signedByPath) {
    const article = document.createElement("article");
    article.className = "memory-card";
    const heading = document.createElement(memory.title ? "h3" : "p");
    if (memory.title) heading.className = "memory-card-title";
    else heading.className = "memory-card-story";
    heading.textContent = memory.title || memory.story;
    article.append(heading);
    if (memory.title) {
      const story = document.createElement("p");
      story.className = "memory-card-story";
      story.textContent = memory.story;
      article.append(story);
    }
    if (memory.photos?.length) {
      const photos = document.createElement("div");
      photos.className = "memory-card-photos";
      memory.photos.forEach((photo) => {
        const src = signedByPath.get(photo.path);
        if (!src) return;
        const image = document.createElement("img");
        image.src = src;
        image.alt = `Photo shared by ${esc(memory.contributor_name)} with this memory of Mike`;
        image.loading = "lazy";
        photos.append(image);
      });
      if (photos.childElementCount) article.append(photos);
    }
    const byline = document.createElement("p");
    byline.className = "memory-card-byline";
    byline.textContent = `Shared by ${esc(memory.contributor_name)}`;
    article.append(byline);
    return article;
  }

  async function loadMemories() {
    const { data, error } = await client.rpc("get_published_memories");
    if (error) throw error;
    const paths = [...new Set((data || []).flatMap((entry) => (entry.photos || []).map((photo) => photo.path)))];
    let signed = [];
    if (paths.length) {
      const result = await client.storage.from("memories-pending").createSignedUrls(paths, 300);
      if (result.error) throw result.error;
      signed = result.data || [];
    }
    const signedByPath = new Map(signed.map((item) => [item.path, item.signedUrl]));
    gallery.replaceChildren();
    (data || []).forEach((entry) => gallery.append(cardFor(entry, signedByPath)));
    if (!data?.length) {
      const empty = document.createElement("p");
      empty.className = "memories-empty";
      empty.textContent = "No memories have been shared here yet. You can help start the collection.";
      gallery.append(empty);
    }
  }

  loadMemories().catch(() => {
    gallery.innerHTML = '<p class="memories-empty">Memories are temporarily unavailable. Please reload in a little while.</p>';
  });
})();
