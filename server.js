const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const session = require("express-session");
const helmet = require("helmet");
const SQLiteSessionStore = require("./session-store");
const { registerAuthRoutes, requireAdmin, requireUser } = require("./auth-routes");
const { registerCustomerRoutes } = require("./customer-routes");
const { registerAdminRoutes } = require("./admin-routes");

const ROOT = __dirname;
const IMAGE_DIR = path.join(ROOT, "images");
const DATA_DIR = path.join(ROOT, ".data");
const DATABASE_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(DATA_DIR, "catalog.sqlite");
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"]
]);
const PUBLIC_FILES = ["admin-commerce.js", "admin.css", "admin.js", "account.js", "app.js", "auth.css", "auth.js", "cart.js", "checkout.js", "commerce.css", "commerce.js", "customer.css", "order-details.js", "products.js", "style.css", "wishlist.js"];

fs.mkdirSync(IMAGE_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });

const seedWindow = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "products.js"), "utf8"), { window: seedWindow }, { timeout: 1000 });
const defaultProducts = seedWindow.SMART_MART_DEFAULT_PRODUCTS;
if (!Array.isArray(defaultProducts)) throw new Error("The default product catalog could not be loaded.");

const database = new DatabaseSync(DATABASE_PATH);
database.exec("PRAGMA journal_mode = WAL");
database.exec("PRAGMA foreign_keys = ON");
database.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    image_path TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS managed_images (
    image_path TEXT PRIMARY KEY
  );
`);

database.exec(fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8"));
const categoryColumns = new Set(database.prepare("PRAGMA table_info(categories)").all().map((column) => column.name));
if (!categoryColumns.has("image_path")) database.exec("ALTER TABLE categories ADD COLUMN image_path TEXT NOT NULL DEFAULT ''");
const catalogSeeded = database.prepare("SELECT value FROM settings WHERE key = 'catalog_seeded'").get();
if (!catalogSeeded) {
  const productCount = database.prepare("SELECT COUNT(*) AS count FROM products").get().count;
  if (productCount === 0) {
    const insert = database.prepare("INSERT INTO products (id, data, image_path) VALUES (?, ?, ?)");
    database.exec("BEGIN");
    try {
      for (const product of defaultProducts) {
        const normalized = { ...product, image: normalizeStoredImagePath(product.image) };
        insert.run(String(normalized.id), JSON.stringify(normalized), normalized.image);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  database.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('catalog_seeded','1',?)").run(new Date().toISOString());
}

const createdAt = new Date().toISOString();
const categoryNames = new Map([
  ["watch", "Watches"],
  ["smartphone", "Smartphones"],
  ["sound-box", "Sound Box"],
  ["headphone", "Headphones"]
]);
const seedCategory = database.prepare("INSERT OR IGNORE INTO categories (id, name, created_at) VALUES (?, ?, ?)");
for (const [id, name] of categoryNames) seedCategory.run(id, name, createdAt);

const inventoryRows = database.prepare("SELECT id, data, image_path FROM products").all();
const seedInventory = database.prepare("INSERT OR IGNORE INTO inventory (product_id, quantity, updated_at) VALUES (?, ?, ?)");
const seedProductImage = database.prepare("INSERT OR IGNORE INTO product_images (id, product_id, image_path, is_primary, created_at) VALUES (?, ?, ?, ?, ?)");
for (const row of inventoryRows) {
  const product = JSON.parse(row.data);
  seedInventory.run(row.id, product.stockQuantity ?? null, createdAt);
  seedProductImage.run(crypto.randomUUID(), row.id, row.image_path, 1, createdAt);
  if (product.featuredImage) {
    const featuredImage = normalizeStoredImagePath(product.featuredImage);
    if (featuredImage !== row.image_path) seedProductImage.run(crypto.randomUUID(), row.id, featuredImage, 0, createdAt);
  }
}
database.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('delivery_fee', '120', ?)").run(createdAt);

const configuredAdminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const configuredAdminPassword = String(process.env.ADMIN_PASSWORD || "");
if (configuredAdminEmail || configuredAdminPassword) {
  if (!configuredAdminEmail || configuredAdminPassword.length < 10) {
    throw new Error("Set both ADMIN_EMAIL and an ADMIN_PASSWORD of at least 10 characters.");
  }
  const existingAdminUser = database.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(configuredAdminEmail);
  let adminUserId = existingAdminUser?.id;
  if (!adminUserId) {
    const now = new Date().toISOString();
    adminUserId = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = `scrypt$${salt}$${crypto.scryptSync(configuredAdminPassword, salt, 64).toString("hex")}`;
    database.prepare("INSERT INTO users (id, full_name, email, phone, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(adminUserId, "Store Administrator", configuredAdminEmail, "0000000000", passwordHash, now, now);
  }
  database.prepare("INSERT OR IGNORE INTO admins (user_id, created_at) VALUES (?, ?)").run(adminUserId, new Date().toISOString());
}

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE, files: 1 },
  fileFilter(_request, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();
    if (IMAGE_TYPES.get(extension) !== file.mimetype.toLowerCase()) {
      callback(new ApiError(400, "Please upload a JPG, JPEG, PNG, or WEBP image."));
      return;
    }
    callback(null, true);
  }
});

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeStoredImagePath(value) {
  const imagePath = String(value ?? "").trim();
  if (!imagePath) return "/images/category-02.jpg";
  if (/^(?:[a-z]+:|[a-z]:[\\/])/i.test(imagePath) || imagePath.includes("\\")) {
    throw new ApiError(400, "Product images must use a web path such as /images/watch.jpg.");
  }
  const match = imagePath.match(/^\/?images\/([^/]+)$/);
  if (!match || match[1] === "." || match[1] === "..") {
    throw new ApiError(400, "Product images must use a web path such as /images/watch.jpg.");
  }
  return `/images/${match[1]}`;
}

function productFromRow(row) {
  const product = { ...JSON.parse(row.data), image: row.image_path };
  product.imageAvailable = fs.existsSync(path.join(IMAGE_DIR, path.basename(product.image)));
  if (product.featuredImage) {
    product.featuredImageAvailable = fs.existsSync(path.join(IMAGE_DIR, path.basename(product.featuredImage)));
  }
  return product;
}

function getProduct(id) {
  const row = database.prepare("SELECT id, data, image_path FROM products WHERE id = ?").get(id);
  return row ? productFromRow(row) : null;
}

function listProducts() {
  return database.prepare("SELECT id, data, image_path FROM products ORDER BY rowid").all().map(productFromRow);
}

function parseProductPayload(request) {
  const raw = request.body?.product;
  if (typeof raw !== "string") throw new ApiError(400, "Product information is missing.");
  let product;
  try {
    product = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "Product information is not valid JSON.");
  }
  if (!product || typeof product !== "object" || Array.isArray(product)) {
    throw new ApiError(400, "Product information is invalid.");
  }
  const name = String(product.name ?? "").trim();
  const brand = String(product.brand ?? "").trim();
  const category = String(product.category ?? "");
  const price = Number(product.price);
  const oldPrice = product.oldPrice === null || product.oldPrice === undefined || product.oldPrice === "" ? null : Number(product.oldPrice);
  const rating = product.rating === null || product.rating === undefined || product.rating === "" ? null : Number(product.rating);
  const ratingCount = product.ratingCount === null || product.ratingCount === undefined || product.ratingCount === "" ? 0 : Number(product.ratingCount);
  const stockQuantity = product.stockQuantity === null || product.stockQuantity === undefined || product.stockQuantity === "" ? null : Number(product.stockQuantity);
  if (!name) throw new ApiError(400, "Enter a product name.");
  if (!brand) throw new ApiError(400, "Enter a brand.");
  if (!database.prepare("SELECT 1 FROM categories WHERE id = ?").get(category)) throw new ApiError(400, "Choose a valid product category.");
  if (!Number.isSafeInteger(price) || price < 0) throw new ApiError(400, "Enter a whole-number product price.");
  if (oldPrice !== null && (!Number.isSafeInteger(oldPrice) || oldPrice < 0)) throw new ApiError(400, "Enter a valid whole-number old price.");
  if (rating !== null && (!Number.isFinite(rating) || rating < 0 || rating > 5)) throw new ApiError(400, "Rating must be between 0 and 5.");
  if (!Number.isSafeInteger(ratingCount) || ratingCount < 0 || ratingCount > 10000000) throw new ApiError(400, "Enter a valid rating count.");
  if (stockQuantity !== null && (!Number.isSafeInteger(stockQuantity) || stockQuantity < 0 || stockQuantity > 1000000)) throw new ApiError(400, "Stock must be a whole number of 0 or more.");
  const normalized = { ...product, name, brand, category, price, oldPrice, rating, ratingCount, stockQuantity, image: normalizeStoredImagePath(product.image) };
  if (product.featuredImage) normalized.featuredImage = normalizeStoredImagePath(product.featuredImage);
  return normalized;
}

function hasValidImageSignature(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  const bytes = file.buffer;
  if (extension === ".jpg" || extension === ".jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === ".png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === ".webp") return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}

function slugifyProductName(name) {
  const slug = String(name).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "product";
}

function allocateImagePath(name, file, existingProduct) {
  const extension = path.extname(file.originalname).toLowerCase();
  const base = slugifyProductName(name);
  const currentPath = existingProduct?.image || "";
  const managed = new Set(database.prepare("SELECT image_path FROM managed_images").all().map((row) => row.image_path));
  const referenceCount = database.prepare("SELECT COUNT(*) AS count FROM products WHERE image_path = ?");
  for (let suffix = 0; suffix < 100000; suffix += 1) {
    const fileName = `${base}${suffix ? `-${suffix}` : ""}${extension}`;
    const webPath = `/images/${fileName}`;
    const absolutePath = path.join(IMAGE_DIR, fileName);
    const references = referenceCount.get(webPath).count;
    const ownManagedFile = webPath === currentPath && managed.has(webPath) && references === 1;
    if (ownManagedFile || (references === 0 && !fs.existsSync(absolutePath))) {
      return { webPath, absolutePath, replaceOwnFile: ownManagedFile };
    }
  }
  throw new ApiError(500, "A unique image filename could not be generated.");
}

function saveProductRecord(product, imageFile, existingProduct) {
  let imagePath = existingProduct?.image || normalizeStoredImagePath(product.image);
  let allocated = null;
  let previousBytes = null;
  let wroteImage = false;
  if (imageFile) {
    if (!hasValidImageSignature(imageFile)) throw new ApiError(400, "The selected file is not a valid JPG, JPEG, PNG, or WEBP image.");
    allocated = allocateImagePath(product.name, imageFile, existingProduct);
    if (allocated.replaceOwnFile) previousBytes = fs.readFileSync(allocated.absolutePath);
    fs.writeFileSync(allocated.absolutePath, imageFile.buffer, { flag: "w" });
    wroteImage = true;
    imagePath = allocated.webPath;
  }

  const savedProduct = { ...product, image: imagePath };
    if (imageFile && savedProduct.featured) savedProduct.featuredImage = imagePath;
  const id = String(savedProduct.id || crypto.randomUUID());
  savedProduct.id = id;
  try {
    database.exec("BEGIN IMMEDIATE");
    database.prepare("INSERT INTO products (id, data, image_path) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, image_path = excluded.image_path")
      .run(id, JSON.stringify(savedProduct), imagePath);
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO inventory (product_id,quantity,updated_at) VALUES (?,?,?)
      ON CONFLICT(product_id) DO UPDATE SET quantity=excluded.quantity,updated_at=excluded.updated_at`)
      .run(id, savedProduct.stockQuantity ?? null, now);
    database.prepare("UPDATE product_images SET is_primary=0 WHERE product_id=?").run(id);
    database.prepare("INSERT OR IGNORE INTO product_images (id,product_id,image_path,is_primary,created_at) VALUES (?,?,?,?,?)")
      .run(crypto.randomUUID(), id, imagePath, 1, now);
    if (savedProduct.featuredImage && savedProduct.featuredImage !== imagePath) {
      database.prepare("INSERT OR IGNORE INTO product_images (id,product_id,image_path,is_primary,created_at) VALUES (?,?,?,?,?)")
        .run(crypto.randomUUID(), id, savedProduct.featuredImage, 0, now);
    }
    if (imageFile) database.prepare("INSERT OR IGNORE INTO managed_images (image_path) VALUES (?)").run(imagePath);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    if (wroteImage && allocated) {
      if (previousBytes) fs.writeFileSync(allocated.absolutePath, previousBytes);
      else fs.rmSync(allocated.absolutePath, { force: true });
    }
    throw error;
  }

  cleanupManagedImages();
  return getProduct(id);
}

function cleanupManagedImages() {
  const managed = database.prepare("SELECT image_path FROM managed_images").all();
  const references = database.prepare(`SELECT
    (SELECT COUNT(*) FROM products WHERE image_path = ?) +
    (SELECT COUNT(*) FROM order_items WHERE image_path = ?) +
    (SELECT COUNT(*) FROM categories WHERE image_path = ?) AS count`);
  const remove = database.prepare("DELETE FROM managed_images WHERE image_path = ?");
  for (const { image_path: imagePath } of managed) {
    if (references.get(imagePath, imagePath, imagePath).count !== 0) continue;
    const filename = path.basename(imagePath);
    fs.rmSync(path.join(IMAGE_DIR, filename), { force: true });
    remove.run(imagePath);
  }
}

function validateImportedProducts(value) {
  if (!Array.isArray(value)) throw new ApiError(400, "Expected a JSON array of products.");
  const ids = new Set();
  return value.map((product) => {
    if (!product || !product.id || !product.name || !database.prepare("SELECT 1 FROM categories WHERE id = ?").get(product.category)) {
      throw new ApiError(400, "Every product must have an ID, name, and valid category.");
    }
    const price = Number(product.price);
    const oldPrice = product.oldPrice === null || product.oldPrice === undefined || product.oldPrice === "" ? null : Number(product.oldPrice);
    const stockQuantity = product.stockQuantity === null || product.stockQuantity === undefined || product.stockQuantity === "" ? null : Number(product.stockQuantity);
    const rating = product.rating === null || product.rating === undefined || product.rating === "" ? null : Number(product.rating);
    const ratingCount = product.ratingCount === null || product.ratingCount === undefined || product.ratingCount === "" ? 0 : Number(product.ratingCount);
    if (!Number.isSafeInteger(price) || price < 0) throw new ApiError(400, `Product ${product.id} has an invalid price.`);
    if (oldPrice !== null && (!Number.isSafeInteger(oldPrice) || oldPrice < 0)) throw new ApiError(400, `Product ${product.id} has an invalid old price.`);
    if (stockQuantity !== null && (!Number.isSafeInteger(stockQuantity) || stockQuantity < 0 || stockQuantity > 1000000)) throw new ApiError(400, `Product ${product.id} has invalid stock.`);
    if (rating !== null && (!Number.isFinite(rating) || rating < 0 || rating > 5)) throw new ApiError(400, `Product ${product.id} has an invalid rating.`);
    if (!Number.isSafeInteger(ratingCount) || ratingCount < 0 || ratingCount > 10000000) throw new ApiError(400, `Product ${product.id} has an invalid rating count.`);
    const id = String(product.id);
    if (ids.has(id)) throw new ApiError(400, `Duplicate product ID: ${id}`);
    ids.add(id);
    const normalized = { ...product, id, price, oldPrice, stockQuantity, rating, ratingCount, image: normalizeStoredImagePath(product.image) };
    if (product.featuredImage) normalized.featuredImage = normalizeStoredImagePath(product.featuredImage);
    return normalized;
  });
}

function replaceProducts(nextProducts) {
  const products = validateImportedProducts(nextProducts);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM products");
    const insert = database.prepare("INSERT INTO products (id, data, image_path) VALUES (?, ?, ?)");
    const insertInventory = database.prepare("INSERT INTO inventory (product_id,quantity,updated_at) VALUES (?,?,?)");
    const insertImage = database.prepare("INSERT OR IGNORE INTO product_images (id,product_id,image_path,is_primary,created_at) VALUES (?,?,?,?,?)");
    const now = new Date().toISOString();
    for (const product of products) {
      insert.run(product.id, JSON.stringify(product), product.image);
      insertInventory.run(product.id, product.stockQuantity ?? null, now);
      insertImage.run(crypto.randomUUID(), product.id, product.image, 1, now);
      if (product.featuredImage) {
        const featuredImage = normalizeStoredImagePath(product.featuredImage);
        if (featuredImage !== product.image) insertImage.run(crypto.randomUUID(), product.id, featuredImage, 0, now);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  cleanupManagedImages();
  return listProducts();
}

app.disable("x-powered-by");
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"]
    }
  }
}));
app.use((request, response, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method) || !request.path.startsWith("/api/")) return next();
  const origin = request.get("origin");
  if (!origin) return next();
  try {
    if (new URL(origin).host !== request.get("host")) return response.status(403).json({ error: "Cross-origin requests are not allowed." });
  } catch {
    return response.status(403).json({ error: "Invalid request origin." });
  }
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use("/images", express.static(IMAGE_DIR, { fallthrough: true, index: false }));
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(48).toString("hex");
if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production.");
}
app.use(session({
  name: "tohasmart.sid",
  store: new SQLiteSessionStore(database),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 12 * 60 * 60 * 1000
  }
}));
const cleanExpiredSessions = setInterval(() => {
  try {
    database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  } catch (error) {
    console.error("Expired session cleanup failed:", error.message);
  }
}, 60 * 60 * 1000);
cleanExpiredSessions.unref();
registerAuthRoutes(app, database);
registerCustomerRoutes(app, database, requireUser);
const adminOnly = requireAdmin(database);
registerAdminRoutes(app, database, adminOnly, requireUser, cleanupManagedImages);
app.put("/api/admin/categories/:id/image", adminOnly, upload.single("image"), (request, response) => {
  if (!database.prepare("SELECT 1 FROM categories WHERE id=?").get(request.params.id)) throw new ApiError(404, "Category not found.");
  if (!request.file) throw new ApiError(400, "Choose a category image to upload.");
  if (!hasValidImageSignature(request.file)) throw new ApiError(400, "The selected file is not a valid JPG, JPEG, PNG, or WEBP image.");

  const fileName = `category-${crypto.randomUUID()}${path.extname(request.file.originalname).toLowerCase()}`;
  const imagePath = `/images/${fileName}`;
  const absolutePath = path.join(IMAGE_DIR, fileName);
  let wroteImage = false;
  try {
    fs.writeFileSync(absolutePath, request.file.buffer, { flag: "wx" });
    wroteImage = true;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("UPDATE categories SET image_path=? WHERE id=?").run(imagePath, request.params.id);
      database.prepare("INSERT OR IGNORE INTO managed_images (image_path) VALUES (?)").run(imagePath);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (wroteImage) fs.rmSync(absolutePath, { force: true });
    throw error;
  }
  cleanupManagedImages();
  response.json({ id: request.params.id, image: imagePath });
});
app.use((request, response, next) => {
  const rawPath = String(request.originalUrl || request.url || "");
  if (/\/index\.html?$/i.test(rawPath)) return response.sendFile(path.join(ROOT, "index.html"));
  next();
});
app.get("/", (_request, response) => response.sendFile(path.join(ROOT, "index.html")));
app.get("/index.html", (_request, response) => response.sendFile(path.join(ROOT, "index.html")));
app.get("/login.html", (_request, response) => response.sendFile(path.join(ROOT, "login.html")));
app.get("/register.html", (_request, response) => response.sendFile(path.join(ROOT, "register.html")));
for (const page of ["account.html", "cart.html", "checkout.html", "order-details.html", "order-success.html", "wishlist.html"]) {
  app.get(`/${page}`, (_request, response) => response.sendFile(path.join(ROOT, page)));
}
app.get("/admin.html", (request, response) => {
  const userId = request.session?.userId;
  const isAdmin = userId && database.prepare("SELECT 1 FROM admins WHERE user_id = ?").get(userId);
  if (!isAdmin) return response.redirect("/login.html?next=%2Fadmin.html");
  response.sendFile(path.join(ROOT, "admin.html"));
});
for (const fileName of PUBLIC_FILES) {
  app.get(`/${fileName}`, (_request, response) => response.sendFile(path.join(ROOT, fileName)));
}

app.get("/api/health", (_request, response) => response.json({ ok: true }));
app.get("/api/products", (_request, response) => response.json(listProducts()));
app.get("/api/products/:id", (request, response) => {
  const product = getProduct(request.params.id);
  if (!product) throw new ApiError(404, "Product not found.");
  response.json(product);
});

app.post("/api/products", adminOnly, upload.single("image"), (request, response) => {
  const product = parseProductPayload(request);
  if (!request.file) throw new ApiError(400, "Choose a product image before saving.");
  product.id = String(product.id || crypto.randomUUID());
  if (getProduct(product.id)) throw new ApiError(409, "A product with this ID already exists.");
  response.status(201).json(saveProductRecord(product, request.file, null));
});

app.put("/api/products/:id", adminOnly, upload.single("image"), (request, response) => {
  const existingProduct = getProduct(request.params.id);
  if (!existingProduct) throw new ApiError(404, "Product not found.");
  const product = parseProductPayload(request);
  product.id = existingProduct.id;
  response.json(saveProductRecord(product, request.file, existingProduct));
});

app.delete("/api/products/:id", adminOnly, (request, response) => {
  const existingProduct = getProduct(request.params.id);
  if (!existingProduct) throw new ApiError(404, "Product not found.");
  database.prepare("DELETE FROM products WHERE id = ?").run(existingProduct.id);
  cleanupManagedImages();
  response.json({ deleted: true, id: existingProduct.id });
});

app.put("/api/products", adminOnly, (request, response) => {
  response.json(replaceProducts(request.body));
});

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") return response.status(413).json({ error: "Image must be 5 MB or smaller." });
    if (error.code === "LIMIT_UNEXPECTED_FILE" || error.code === "LIMIT_FILE_COUNT") {
      return response.status(400).json({ error: "Upload one product image at a time." });
    }
    return response.status(400).json({ error: "The image upload could not be processed." });
  }
  const status = Number(error.status) || 500;
  if (status >= 500) console.error("API request failed:", error);
  response.status(status).json({ error: status >= 500 ? "The server could not save this product. Please try again." : error.message });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
const server = app.listen(port, host, () => console.log(`TOHA'S MART is running at http://localhost:${port}`));

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);