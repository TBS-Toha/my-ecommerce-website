(() => {
  const store = window.SmartMartStore;
  if (!store) {
    console.error("Product storage is unavailable. Check that products.js loads before admin.js.");
    return;
  }

  const categories = {
    watch: "Watches",
    smartphone: "Smartphones",
    "sound-box": "Sound Box",
    headphone: "Headphones"
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
  const money = (value) => `৳${Number(value || 0).toLocaleString("en-US")}`;
  let products = [];
  let pendingDeleteId = null;
  let toastTimer;
  let previewObjectUrl = null;
  let saving = false;

  function replaceWithImagePlaceholder(image) {
    const placeholder = document.createElement("span");
    placeholder.className = "image-not-found";
    placeholder.setAttribute("role", "img");
    placeholder.setAttribute("aria-label", "Image not found");
    placeholder.textContent = "Image not found";
    image.replaceWith(placeholder);
  }

  function clearPreviewObjectUrl() {
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }

  function stockState(product) {
    const hasQuantity = product.stockQuantity !== null && product.stockQuantity !== undefined && product.stockQuantity !== "";
    if (!hasQuantity) {
      if (product.stockStatus === "out-of-stock") return "out-of-stock";
      if (product.stockStatus === "only-few" || product.stockStatus === "limited") return "low-stock";
      return "in-stock";
    }
    const status = store.getStock(product);
    if (status.className === "only-few") return "low-stock";
    if (status.className === "limited") return "out-of-stock";
    return "in-stock";
  }

  function stockLabel(product) {
    const status = store.getStock(product);
    if (product.stockQuantity === null || product.stockQuantity === undefined || product.stockQuantity === "") return `${status.label} · qty unknown`;
    return `${status.label} · ${Number(product.stockQuantity)}`;
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
  }

  function renderStats() {
    const visibleProducts = products.filter((product) => product.catalogVisible !== false);
    const stats = {
      total: products.length,
      watch: visibleProducts.filter((product) => product.category === "watch").length,
      smartphone: visibleProducts.filter((product) => product.category === "smartphone").length,
      "sound-box": visibleProducts.filter((product) => product.category === "sound-box").length,
      headphone: visibleProducts.filter((product) => product.category === "headphone").length,
      "in-stock": products.filter((product) => stockState(product) === "in-stock").length,
      "low-stock": products.filter((product) => stockState(product) === "low-stock").length,
      "out-of-stock": products.filter((product) => stockState(product) === "out-of-stock").length
    };
    $$('[data-stat]').forEach((element) => {
      element.textContent = String(stats[element.dataset.stat] ?? 0);
    });

    const recentProducts = [...products].sort((first, second) => String(second.createdAt || "").localeCompare(String(first.createdAt || ""))).slice(0, 5);
    $("#recent-products").innerHTML = recentProducts.length
      ? recentProducts.map((product) => `<tr><td>${productCell(product)}</td><td class="category-label">${escapeHtml(categories[product.category] || product.category)}</td><td>${money(product.price)}</td><td><span class="stock-label ${stockState(product)}">${escapeHtml(stockLabel(product))}</span></td><td>${escapeHtml(product.createdAt || "—")}</td></tr>`).join("")
      : '<tr><td colspan="5" class="empty-state">No products yet.</td></tr>';
    bindAdminImageFallbacks($("#recent-products"));
  }

  function productCell(product) {
    const image = product.imageAvailable === false
      ? '<span class="image-not-found" role="img" aria-label="Image not found">Image not found</span>'
      : `<img data-admin-image src="${escapeHtml(product.image || "images/category-02.jpg")}" alt="" />`;
    return `<div class="product-cell">${image}<span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.id)}</small></span></div>`;
  }

  function renderBrandOptions() {
    const select = $("#filter-brand");
    const current = select.value;
    const brands = [...new Set(products.map((product) => String(product.brand || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    select.innerHTML = '<option value="">All brands</option>' + brands.map((brand) => `<option value="${escapeHtml(brand)}">${escapeHtml(brand)}</option>`).join("");
    if (brands.includes(current)) select.value = current;
  }

  function filterProducts() {
    const query = $("#filter-search").value.trim().toLocaleLowerCase();
    const category = $("#filter-category").value;
    const brand = $("#filter-brand").value;
    const stock = $("#filter-stock").value;
    const featured = $("#filter-featured").value;
    const deal = $("#filter-deal").value;
    const sort = $("#sort-products").value;
    const visible = products.filter((product) => {
      const matchesQuery = !query || [product.name, product.brand, categories[product.category] || product.category]
        .some((value) => String(value || "").toLocaleLowerCase().includes(query));
      return matchesQuery
        && (!category || product.category === category)
        && (!brand || product.brand === brand)
        && (!stock || stockState(product) === stock)
        && (featured === "" || Boolean(product.featured) === (featured === "true"))
        && (deal === "" || Boolean(product.deal) === (deal === "true"));
    });

    visible.sort((first, second) => {
      if (sort === "price-asc") return Number(first.price) - Number(second.price);
      if (sort === "price-desc") return Number(second.price) - Number(first.price);
      if (sort === "stock") return Number(second.stockQuantity ?? -1) - Number(first.stockQuantity ?? -1);
      if (sort === "rating") return Number(second.rating || 0) - Number(first.rating || 0);
      return String(first.name).localeCompare(String(second.name));
    });

    $("#product-result-count").textContent = `${visible.length} ${visible.length === 1 ? "product" : "products"}`;
    $("#product-table-body").innerHTML = visible.length
      ? visible.map((product) => `<tr>
        <td>${productCell(product)}</td>
        <td><span>${escapeHtml(product.brand || "—")}</span><br /><span class="category-label">${escapeHtml(categories[product.category] || product.category)}</span></td>
        <td>${money(product.price)}${product.oldPrice > product.price ? `<br /><small>${Math.round((1 - product.price / product.oldPrice) * 100)}% off</small>` : ""}</td>
        <td>${product.stockQuantity === null || product.stockQuantity === undefined || product.stockQuantity === "" ? "—" : Number(product.stockQuantity)}</td>
        <td><span class="stock-label ${stockState(product)}">${escapeHtml(store.getStock(product).label)}</span></td>
        <td><span class="flag-label${product.featured ? " is-on" : ""}">${product.featured ? "✓ Yes" : "—"}</span></td>
        <td><div class="row-actions"><button class="icon-action" type="button" data-action="edit" data-id="${escapeHtml(product.id)}" title="Edit product">EDIT</button><button class="icon-action" type="button" data-action="duplicate" data-id="${escapeHtml(product.id)}" title="Duplicate product">COPY</button><button class="icon-action delete" type="button" data-action="delete" data-id="${escapeHtml(product.id)}" title="Delete product">DEL</button></div></td>
      </tr>`).join("")
      : '<tr><td colspan="7" class="empty-state">No products match these filters.</td></tr>';
    bindAdminImageFallbacks($("#product-table-body"));
  }

  function renderOverviewLists() {
    $("#category-overview").innerHTML = Object.entries(categories).map(([key, label]) => {
      const count = products.filter((product) => product.category === key && product.catalogVisible !== false).length;
      return `<article class="category-overview-card"><span>${escapeHtml(label)}</span><strong>${count}</strong></article>`;
    }).join("");
    renderManagementList("#deal-overview", products.filter((product) => product.deal));
    renderManagementList("#featured-overview", products.filter((product) => product.featured));
  }

  function renderManagementList(selector, items) {
    const target = $(selector);
    target.innerHTML = items.length ? items.map((product) => `<article class="management-item">${product.imageAvailable === false ? '<span class="image-not-found" role="img" aria-label="Image not found">Image not found</span>' : `<img data-admin-image src="${escapeHtml(product.image || "images/category-02.jpg")}" alt="" />`}<div class="management-item-copy"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.brand)} · ${money(product.price)}</small></div><button class="button button-secondary" type="button" data-action="edit" data-id="${escapeHtml(product.id)}">Edit</button></article>`).join("") : '<p class="empty-state">No products selected.</p>';
    bindAdminImageFallbacks(target);
  }

  function bindAdminImageFallbacks(root) {
    root.querySelectorAll("img[data-admin-image]").forEach((image) => {
      image.addEventListener("error", () => replaceWithImagePlaceholder(image), { once: true });
    });
  }

  function renderAll() {
    products = store.getProducts();
    renderStats();
    renderBrandOptions();
    filterProducts();
    renderOverviewLists();
  }

  function setView(view) {
    const target = $(`[data-view="${view}"]`);
    if (!target) return;
    $$(".admin-view").forEach((section) => section.classList.toggle("active", section === target));
    $$("[data-view-target]").forEach((button) => button.classList.toggle("active", button.dataset.viewTarget === view));
    const titles = { dashboard: "Dashboard", products: "Products", form: $("#product-id").value ? "Edit product" : "Add product", categories: "Categories", deals: "Deals", featured: "Featured products", settings: "Settings" };
    $("#page-title").textContent = titles[view] || "Dashboard";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function addSpecificationRow(specification = { label: "", value: "" }) {
    const row = document.createElement("div");
    row.className = "spec-row";
    row.innerHTML = `<input type="text" aria-label="Specification name" placeholder="Label" value="${escapeHtml(specification.label)}" /><input type="text" aria-label="Specification value" placeholder="Value" value="${escapeHtml(specification.value)}" /><button type="button" class="remove-row" aria-label="Remove specification">×</button>`;
    row.querySelector(".remove-row").addEventListener("click", () => row.remove());
    $("#spec-list").append(row);
  }

  function addFeatureRow(value = "") {
    const row = document.createElement("div");
    row.className = "feature-row";
    row.innerHTML = `<input type="text" aria-label="Product feature" placeholder="Product feature" value="${escapeHtml(value)}" /><button type="button" class="remove-row" aria-label="Remove feature">×</button>`;
    row.querySelector(".remove-row").addEventListener("click", () => row.remove());
    $("#feature-list").append(row);
  }

  function setImagePreview(source) {
    const image = $("#image-preview");
    const placeholder = $("#image-preview-placeholder");
    const showPlaceholder = () => {
      image.hidden = true;
      placeholder.hidden = false;
    };
    if (!source) {
      showPlaceholder();
      return;
    }
    image.onerror = showPlaceholder;
    placeholder.hidden = true;
    image.src = source;
    image.hidden = false;
  }

  function setImagePathStatus(message, invalid = false) {
    $("#image-path-status").textContent = message;
    $("#image-path-status").classList.toggle("is-error", invalid);
  }

  function resetForm() {
    clearPreviewObjectUrl();
    $("#product-form").reset();
    $("#product-id").value = "";
    $("#spec-list").replaceChildren();
    $("#feature-list").replaceChildren();
    addSpecificationRow();
    addFeatureRow();
    $("#form-title").textContent = "Add product";
    $("#save-product-button").textContent = "Save product";
    $("#discount-preview").textContent = "—";
    $("#stock-preview").textContent = "In Stock";
    setImagePathStatus("");
    $("#image-current-label").textContent = "Choose an image from your computer. The server saves it to the project's images folder.";
    $("#file-pick-label").firstChild.textContent = "Choose image";
    setImagePreview("images/category-02.jpg");
    setView("form");
  }

  function openProductForm(product = null) {
    resetForm();
    if (product) {
      $("#product-id").value = product.id;
      $("#product-name").value = product.name || "";
      $("#product-brand").value = product.brand || "";
      $("#product-category").value = product.category || "watch";
      $("#product-description").value = product.description || "";
      $("#image-current-label").textContent = product.image ? `Current image: ${product.image}` : "This product has no saved image.";
      $("#file-pick-label").firstChild.textContent = "Replace image";
      $("#product-old-price").value = product.oldPrice ?? "";
      $("#product-price").value = product.price ?? "";
      $("#product-rating").value = product.rating ?? "";
      $("#product-stock").value = product.stockQuantity ?? "";
      $("#product-badge").value = product.badge || "";
      $("#product-badge-type").value = product.badgeType || "new";
      $("#product-featured").checked = Boolean(product.featured);
      $("#product-deal").checked = Boolean(product.deal);
      $("#spec-list").replaceChildren();
      $("#feature-list").replaceChildren();
      (product.specifications || []).forEach(addSpecificationRow);
      (product.detailedFeatures || []).forEach(addFeatureRow);
      if (!product.specifications?.length) addSpecificationRow();
      if (!product.detailedFeatures?.length) addFeatureRow();
      $("#form-title").textContent = "Edit product";
      $("#save-product-button").textContent = "Update product";
      setImagePreview(product.imageAvailable === false ? "" : product.image);
      updateCalculatedFields();
    }
    setView("form");
  }

  function updateCalculatedFields() {
    const oldPrice = Number($("#product-old-price").value);
    const price = Number($("#product-price").value);
    const discount = oldPrice > price && oldPrice > 0 ? Math.round((1 - price / oldPrice) * 100) : 0;
    $("#discount-preview").textContent = discount ? `${discount}% OFF` : "No discount";
    const rawQuantity = $("#product-stock").value;
    const quantity = rawQuantity === "" ? null : Math.max(0, Number(rawQuantity));
    $("#stock-preview").textContent = quantity === null ? "In Stock · quantity unknown" : quantity === 0 ? "Out of Stock" : quantity <= 5 ? `Only ${quantity} Left` : "In Stock";
  }

  function collectFormProduct() {
    const id = $("#product-id").value;
    const old = products.find((product) => product.id === $("#product-id").value);
    const oldPrice = Number($("#product-old-price").value) || 0;
    const price = Number($("#product-price").value) || 0;
    const stockInput = $("#product-stock").value;
    const stockQuantity = stockInput === "" ? null : Math.max(0, Number(stockInput));
    const specifications = $$(".spec-row", $("#spec-list")).map((row) => {
      const [label, value] = $$('input', row).map((input) => input.value.trim());
      return label && value ? { label, value } : null;
    }).filter(Boolean);
    const detailedFeatures = $$(".feature-row input", $("#feature-list")).map((input) => input.value.trim()).filter(Boolean);
    const product = {
      ...(old || {}),
      id,
      category: $("#product-category").value,
      brand: $("#product-brand").value.trim().toUpperCase(),
      name: $("#product-name").value.trim(),
      image: old?.image || "",
      altText: $("#product-name").value.trim(),
      badge: $("#product-badge").value.trim(),
      badgeType: $("#product-badge-type").value,
      rating: $("#product-rating").value === "" ? null : Number($("#product-rating").value),
      description: $("#product-description").value.trim(),
      oldPrice,
      price,
      discount: oldPrice > price && oldPrice > 0 ? Math.round((1 - price / oldPrice) * 100) : 0,
      stockStatus: stockQuantity === null ? "in-stock" : stockQuantity === 0 ? "out-of-stock" : stockQuantity <= 5 ? "only-few" : "in-stock",
      stockQuantity,
      specifications,
      detailedFeatures,
      featured: $("#product-featured").checked,
      deal: $("#product-deal").checked,
      createdAt: old?.createdAt || new Date().toISOString().slice(0, 10)
    };
    if (product.featured) {
      product.featuredBadge = old?.featuredBadge || product.badge || "FEATURED";
      product.featuredImage = old?.featuredImage || product.image;
      product.featuredDescription = old?.featuredDescription || product.description;
    } else {
      delete product.featuredBadge;
      delete product.featuredImage;
      delete product.featuredDescription;
      delete product.featuredPrice;
      delete product.featuredOldPrice;
      delete product.featuredSave;
    }
    if (product.deal) {
      product.dealOldPrice = old?.dealOldPrice || oldPrice;
      product.dealOrder = old?.dealOrder || 999;
    } else {
      delete product.dealOldPrice;
      delete product.dealOrder;
      delete product.dealPrice;
      delete product.dealDiscount;
      delete product.dealStockStatus;
    }
    return product;
  }

  async function saveForm(event) {
    event.preventDefault();
    if (saving) return;
    const form = $("#product-form");
    if (!form.reportValidity()) return;
    const imageFile = $("#product-file").files?.[0] || null;
    const isNewProduct = !$("#product-id").value;
    if (isNewProduct && !imageFile) {
      setImagePathStatus("Choose a product image before saving.", true);
      showToast("Choose a product image before saving.");
      return;
    }
    const product = collectFormProduct();
    const saveButton = $("#save-product-button");
    saving = true;
    saveButton.disabled = true;
    saveButton.textContent = imageFile ? "Uploading image…" : "Saving product…";
    setImagePathStatus(imageFile ? "Uploading image and saving product data…" : "Saving product data…");
    try {
      await store.saveProduct(product, imageFile);
      products = store.getProducts();
      renderAll();
      clearPreviewObjectUrl();
      $("#product-file").value = "";
      showToast(isNewProduct ? "Product added successfully." : "Product updated successfully.");
      setView("products");
    } catch (error) {
      setImagePathStatus(error.message || "The product could not be saved. Please try again.", true);
      showToast(error.message || "The product could not be saved. Please try again.");
    } finally {
      saving = false;
      saveButton.disabled = false;
      saveButton.textContent = $("#product-id").value ? "Update product" : "Save product";
    }
  }

  function handleTableAction(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const product = products.find((item) => item.id === button.dataset.id);
    if (!product) return;
    if (button.dataset.action === "edit") openProductForm(product);
    if (button.dataset.action === "duplicate") {
      const copy = structuredClone(product);
      copy.id = `product-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      copy.name = `${product.name} (Copy)`;
      copy.createdAt = new Date().toISOString().slice(0, 10);
      openProductForm(copy);
      $("#product-id").value = "";
      $("#form-title").textContent = "Duplicate product";
      showToast("Copy opened in the product editor. Save it to add it to the catalog.");
    }
    if (button.dataset.action === "delete") {
      pendingDeleteId = product.id;
      $("#delete-dialog").showModal();
    }
  }

  function renderAllFromStoreEvent() {
    products = store.getProducts();
    renderAll();
  }

  $$('[data-view-target]').forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.viewTarget === "form") resetForm();
    else setView(button.dataset.viewTarget);
  }));
  $$('[data-open-form]').forEach((button) => button.addEventListener("click", () => resetForm()));
  $("#admin-logout").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Sign out failed. Please try again.");
      window.location.replace("/login.html");
    } catch (error) {
      button.disabled = false;
      showToast(error.message || "Sign out failed. Please try again.");
    }
  });
  $("#product-table-body").addEventListener("click", handleTableAction);
  $("#deal-overview").addEventListener("click", handleTableAction);
  $("#featured-overview").addEventListener("click", handleTableAction);
  $("#product-form").addEventListener("submit", saveForm);
  $("#form-cancel").addEventListener("click", () => {
    clearPreviewObjectUrl();
    setView("products");
  });
  $("#form-reset").addEventListener("click", () => resetForm());
  $("#add-specification").addEventListener("click", () => addSpecificationRow());
  $("#add-feature").addEventListener("click", () => addFeatureRow());
  ["#product-old-price", "#product-price", "#product-stock"].forEach((selector) => $(selector).addEventListener("input", updateCalculatedFields));
  ["#filter-search", "#filter-category", "#filter-brand", "#filter-stock", "#filter-featured", "#filter-deal", "#sort-products"].forEach((selector) => $(selector).addEventListener("input", filterProducts));
  ["#filter-category", "#filter-brand", "#filter-stock", "#filter-featured", "#filter-deal", "#sort-products"].forEach((selector) => $(selector).addEventListener("change", filterProducts));
  $("#product-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    clearPreviewObjectUrl();
    previewObjectUrl = URL.createObjectURL(file);
    setImagePreview(previewObjectUrl);
    $("#image-current-label").textContent = `Selected: ${file.name}. The server will rename and save this image.`;
    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    const allowedTypes = new Set([".jpg", ".jpeg", ".png", ".webp"]);
    if (!allowedTypes.has(extension)) {
      setImagePathStatus("Please upload a JPG, JPEG, PNG, or WEBP image.", true);
    } else if (file.size > 5 * 1024 * 1024) {
      setImagePathStatus("Image must be 5 MB or smaller.", true);
    } else {
      setImagePathStatus("");
    }
  });
  $("#delete-cancel").addEventListener("click", () => {
    pendingDeleteId = null;
    $("#delete-dialog").close();
  });
  $("#delete-confirm").addEventListener("click", async () => {
    if (!pendingDeleteId) return;
    const button = $("#delete-confirm");
    button.disabled = true;
    try {
      await store.deleteProduct(pendingDeleteId);
      pendingDeleteId = null;
      $("#delete-dialog").close();
      products = store.getProducts();
      renderAll();
      showToast("Product deleted.");
    } catch (error) {
      showToast(error.message || "The product could not be deleted.");
    } finally {
      button.disabled = false;
    }
  });

  $("#export-products").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(products, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `smart-mart-products-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Product backup downloaded.");
  });
  $("#import-products").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (!Array.isArray(imported) || imported.some((product) => !product || !product.id || !product.name || !categories[product.category])) {
        throw new Error("Expected a product array with IDs, names, and valid categories.");
      }
      const ids = new Set();
      for (const product of imported) {
        if (ids.has(String(product.id))) throw new Error(`Duplicate product ID: ${product.id}`);
        ids.add(String(product.id));
      }
      if (!window.confirm(`Replace the current catalog with ${imported.length} imported products?`)) return;
      await store.replaceProducts(imported);
      products = store.getProducts();
      renderAll();
      showToast("Product catalog imported.");
    } catch (error) {
      window.alert(`Import failed: ${error.message}`);
    } finally {
      event.target.value = "";
    }
  });
  $("#reset-products").addEventListener("click", async () => {
    if (!window.confirm("Reset the server product database to the original catalog? Current server data will be replaced.")) return;
    try {
      await store.replaceProducts(store.getDefaultProducts());
      products = store.getProducts();
      renderAll();
      showToast("Original product data restored.");
    } catch (error) {
      showToast(error.message || "Product data could not be restored.");
    }
  });

  window.addEventListener("smartmart:products-changed", renderAllFromStoreEvent);
  store.ready.then(() => {
    products = store.getProducts();
    renderAll();
  }).catch((error) => showToast(error.message || "Could not connect to the product server."));
  addSpecificationRow();
  addFeatureRow();
})();
