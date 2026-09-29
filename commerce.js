(() => {
  const accountLink = document.getElementById("account-link");
  const cartCount = document.getElementById("cart-count");
  const wishlistCount = document.getElementById("wishlist-count");
  let currentUser = null;
  let wishlistIds = new Set();
  let toastTimer;

  function toast(message) {
    let element = document.getElementById("commerce-toast");
    if (!element) {
      element = document.createElement("div");
      element.id = "commerce-toast";
      element.className = "commerce-toast";
      element.setAttribute("role", "status");
      document.body.append(element);
    }
    element.textContent = message;
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element.hidden = true; }, 2600);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error || "The request could not be completed.");
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function requestLogin() {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/login.html?next=${encodeURIComponent(next)}`);
  }

  async function refreshCommerceState() {
    const result = await api("/api/auth/me");
    currentUser = result.user;
    if (accountLink && currentUser) {
      accountLink.textContent = currentUser.isAdmin ? "Admin" : currentUser.name.split(" ")[0];
      accountLink.href = currentUser.isAdmin ? "/admin.html" : "/account.html";
    }
    if (!currentUser) return;
    const [cart, wishlist] = await Promise.all([api("/api/cart"), api("/api/wishlist")]);
    if (cartCount) cartCount.textContent = String(cart.items.reduce((total, item) => total + item.quantity, 0));
    if (wishlistCount) wishlistCount.textContent = String(wishlist.length);
    wishlistIds = new Set(wishlist.map((product) => product.id));
    document.querySelectorAll("[data-wishlist-toggle]").forEach((button) => {
      const active = wishlistIds.has(button.dataset.wishlistToggle);
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("aria-label", `${active ? "Remove" : "Add"} ${button.dataset.productName || "product"} ${active ? "from" : "to"} wishlist`);
    });
  }

  document.addEventListener("click", async (event) => {
    const cartButton = event.target.closest("[data-cart-add], [data-buy-now]");
    const wishlistButton = event.target.closest("[data-wishlist-toggle]");
    const button = cartButton || wishlistButton;
    if (!button) return;
    event.preventDefault();
    if (!currentUser) return requestLogin();
    button.disabled = true;
    try {
      if (cartButton) {
        const productId = cartButton.dataset.cartAdd || cartButton.dataset.buyNow;
        const cart = await api("/api/cart", { method: "POST", body: JSON.stringify({ productId, quantity: 1 }) });
        if (cartCount) cartCount.textContent = String(cart.items.reduce((total, item) => total + item.quantity, 0));
        if (cartButton.hasAttribute("data-buy-now")) window.location.assign("/checkout.html");
        else toast("Added to your cart.");
      } else {
        const productId = wishlistButton.dataset.wishlistToggle;
        if (wishlistIds.has(productId)) {
          await api(`/api/wishlist/${encodeURIComponent(productId)}`, { method: "DELETE" });
          wishlistIds.delete(productId);
          if (wishlistCount) wishlistCount.textContent = String(wishlistIds.size);
          toast("Removed from your wishlist.");
        } else {
          const result = await api("/api/wishlist", { method: "POST", body: JSON.stringify({ productId }) });
          wishlistIds.add(productId);
          if (wishlistCount) wishlistCount.textContent = String(result.wishlist);
          toast("Added to your wishlist.");
        }
        wishlistButton.setAttribute("aria-pressed", String(wishlistIds.has(productId)));
      }
    } catch (error) {
      if (error.status === 401) return requestLogin();
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  });

  refreshCommerceState().catch((error) => console.error("Could not load account state:", error));
  window.addEventListener("smartmart:products-changed", () => {
    refreshCommerceState().catch((error) => console.error("Could not refresh account state:", error));
  });
})();