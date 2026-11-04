(() => {
  const config = window.MEMORIES_CONFIG || {};
  const base = String(config.apiBase || "").replace(/\/$/, "");
  const form = document.getElementById("memory-form");
  const status = document.getElementById("memory-form-status");
  const gallery = document.getElementById("approved-memories");
  const setupNotice = document.getElementById("memories-setup-notice");

  function showMessage(text, kind = "") {
    status.textContent = text;
    status.dataset.kind = kind;
    status.hidden = !text;
  }
  if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/i.test(base)) {
    form.hidden = true;
    setupNotice.hidden = false;
    setupNotice.textContent = "The memory submission system is being connected. Please check back soon — nothing is published without Stephanie’s approval.";
    gallery.replaceChildren();
    return;
  }
  form.hidden = false;
  setupNotice.hidden = true;
  const turnstileContainer = document.getElementById("memory-turnstile");
  let turnstileToken = "";
  const renderChallenge = () => {
    if (!config.turnstileSiteKey || !window.turnstile || turnstileContainer.dataset.rendered) return;
    turnstileContainer.dataset.rendered = "1";
    window.turnstile.render(turnstileContainer, {
      sitekey: config.turnstileSiteKey,
      callback: (token) => { turnstileToken = token; },
      "expired-callback": () => { turnstileToken = ""; },
      "error-callback": () => { turnstileToken = ""; },
    });
  };
  document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')?.addEventListener("load", renderChallenge, { once: true });
  renderChallenge();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    showMessage("Sending your memory…", "busy");
    const data = new FormData(form);
    data.set("turnstile_token", turnstileToken);
    try {
      const response = await fetch(`${base}/api/submit`, { method: "POST", body: data, mode: "cors" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Please try again.");
      form.reset();
      turnstileToken = "";
      window.turnstile?.reset();
      showMessage("Thank you for sharing a piece of Mike. Stephanie will review it before anything appears here.", "success");
    } catch (error) {
      showMessage(error.message || "We couldn't send that memory right now. Please try again.", "error");
      window.turnstile?.reset();
      turnstileToken = "";
    } finally {
      submit.disabled = false;
    }
  });

  function createCard(memory) {
    const article = document.createElement("article");
    article.className = "memory-card";
    if (memory.title) {
      const title = document.createElement("h3");
      title.className = "memory-card-title";
      title.textContent = memory.title;
      article.append(title);
    }
    const story = document.createElement("p");
    story.className = "memory-card-story";
    story.textContent = memory.story;
    article.append(story);
    if (memory.photos?.length) {
      const photoGrid = document.createElement("div");
      photoGrid.className = "memory-card-photos";
      for (const photo of memory.photos) {
        const image = document.createElement("img");
        image.src = photo.url;
        image.alt = `Photo shared by ${memory.contributor_name} with this memory of Mike`;
        image.loading = "lazy";
        photoGrid.append(image);
      }
      article.append(photoGrid);
    }
    const byline = document.createElement("p");
    byline.className = "memory-card-byline";
    byline.textContent = `Shared by ${memory.contributor_name}`;
    article.append(byline);
    return article;
  }

  async function loadMemories() {
    const response = await fetch(`${base}/api/memories`, { cache: "no-store", mode: "cors" });
    if (!response.ok) throw new Error("Public memories unavailable");
    const records = await response.json();
    gallery.replaceChildren();
    if (!records.length) {
      const empty = document.createElement("p");
      empty.className = "memories-empty";
      empty.textContent = "No memories have been shared here yet. You can help start the collection.";
      gallery.append(empty);
      return;
    }
    records.forEach((memory) => gallery.append(createCard(memory)));
  }
  loadMemories().catch(() => {
    gallery.replaceChildren();
    const error = document.createElement("p");
    error.className = "memories-empty";
    error.textContent = "Memories are temporarily unavailable. Please reload in a little while.";
    gallery.append(error);
  });
})();
