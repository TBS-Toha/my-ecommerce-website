(() => {
  const FALLBACK_IMAGE = "images/category-02.jpg";
  const API_URL = "/api/products";
  const categoryNames = {
    watch: "Watches",
    smartphone: "Smartphones",
    "sound-box": "Sound Box",
    headphone: "Headphones"
  };
  const defaultCategoryIds = new Set(Object.keys(categoryNames));
  const badgeTypes = new Set(["new", "hot", "sale", "grey"]);
  const defaultProducts = Array.isArray(window.SMART_MART_DEFAULT_PRODUCTS)
    ? window.SMART_MART_DEFAULT_PRODUCTS
    : [];

  async function readJsonResponse(response, fallbackMessage) {
    const body = await response.text();
    let payload = null;
    if (body) {
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error(`${fallbackMessage} The server returned an invalid response (HTTP ${response.status}).`);
      }
    }
    if (!response.ok) throw new Error(payload?.error || `${fallbackMessage} (HTTP ${response.status}).`);
    if (payload === null) throw new Error(`${fallbackMessage} The server returned an empty response.`);
    return payload;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function normalizeImagePath(value) {
    const normalized = String(value ?? "").trim().replace(/\\/g, "/").replace(/^file:\/+/i, "");
    const filename = normalized.split("/").filter(Boolean).pop() || "";
    if (!filename || filename === "." || filename === "..") return "";
    return `images/${filename}`;
  }

  let products = [];

  function getDiscount(product, oldPrice = product.oldPrice) {
    if (!(Number(oldPrice) > Number(product.price)) || !(Number(product.price) >= 0)) return 0;
    return Math.round(((Number(oldPrice) - Number(product.price)) / Number(oldPrice)) * 100);
  }

  function getStock(product) {
    const quantity = product.stockQuantity;
    if (quantity !== null && quantity !== undefined && quantity !== "" && Number.isFinite(Number(quantity))) {
      const count = Math.max(0, Number(quantity));
      if (count === 0) return { label: "Out of Stock", className: "limited" };
      if (count <= 5) return { label: `Only ${count} Left`, className: "only-few" };
      return { label: "In Stock", className: "in-stock" };
    }
    if (product.stockStatus === "out-of-stock") return { label: "Out of Stock", className: "limited" };
    if (product.stockStatus === "limited") return { label: "Limited Stock", className: "limited" };
    if (product.stockStatus === "only-few") return { label: "Only 5 Left", className: "only-few" };
    return { label: "In Stock", className: "in-stock" };
  }

  function bindImageFallbacks(root) {
    root.querySelectorAll("img[data-product-image]").forEach((image) => {
      const showPlaceholder = () => {
        const placeholder = document.createElement("span");
        placeholder.className = "image-not-found";
        placeholder.setAttribute("role", "img");
        placeholder.setAttribute("aria-label", "Image not found");
        placeholder.textContent = "Image not found";
        image.replaceWith(placeholder);
      };
      image.addEventListener("error", showPlaceholder, { once: true });
    });
  }

  function productImageMarkup(image, alt, available = true) {
    if (!available) return '<span class="image-not-found" role="img" aria-label="Image not found">Image not found</span>';
    return `<img data-product-image src="${escapeHtml(image || FALLBACK_IMAGE)}" alt="${escapeHtml(alt || "Product image")}" />`;
  }

  function renderProductCard(product) {
    const badgeType = badgeTypes.has(product.badgeType) ? product.badgeType : "grey";
    const specifications = Array.isArray(product.specifications) ? product.specifications : [];
    const features = Array.isArray(product.detailedFeatures) ? product.detailedFeatures : [];
    const stock = getStock(product);
    const discount = getDiscount(product);
    const rating = Number(product.rating);
    const image = normalizeImagePath(product.image) || FALLBACK_IMAGE;
    const badge = product.badge
      ? `<div class="product-badge badge-${badgeType}">${escapeHtml(product.badge)}</div>`
      : "";

    return `<article class="product-card" id="product-${escapeHtml(product.id)}">
      ${badge}
      <button class="product-wishlist" type="button" data-wishlist-toggle="${escapeHtml(product.id)}" data-product-name="${escapeHtml(product.name)}" aria-label="Add ${escapeHtml(product.name)} to wishlist" aria-pressed="false">♡</button>
      ${productImageMarkup(image, product.altText || product.name, product.imageAvailable !== false)}
      <div class="product-body">
        <div class="brand-row">
          <span class="brand">${escapeHtml(product.brand)}</span>
          ${Number.isFinite(rating) && rating > 0 ? `<span class="rating">★★★★★ ${rating.toFixed(1)}</span>` : ""}
        </div>
        <h3>${escapeHtml(product.name)}</h3>
        <p>${escapeHtml(product.description)}</p>
        ${specifications.length ? `<div class="spec-grid">${specifications.map((specification) => `<div><span>${escapeHtml(specification.label)}</span><strong>${escapeHtml(specification.value)}</strong></div>`).join("")}</div>` : ""}
        <div class="price-row">
          <div class="price-box">
            ${Number(product.oldPrice) > Number(product.price) ? `<span class="old">৳${Number(product.oldPrice).toLocaleString("en-US")}</span>` : ""}
            <strong>৳${Number(product.price || 0).toLocaleString("en-US")}</strong>
          </div>
          ${discount ? `<span class="discount">${discount}% OFF</span>` : ""}
        </div>
        <div class="stock-row"><span class="stock ${stock.className}">✓ ${escapeHtml(stock.label)}</span></div>
        <div class="card-actions">
          <button class="btn-small btn-secondary" type="button" data-cart-add="${escapeHtml(product.id)}">Add to Cart</button>
          <button class="btn-small btn-primary" type="button" data-buy-now="${escapeHtml(product.id)}">Buy Now</button>
        </div>
        ${features.length ? `<details><summary>View Details</summary><ul>${features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join("")}</ul></details>` : ""}
      </div>
    </article>`;
  }

  function renderDealCard(product) {
    const oldPrice = Number(product.dealOldPrice || product.oldPrice || 0);
    const hasOriginalDealPrice = Number(product.dealPrice) === Number(product.price);
    const discount = hasOriginalDealPrice && Number.isFinite(Number(product.dealDiscount))
      ? Number(product.dealDiscount)
      : getDiscount(product, oldPrice);
    const hasQuantity = product.stockQuantity !== null && product.stockQuantity !== undefined && product.stockQuantity !== "";
    const stock = !hasQuantity && product.dealStockStatus === "limited"
      ? { label: "Limited Stock", className: "limited" }
      : getStock(product);
    const image = normalizeImagePath(product.image) || FALLBACK_IMAGE;
    return `<article class="deal-card">
      <span class="deal-badge">${discount ? `${discount}% OFF` : "DEAL"}</span>
      ${productImageMarkup(image, product.altText || product.name, product.imageAvailable !== false)}
      <div class="deal-body">
        <h3>${escapeHtml(product.name)}</h3>
        <div class="deal-price"><strong>৳${Number(product.price || 0).toLocaleString("en-US")}</strong><s>৳${oldPrice.toLocaleString("en-US")}</s></div>
        <span class="stock ${stock.className}">✓ ${escapeHtml(stock.label)}</span>
        <button class="btn-small btn-primary deal-add" type="button" data-buy-now="${escapeHtml(product.id)}">Buy now</button>
      </div>
    </article>`;
  }

  function renderFeaturedCard(product, index) {
    const badge = product.featuredBadge || product.badge || "FEATURED";
    const image = normalizeImagePath(product.featuredImage || product.image) || FALLBACK_IMAGE;
    const imageAvailable = product.featuredImage ? product.featuredImageAvailable !== false : product.imageAvailable !== false;
    const description = product.featuredDescription || product.description || "";
    const hasOriginalFeaturedPrices = Number(product.featuredPrice) === Number(product.price)
      && Number(product.featuredOldPrice) === Number(product.oldPrice);
    const savings = hasOriginalFeaturedPrices
      ? Number(product.featuredSave ?? getDiscount(product))
      : getDiscount(product);
    return `<article class="featured-card${index === 0 ? " featured-large" : ""}">
      <div class="featured-copy">
        <span class="tag">${escapeHtml(badge)}</span>
        <h3>${escapeHtml(product.name)}</h3>
        <p>${escapeHtml(description)}</p>
        <div class="featured-price-row"><strong>৳${Number(product.price || 0).toLocaleString("en-US")}</strong>${savings ? `<span>Save ${savings}%</span>` : ""}</div>
      </div>
      ${productImageMarkup(image, product.altText || product.name, imageAvailable)}
    </article>`;
  }

  function renderStore() {
    for (const category of Object.keys(categoryNames)) {
      const grid = document.getElementById(category)?.querySelector(".product-grid");
      if (!grid) continue;
      grid.innerHTML = products
        .filter((product) => product.category === category && product.catalogVisible !== false)
        .map(renderProductCard)
        .join("");
      const count = products.filter((product) => product.category === category && product.catalogVisible !== false).length;
      const countElement = document.querySelector(`[data-category-count="${category}"]`);
      if (countElement) countElement.textContent = `${count} ${count === 1 ? "item" : "items"}`;
    }

    const dealGrid = document.querySelector(".deal-grid");
    if (dealGrid) {
      dealGrid.innerHTML = products
        .filter((product) => product.deal)
        .sort((first, second) => Number(first.dealOrder || 999) - Number(second.dealOrder || 999))
        .map(renderDealCard)
        .join("");
    }

    const featuredGrid = document.querySelector(".featured-grid");
    if (featuredGrid) {
      featuredGrid.innerHTML = products.filter((product) => product.featured).map(renderFeaturedCard).join("");
    }

    bindImageFallbacks(document);
  }

  function syncCategories(categories) {
    const categoryGrid = document.querySelector(".category-grid");
    for (const category of categories) categoryNames[category.id] = category.name;
    if (!categoryGrid) return;
    let anchor = document.getElementById("headphone");
    const categoryIds = new Set(categories.map((category) => category.id));
    document.querySelectorAll("[data-api-category]").forEach((element) => {
      if (!categoryIds.has(element.dataset.apiCategory)) element.remove();
    });
    for (const category of categories) {
      if (!document.getElementById(category.id)) {
        const section = document.createElement("section");
        section.className = "product-section container";
        section.id = category.id;
        section.dataset.apiCategory = category.id;
        section.innerHTML = `<div class="section-heading split-heading"><div><span class="eyebrow accent">COLLECTION</span><h2>${escapeHtml(category.name)}</h2></div><a href="#categories" class="text-link">Back to categories</a></div><div class="product-grid"></div>`;
        anchor.after(section);
        anchor = section;
      } else {
        anchor = document.getElementById(category.id);
      }
      let existingCard = categoryGrid.querySelector(`[data-api-category="${CSS.escape(category.id)}"]`);
      if (!existingCard) {
        existingCard = document.createElement("article");
        existingCard.className = "category-card";
        existingCard.dataset.apiCategory = category.id;
        existingCard.innerHTML = '<div class="category-image-wrap"></div><div class="category-body"><div class="category-title-row"><span class="category-tag"></span><span class="category-count"></span></div><h3></h3><p></p><a class="text-link">Explore now</a></div>';
        categoryGrid.append(existingCard);
      }
      const firstProduct = products.find((product) => product.category === category.id);
      const categoryImage = normalizeImagePath(category.image);
      if (categoryImage || !defaultCategoryIds.has(category.id)) {
        const imagePath = categoryImage || normalizeImagePath(firstProduct?.image) || FALLBACK_IMAGE;
        const imageAvailable = categoryImage ? true : firstProduct?.imageAvailable !== false;
        existingCard.querySelector(".category-image-wrap").innerHTML = productImageMarkup(imagePath, category.name, imageAvailable);
      }
      existingCard.querySelector(".category-tag").textContent = category.name.toUpperCase();
      existingCard.querySelector(".category-count").dataset.categoryCount = category.id;
      existingCard.querySelector(".category-count").textContent = `${category.productCount} ${category.productCount === 1 ? "item" : "items"}`;
      existingCard.querySelector("h3").textContent = category.name;
      if (category.description || !defaultCategoryIds.has(category.id)) {
        existingCard.querySelector("p").textContent = category.description || `Explore ${category.name} products.`;
      }
      existingCard.querySelector("a").href = `#${category.id}`;
    }
  }

  async function refreshProducts() {
    const [response, categoriesResponse] = await Promise.all([
      fetch(API_URL, { cache: "no-store" }),
      fetch("/api/categories", { cache: "no-store" })
    ]);
    const [payload, categoriesPayload] = await Promise.all([
      readJsonResponse(response, "Unable to load the product catalog."),
      readJsonResponse(categoriesResponse, "Unable to load product categories.")
    ]);
    products = Array.isArray(payload) ? payload : [];
    syncCategories(Array.isArray(categoriesPayload) ? categoriesPayload : []);
    renderStore();
    window.dispatchEvent(new CustomEvent("smartmart:products-changed", { detail: products }));
    return structuredClone(products);
  }

  async function requestProduct(path, method, product, imageFile) {
    const formData = new FormData();
    formData.append("product", JSON.stringify(product));
    if (imageFile) formData.append("image", imageFile);
    const response = await fetch(path, { method, body: formData });
    const payload = await readJsonResponse(response, "The product could not be saved.");
    await refreshProducts();
    return payload;
  }

  async function replaceProducts(nextProducts) {
    const response = await fetch(API_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextProducts)
    });
    const payload = await readJsonResponse(response, "The product catalog could not be replaced.");
    products = payload;
    renderStore();
    window.dispatchEvent(new CustomEvent("smartmart:products-changed", { detail: products }));
    return structuredClone(products);
  }

  async function deleteProduct(id) {
    const response = await fetch(`${API_URL}/${encodeURIComponent(id)}`, { method: "DELETE" });
    const payload = await readJsonResponse(response, "The product could not be deleted.");
    await refreshProducts();
    return payload;
  }

  const ready = refreshProducts();

  window.SmartMartStore = {
    getProducts: () => structuredClone(products),
    getDefaultProducts: () => structuredClone(defaultProducts),
    saveProduct: (product, imageFile) => requestProduct(
      product.id ? `${API_URL}/${encodeURIComponent(product.id)}` : API_URL,
      product.id ? "PUT" : "POST",
      product,
      imageFile
    ),
    replaceProducts,
    deleteProduct,
    refreshProducts,
    ready,
    getStock
  };

  const searchDialog = document.getElementById("product-search");
  const searchInput = document.getElementById("product-search-input");
  const searchResults = document.getElementById("search-results");

  function renderSearchResults() {
    if (!searchInput || !searchResults) return;
    const query = searchInput.value.trim().toLocaleLowerCase();
    if (!query) {
      searchResults.innerHTML = '<p class="search-hint">Type a name, brand, or category to search.</p>';
      return;
    }
    const matches = products.filter((product) => [product.name, product.brand, categoryNames[product.category]]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query)));
    searchResults.innerHTML = matches.length
      ? matches.map((product) => `<a class="search-result" href="#${escapeHtml(product.category)}">${productImageMarkup(normalizeImagePath(product.image) || FALLBACK_IMAGE, "", product.imageAvailable !== false)}<span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.brand)} · ${escapeHtml(categoryNames[product.category] || product.category)}</small></span><b>৳${Number(product.price || 0).toLocaleString("en-US")}</b></a>`).join("")
      : '<p class="search-hint">No matching products found.</p>';
    bindImageFallbacks(searchResults);
    searchResults.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => searchDialog?.close()));
  }

  document.getElementById("search-open")?.addEventListener("click", () => {
    searchDialog?.showModal();
    renderSearchResults();
    searchInput?.focus();
  });
  document.getElementById("search-close")?.addEventListener("click", () => searchDialog?.close());
  searchInput?.addEventListener("input", renderSearchResults);
  searchDialog?.addEventListener("click", (event) => {
    if (event.target === searchDialog) searchDialog.close();
  });
  searchDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    searchDialog.close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchDialog?.open) searchDialog.close();
  });

  window.addEventListener("focus", () => refreshProducts().catch((error) => console.error(error)));
})();
