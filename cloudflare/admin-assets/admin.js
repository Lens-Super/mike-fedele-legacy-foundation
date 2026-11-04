const list = document.getElementById("submissions");
const notice = document.getElementById("notice");
const filter = document.getElementById("filter");

function notify(text, isError = false) {
  notice.textContent = text;
  notice.hidden = !text;
  notice.dataset.error = isError ? "true" : "false";
}
function element(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
async function request(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const type = response.headers.get("Content-Type") || "";
  const body = type.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status}).`);
  return body;
}
function photoTile(photo) {
  const figure = element("figure", "photo");
  const image = element("img");
  image.src = photo.url;
  image.alt = "Photograph attached to this memory";
  image.loading = "lazy";
  const actions = element("figcaption");
  const view = element("a", "", "View");
  view.href = photo.url;
  view.target = "_blank";
  view.rel = "noopener";
  const download = element("a", "", "Download original");
  download.href = photo.download_url;
  actions.append(view, download);
  figure.append(image, actions);
  return figure;
}
function makeCard(memory) {
  const article = element("article", "memory");
  const top = element("div", "memory-top");
  top.append(element("span", `badge ${memory.status}`, memory.status), element("time", "submitted", new Date(memory.created_at).toLocaleString()));
  article.append(top);
  const contact = element("p", "private-email");
  contact.append(element("strong", "", "Contributor: "), document.createTextNode(`${memory.contributor_name} · `));
  const email = element("a", "", memory.contributor_email);
  email.href = `mailto:${encodeURIComponent(memory.contributor_email)}`;
  contact.append(email);
  article.append(contact);
  const titleLabel = element("label", "", "Title");
  const title = element("input");
  title.maxLength = 160;
  title.value = memory.title || "";
  titleLabel.append(title);
  const storyLabel = element("label", "", "Story");
  const story = element("textarea");
  story.maxLength = 20000;
  story.required = true;
  story.value = memory.story;
  storyLabel.append(story);
  article.append(titleLabel, storyLabel);
  const photos = element("div", "photos");
  memory.photos.forEach((photo) => photos.append(photoTile(photo)));
  if (memory.photos.length) article.append(photos);
  else article.append(element("p", "submitted", "No photographs attached."));
  const actions = element("div", "actions");
  const save = element("button", "", "Save edits");
  const approve = element("button", "", memory.status === "approved" ? "Update published memory" : "Approve & publish");
  const reject = element("button", "", "Reject");
  const remove = element("button", "danger", "Remove permanently");
  actions.append(save, approve, reject, remove);
  article.append(actions);

  async function update(action) {
    const body = { action, title: title.value.trim(), story: story.value.trim() };
    if (!body.story) return notify("A story is required.", true);
    for (const button of actions.querySelectorAll("button")) button.disabled = true;
    try {
      await request(`/api/admin/submissions/${memory.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      notify(action === "approve" ? "Memory approved and published." : action === "reject" ? "Memory rejected and hidden." : "Edits saved.");
      await load();
    } catch (error) { notify(error.message, true); }
    finally { for (const button of actions.querySelectorAll("button")) button.disabled = false; }
  }
  save.addEventListener("click", () => update("save"));
  approve.addEventListener("click", () => update("approve"));
  reject.addEventListener("click", () => update("reject"));
  remove.addEventListener("click", async () => {
    if (!confirm("Permanently remove this memory and its original photographs?")) return;
    remove.disabled = true;
    try {
      await request(`/api/admin/submissions/${memory.id}`, { method: "DELETE" });
      notify("Memory and original photographs removed.");
      await load();
    } catch (error) { notify(error.message, true); remove.disabled = false; }
  });
  return article;
}
async function load() {
  list.replaceChildren(element("p", "empty", "Loading submissions…"));
  try {
    const rows = await request(`/api/admin/submissions?status=${encodeURIComponent(filter.value)}`);
    list.replaceChildren();
    if (!rows.length) { list.append(element("p", "empty", "No submissions in this view.")); return; }
    rows.forEach((memory) => list.append(makeCard(memory)));
  } catch (error) {
    list.replaceChildren(element("p", "empty", error.message));
  }
}
filter.addEventListener("change", load);
document.getElementById("refresh").addEventListener("click", load);
document.getElementById("export").addEventListener("click", () => { location.href = "/api/admin/export"; });
load();
