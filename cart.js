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
    if (error.status === 401) window.location.assign(`/login.html?next=${encodeURIComponent("/cart.html")}`);
  }

  function render(cart) {
    const items = $("#cart-items");
    items.innerHTML = cart.items.length ? cart.items.map((item) => `<article class="shop-line"><img src="${item.product.image}" alt="${item.product.name}" /><div><strong>${item.product.name}</strong><small>${item.product.brand} · ${money(item.unitPrice)} each</small><div class="quantity-control"><button type="button" data-quantity="${item.product.id}" data-change="-1" aria-label="Decrease quantity">−</button><span>${item.quantity}</span><button type="button" data-quantity="${item.product.id}" data-change="1" aria-label="Increase quantity">+</button></div></div><div class="shop-line-end"><strong>${money(item.subtotal)}</strong><button class="customer-button danger" type="button" data-remove="${item.product.id}">Remove</button></div></article>`).join("") : '<p class="customer-empty">Your cart is empty. Browse the catalog to add products.</p>';
    $("#cart-summary").innerHTML = cart.items.length ? `<div class="summary-list"><div class="summary-row"><span>Subtotal</span><strong>${money(cart.subtotal)}</strong></div><div class="summary-row"><span>Delivery</span><strong>${money(cart.deliveryFee)}</strong></div><div class="summary-row total"><span>Total</span><strong>${money(cart.total)}</strong></div><div class="customer-actions"><a class="customer-button" href="checkout.html">Continue to checkout</a><button class="customer-button secondary" type="button" id="clear-cart">Clear cart</button></div></div>` : "";
  }

  async function load() {
    try { render(await api("/api/cart")); }
    catch (error) { login(error); $("#cart-status").textContent = error.message; }
  }

  $("#cart-items").addEventListener("click", async (event) => {
    const change = event.target.closest("[data-quantity]");
    const remove = event.target.closest("[data-remove]");
    if (!change && !remove) return;
    try {
      if (remove) await api(`/api/cart/${encodeURIComponent(remove.dataset.remove)}`, { method: "DELETE" });
      else {
        const current = Number(change.parentElement.querySelector("span").textContent);
        const next = current + Number(change.dataset.change);
        if (next < 1) await api(`/api/cart/${encodeURIComponent(change.dataset.quantity)}`, { method: "DELETE" });
        else await api(`/api/cart/${encodeURIComponent(change.dataset.quantity)}`, { method: "PUT", body: JSON.stringify({ quantity: next }) });
      }
      await load();
    } catch (error) { login(error); $("#cart-status").textContent = error.message; }
  });

  document.addEventListener("click", async (event) => {
    if (event.target.id !== "clear-cart") return;
    try { await api("/api/cart", { method: "DELETE" }); await load(); }
    catch (error) { login(error); $("#cart-status").textContent = error.message; }
  });

  load();
})();