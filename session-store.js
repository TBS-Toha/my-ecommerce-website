const session = require("express-session");

const DEFAULT_MAX_AGE = 12 * 60 * 60 * 1000;

class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.database = database;
    this.readSession = database.prepare("SELECT data, expires_at FROM sessions WHERE sid = ?");
    this.writeSession = database.prepare("INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at");
    this.deleteSession = database.prepare("DELETE FROM sessions WHERE sid = ?");
    this.deleteExpired = database.prepare("DELETE FROM sessions WHERE expires_at <= ?");
  }

  get(sid, callback) {
    try {
      const row = this.readSession.get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now()) {
        this.deleteSession.run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.data));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, value, callback) {
    try {
      const expiresAt = value.cookie?.expires
        ? new Date(value.cookie.expires).getTime()
        : Date.now() + (Number(value.cookie?.maxAge) || DEFAULT_MAX_AGE);
      this.writeSession.run(sid, JSON.stringify(value), Number.isFinite(expiresAt) ? expiresAt : Date.now() + DEFAULT_MAX_AGE);
      callback?.(null);
    } catch (error) {
      callback?.(error);
    }
  }

  touch(sid, value, callback) {
    this.set(sid, value, callback);
  }

  destroy(sid, callback) {
    try {
      this.deleteSession.run(sid);
      callback?.(null);
    } catch (error) {
      callback?.(error);
    }
  }

  clearExpired() {
    this.deleteExpired.run(Date.now());
  }
}

module.exports = SQLiteSessionStore;
