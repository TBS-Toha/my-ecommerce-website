(() => {
  const $ = (selector) => document.querySelector(selector);
  const money = (amount) => `৳${Number(amount || 0).toLocaleString("en-US")}`;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    const payload = await response.json();
    if (!response.ok) { const error = new Error(payload.error || "The request could not be completed."); error.status = response.status; throw error; }
    return payload;
  }

  function login(error) {
    if (error.status === 401) window.location.assign(`/login.html?next=${encodeURIComponent("/wishlist.html")}`);
  }

  function render(products) {
    const target = $("#wishlist-items");
    target.innerHTML = products.length ? products.map((product) => `<article class="customer-item"><img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" style="width:58px;height:58px;object-fit:cover;border-radius:6px;background:#eee" /><div class="customer-item-copy"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.brand)} · ${money(product.price)}</small></div><div class="customer-item-actions"><button class="customer-button" type="button" data-wishlist-cart="${escapeHtml(product.id)}">Add to cart</button><button class="customer-button danger" type="button" data-wishlist-remove="${escapeHtml(product.id)}">Remove</button></div></article>`).join("") : '<p class="customer-empty">Your wishlist is empty.</p>';
    target.querySelectorAll("img").forEach((image) => image.addEventListener("error", () => { image.hidden = true; }, { once: true }));
  }

  async function load() {
    try { render(await api("/api/wishlist")); }
    catch (error) { login(error); $("#wishlist-status").textContent = error.message; }
  }

  $("#wishlist-items").addEventListener("click", async (event) => {
    const add = event.target.closest("[data-wishlist-cart]");
    const remove = event.target.closest("[data-wishlist-remove]");
    const productId = add?.dataset.wishlistCart || remove?.dataset.wishlistRemove;
    if (!productId) return;
    try {
      if (add) await api("/api/cart", { method: "POST", body: JSON.stringify({ productId, quantity: 1 }) });
      if (remove) await api(`/api/wishlist/${encodeURIComponent(productId)}`, { method: "DELETE" });
      await load();
      $("#wishlist-status").textContent = add ? "Added to cart." : "Removed from wishlist.";
    } catch (error) { login(error); $("#wishlist-status").textContent = error.message; $("#wishlist-status").classList.add("error"); }
  });

  load();
})();
