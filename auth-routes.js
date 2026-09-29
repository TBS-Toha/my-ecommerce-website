const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${key.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  const [algorithm, salt, expectedHex] = String(storedHash || "").split("$");
  if (algorithm !== "scrypt" || !/^[a-f0-9]{32}$/i.test(salt || "") || !/^[a-f0-9]{128}$/i.test(expectedHex || "")) return false;
  const actual = await scrypt(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return crypto.timingSafeEqual(actual, expected);
}

function sessionOperation(request, operation) {
  return new Promise((resolve, reject) => {
    request.session[operation]((error) => error ? reject(error) : resolve());
  });
}

function publicUser(row) {
  return { id: row.id, name: row.full_name, email: row.email, phone: row.phone, isAdmin: Boolean(row.is_admin), createdAt: row.created_at };
}

function registerAuthRoutes(app, database) {
  app.post("/api/auth/register", async (request, response) => {
    const body = request.body || {};
    const fullName = String(body.fullName || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const password = String(body.password || "");
    const confirmPassword = String(body.confirmPassword || "");
    if (!fullName) return response.status(400).json({ error: "Enter your full name." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ error: "Enter a valid email address." });
    if (!/^\+?[0-9\s().-]*[0-9][0-9\s().-]*$/.test(phone)) return response.status(400).json({ error: "Enter a valid phone number." });
    if (password.length < 10 || password.length > 128) return response.status(400).json({ error: "Password must be between 10 and 128 characters." });
    if (password !== confirmPassword) return response.status(400).json({ error: "Passwords do not match." });

    const now = new Date().toISOString();
    const user = { id: crypto.randomUUID(), fullName, email, phone, passwordHash: await hashPassword(password), createdAt: now };
    try {
      database.prepare("INSERT INTO users (id, full_name, email, phone, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(user.id, user.fullName, user.email, user.phone, user.passwordHash, now, now);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed: users.email")) return response.status(409).json({ error: "Email already registered." });
      throw error;
    }

    await sessionOperation(request, "regenerate");
    request.session.userId = user.id;
    await sessionOperation(request, "save");
    response.status(201).json({ user: { id: user.id, name: user.fullName, email: user.email, phone: user.phone, isAdmin: false, createdAt: now } });
  });

  app.post("/api/auth/login", async (request, response) => {
    const email = String(request.body?.email || "").trim().toLowerCase();
    const password = String(request.body?.password || "");
    if (!email || !password) return response.status(400).json({ error: "Enter your email and password." });
    const row = database.prepare("SELECT u.id, u.full_name, u.email, u.phone, u.password_hash, u.created_at, EXISTS (SELECT 1 FROM admins a WHERE a.user_id = u.id) AS is_admin FROM users u WHERE u.email = ? COLLATE NOCASE")
      .get(email);
    if (!row || !(await verifyPassword(password, row.password_hash))) return response.status(401).json({ error: "Incorrect email or password." });

    await sessionOperation(request, "regenerate");
    request.session.userId = row.id;
    await sessionOperation(request, "save");
    response.json({ user: publicUser(row) });
  });

  app.post("/api/auth/logout", async (request, response) => {
    if (request.session) await sessionOperation(request, "destroy");
    response.clearCookie("tohasmart.sid");
    response.json({ loggedOut: true });
  });

  app.get("/api/auth/me", (request, response) => {
    const userId = request.session?.userId;
    if (!userId) return response.json({ user: null });
    const row = database.prepare("SELECT u.id, u.full_name, u.email, u.phone, u.created_at, EXISTS (SELECT 1 FROM admins a WHERE a.user_id = u.id) AS is_admin FROM users u WHERE u.id = ?")
      .get(userId);
    if (!row) return response.json({ user: null });
    response.json({ user: publicUser(row) });
  });
}

function requireUser(database) {
  return (request, response, next) => {
    const userId = request.session?.userId;
    if (!userId) return response.status(401).json({ error: "Please log in to continue." });
    const row = database.prepare("SELECT id, full_name, email, phone, created_at FROM users WHERE id = ?").get(userId);
    if (!row) return response.status(401).json({ error: "Please log in to continue." });
    request.authUser = { id: row.id, name: row.full_name, email: row.email, phone: row.phone, createdAt: row.created_at };
    next();
  };
}

function requireAdmin(database) {
  const requireCustomer = requireUser(database);
  return (request, response, next) => requireCustomer(request, response, (error) => {
    if (error) return next(error);
    const admin = database.prepare("SELECT 1 FROM admins WHERE user_id = ?").get(request.authUser.id);
    if (!admin) return response.status(403).json({ error: "Administrator access is required." });
    request.authUser.isAdmin = true;
    next();
  });
}

module.exports = { hashPassword, verifyPassword, registerAuthRoutes, requireUser, requireAdmin };
