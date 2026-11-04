(() => {
  const cfg = window.MEMORIES_CONFIG || {};
  const ADMIN = "stephanie@mikefedelelegacy.org";
  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const login = document.getElementById("admin-login");
  const dashboard = document.getElementById("admin-dashboard");
  const list = document.getElementById("submission-list");
  const notice = document.getElementById("admin-notice");
  const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));

  function say(text, error = false) {
    notice.textContent = text;
    notice.dataset.kind = error ? "error" : "success";
    notice.hidden = !text;
  }

  async function photoUrls(paths) {
    if (!paths.length) return new Map();
    const { data, error } = await client.storage.from("memories-pending").createSignedUrls(paths, 3600);
    if (error) throw error;
    return new Map((data || []).map((row) => [row.path, row.signedUrl]));
  }

  async function load() {
    const { data: rows, error } = await client.from("memories_submissions").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    const ids = (rows || []).map((row) => row.id);
    let photos = [];
    if (ids.length) {
      const result = await client.from("memories_photos").select("*").in("submission_id", ids).order("created_at");
      if (result.error) throw result.error;
      photos = result.data || [];
    }
    const urls = await photoUrls(photos.map((photo) => photo.object_path));
    list.replaceChildren();
    if (!rows?.length) {
      const empty = document.createElement("p");
      empty.textContent = "No submissions yet.";
      list.append(empty);
      return;
    }
    for (const row of rows) list.append(render(row, photos.filter((photo) => photo.submission_id === row.id), urls));
  }

  function render(row, photos, urls) {
    const article = document.createElement("article");
    article.className = "admin-memory";
    article.dataset.id = row.id;
    const photoHtml = photos.map((photo) => urls.get(photo.object_path)
      ? `<figure><img src="${esc(urls.get(photo.object_path))}" alt="Photo submitted with this memory"><figcaption><button type="button" data-remove-photo="${esc(photo.id)}">Remove photo</button></figcaption></figure>`
      : "").join("");
    article.innerHTML = `<div class="admin-memory-head"><span class="status-badge status-${esc(row.status)}">${esc(row.status)}</span><time>${new Date(row.created_at).toLocaleString()}</time></div>
      <p><strong>Contributor:</strong> ${esc(row.contributor_name)} · <a href="mailto:${encodeURIComponent(row.contributor_email)}">${esc(row.contributor_email)}</a></p>
      <label>Title <input class="edit-title" maxlength="160" value="${esc(row.title || "")}"></label>
      <label>Story <textarea class="edit-story" rows="8" maxlength="20000" required>${esc(row.story)}</textarea></label>
      <div class="admin-photos">${photoHtml || "<p>No photographs attached.</p>"}</div>
      <div class="admin-actions"><button type="button" data-action="save">Save edits</button><button type="button" data-action="approve">${row.status === "approved" ? "Update published memory" : "Approve & publish"}</button><button type="button" data-action="reject">Reject</button><button type="button" class="danger" data-action="delete">Remove permanently</button></div>`;
    article.addEventListener("click", async (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      button.disabled = true;
      try {
        if (button.dataset.removePhoto) {
          const photo = photos.find((entry) => entry.id === button.dataset.removePhoto);
          if (photo) {
            const { error: storageError } = await client.storage.from("memories-pending").remove([photo.object_path]);
            if (storageError) throw storageError;
            const { error } = await client.from("memories_photos").delete().eq("id", photo.id);
            if (error) throw error;
          }
          say("Photo removed.");
        } else {
          const action = button.dataset.action;
          const update = {
            title: article.querySelector(".edit-title").value.trim() || null,
            story: article.querySelector(".edit-story").value.trim(),
            updated_at: new Date().toISOString(),
          };
          if (!update.story) throw new Error("A story is required.");
          if (action === "save" || action === "approve") {
            if (action === "approve") {
              update.status = "approved";
              update.published_at = new Date().toISOString();
            }
            const { error } = await client.from("memories_submissions").update(update).eq("id", row.id);
            if (error) throw error;
            say(action === "approve" ? "Memory approved and published." : "Edits saved.");
          } else if (action === "reject") {
            const { error } = await client.from("memories_submissions").update({ ...update, status: "rejected", published_at: null }).eq("id", row.id);
            if (error) throw error;
            say("Memory rejected and hidden from the public page.");
          } else if (action === "delete") {
            if (!confirm("Permanently remove this memory and all attached photos?")) return;
            if (photos.length) {
              const { error } = await client.storage.from("memories-pending").remove(photos.map((photo) => photo.object_path));
              if (error) throw error;
            }
            const { error } = await client.from("memories_submissions").delete().eq("id", row.id);
            if (error) throw error;
            say("Memory removed permanently.");
          }
        }
        await load();
      } catch (error) {
        say(error.message || "That change could not be saved.", true);
      } finally {
        button.disabled = false;
      }
    });
    return article;
  }

  async function updateSession() {
    const { data: { session } } = await client.auth.getSession();
    if (!session) {
      login.hidden = false;
      dashboard.hidden = true;
      return;
    }
    if (session.user.email?.toLowerCase() !== ADMIN) {
      await client.auth.signOut();
      login.hidden = false;
      dashboard.hidden = true;
      say(`Access is limited to ${ADMIN}.`, true);
      return;
    }
    login.hidden = true;
    dashboard.hidden = false;
    await load();
  }

  document.getElementById("admin-login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = document.getElementById("admin-email").value.trim().toLowerCase();
    if (email !== ADMIN) return say(`Access is limited to ${ADMIN}.`, true);
    const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}${location.pathname}` } });
    say(error ? error.message : "Check your email for the secure sign-in link.", !!error);
  });
  document.getElementById("admin-refresh").addEventListener("click", () => load().catch((error) => say(error.message, true)));
  document.getElementById("admin-signout").addEventListener("click", async () => { await client.auth.signOut(); await updateSession(); });
  client.auth.onAuthStateChange(() => setTimeout(() => updateSession().catch((error) => say(error.message, true)), 0));
  updateSession().catch((error) => say(error.message || "Admin dashboard could not load.", true));
})();
