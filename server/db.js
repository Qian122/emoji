const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const EMOJI_TYPES = ['HAPPY', 'CALM', 'CONFUSED', 'SAD', 'ANGRY', 'SURPRISED'];

function nowIso() {
  return new Date().toISOString();
}

function openDatabase(dbPath, { seed = true } = {}) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  if (seed) seedDemoData(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('STUDENT', 'TEACHER', 'ADMIN')),
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      teacher_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (teacher_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS class_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      classroom TEXT NOT NULL,
      class_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schedule_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      scheduled_at TEXT NOT NULL,
      UNIQUE (session_id, user_id),
      FOREIGN KEY (session_id) REFERENCES class_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS emoji_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      session_id INTEGER NOT NULL,
      emoji_type TEXT NOT NULL CHECK (emoji_type IN ('HAPPY', 'CALM', 'CONFUSED', 'SAD', 'ANGRY', 'SURPRISED')),
      recorded_at TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('MANUAL', 'AI')),
      confidence REAL,
      device_id TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (session_id) REFERENCES class_sessions(id) ON DELETE CASCADE,
      CHECK ((source = 'AI' AND confidence IS NOT NULL) OR source = 'MANUAL')
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_emoji_session_time ON emoji_records(session_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_emoji_user_time ON emoji_records(user_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_course_time ON class_sessions(course_id, starts_at);
  `);
}

function seedDemoData(db) {
  const row = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (row.count > 0) return;

  const insertUser = db.prepare(`
    INSERT INTO users (username, password_hash, role, email, status, created_at)
    VALUES (?, ?, ?, ?, 'ACTIVE', ?)
  `);
  const createdAt = nowIso();
  const adminId = Number(insertUser.run('admin', bcrypt.hashSync('Admin123!', 12), 'ADMIN', 'admin@example.edu', createdAt).lastInsertRowid);
  const teacherId = Number(insertUser.run('teacher', bcrypt.hashSync('Teacher123!', 12), 'TEACHER', 'teacher@example.edu', createdAt).lastInsertRowid);
  const studentId = Number(insertUser.run('student', bcrypt.hashSync('Student123!', 12), 'STUDENT', 'student@example.edu', createdAt).lastInsertRowid);

  const courseId = Number(db.prepare('INSERT INTO courses (name, teacher_id, created_at) VALUES (?, ?, ?)')
    .run('软件工程实践', teacherId, createdAt).lastInsertRowid);

  const start = new Date();
  start.setMinutes(start.getMinutes() - 30);
  const end = new Date(start);
  end.setHours(end.getHours() + 2);
  const sessionId = Number(db.prepare(`
    INSERT INTO class_sessions (course_id, starts_at, ends_at, classroom, class_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(courseId, start.toISOString(), end.toISOString(), '实验楼 301', '软件工程 1 班', createdAt).lastInsertRowid);

  db.prepare('INSERT INTO schedule_users (session_id, user_id, scheduled_at) VALUES (?, ?, ?)')
    .run(sessionId, studentId, createdAt);

  const samples = [
    ['HAPPY', -24], ['CALM', -20], ['CONFUSED', -16], ['HAPPY', -12], ['SURPRISED', -8], ['CALM', -4]
  ];
  const insertEmoji = db.prepare(`
    INSERT INTO emoji_records (user_id, session_id, emoji_type, recorded_at, source, confidence, device_id)
    VALUES (?, ?, ?, ?, 'MANUAL', NULL, 'demo-browser')
  `);
  for (const [type, minutes] of samples) {
    const time = new Date();
    time.setMinutes(time.getMinutes() + minutes);
    insertEmoji.run(studentId, sessionId, type, time.toISOString());
  }

  db.prepare(`INSERT INTO audit_logs (user_id, action, details, ip_address, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(adminId, 'DEMO_DATA_SEEDED', JSON.stringify({ courseId, sessionId }), '127.0.0.1', createdAt);
}

function audit(db, { userId = null, action, details = null, ipAddress = null }) {
  db.prepare(`
    INSERT INTO audit_logs (user_id, action, details, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, action, details ? JSON.stringify(details) : null, ipAddress, nowIso());
}

module.exports = { openDatabase, audit, nowIso, EMOJI_TYPES };
