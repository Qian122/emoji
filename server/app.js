const express = require('express');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { stringify } = require('csv-stringify/sync');
const swaggerUi = require('swagger-ui-express');
const openapi = require('./openapi');
const { openDatabase, audit, nowIso, EMOJI_TYPES } = require('./db');

const roleValues = ['STUDENT', 'TEACHER', 'ADMIN'];
const usernamePattern = /^[a-zA-Z0-9_\u4e00-\u9fa5-]{3,30}$/;

function createApp(options = {}) {
  const config = {
    dbPath: options.dbPath || process.env.DB_PATH || path.join(process.cwd(), 'data', 'emoji-checker.db'),
    seed: options.seed ?? process.env.SEED_DEMO_DATA !== 'false',
    jwtSecret: options.jwtSecret || process.env.JWT_SECRET || 'development-only-secret-change-me',
    jwtExpiresIn: options.jwtExpiresIn || process.env.JWT_EXPIRES_IN || '8h',
    aiToken: options.aiToken || process.env.AI_SERVICE_TOKEN || 'development-ai-token',
    adminRegistrationCode: options.adminRegistrationCode || process.env.ADMIN_REGISTRATION_CODE || 'change-me'
  };

  const db = openDatabase(config.dbPath, { seed: config.seed });
  const app = express();
  app.locals.db = db;
  app.locals.config = config;

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(morgan(process.env.NODE_ENV === 'test' ? 'tiny' : 'dev'));
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false }));

  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
  const fail = (res, status, code, message, details) => res.status(status).json({ success: false, error: { code, message, details } });

  function signUser(user) {
    return jwt.sign({ sub: user.id, role: user.role, username: user.username }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
  }

  function authenticate(req, res, next) {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    if (!token) return fail(res, 401, 'AUTH_REQUIRED', '请先登录。');
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      const user = db.prepare('SELECT id, username, role, email, status, created_at FROM users WHERE id = ?').get(payload.sub);
      if (!user || user.status !== 'ACTIVE') return fail(res, 401, 'ACCOUNT_UNAVAILABLE', '账号不存在或已被停用。');
      req.user = user;
      next();
    } catch {
      return fail(res, 401, 'INVALID_TOKEN', '登录状态已失效，请重新登录。');
    }
  }

  const allowRoles = (...roles) => (req, res, next) => roles.includes(req.user.role)
    ? next()
    : fail(res, 403, 'FORBIDDEN', '当前角色无权执行此操作。');

  function canAccessSession(user, sessionId) {
    if (user.role === 'ADMIN') return Boolean(db.prepare('SELECT id FROM class_sessions WHERE id = ?').get(sessionId));
    if (user.role === 'TEACHER') {
      return Boolean(db.prepare(`
        SELECT s.id FROM class_sessions s JOIN courses c ON c.id = s.course_id
        WHERE s.id = ? AND c.teacher_id = ?
      `).get(sessionId, user.id));
    }
    return Boolean(db.prepare('SELECT id FROM schedule_users WHERE session_id = ? AND user_id = ?').get(sessionId, user.id));
  }

  function sessionListFor(user) {
    const base = `
      SELECT s.id, s.course_id AS courseId, c.name AS courseName, s.starts_at AS startsAt,
             s.ends_at AS endsAt, s.classroom, s.class_name AS className,
             c.teacher_id AS teacherId, t.username AS teacherName
      FROM class_sessions s
      JOIN courses c ON c.id = s.course_id
      JOIN users t ON t.id = c.teacher_id
    `;
    if (user.role === 'ADMIN') return db.prepare(`${base} ORDER BY s.starts_at DESC`).all();
    if (user.role === 'TEACHER') return db.prepare(`${base} WHERE c.teacher_id = ? ORDER BY s.starts_at DESC`).all(user.id);
    return db.prepare(`${base} JOIN schedule_users su ON su.session_id = s.id WHERE su.user_id = ? ORDER BY s.starts_at DESC`).all(user.id);
  }

  function parseId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  function parseAnalyticsFilters(query) {
    const courseId = query.course ? parseId(query.course) : null;
    if (query.course && !courseId) return { error: '课程编号无效。' };
    const className = typeof query.class === 'string' && query.class.trim() ? query.class.trim() : null;
    const parseDate = (value) => {
      if (!value) return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    };
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    if (query.from && !from) return { error: '开始时间无效。' };
    if (query.to && !to) return { error: '结束时间无效。' };
    if (from && to && new Date(from) > new Date(to)) return { error: '开始时间不能晚于结束时间。' };
    return { courseId, className, from, to };
  }

  function queryStats({ sessionId, courseId, className, from, to, user }) {
    const where = [];
    const params = [];
    if (sessionId) { where.push('r.session_id = ?'); params.push(sessionId); }
    if (courseId) { where.push('c.id = ?'); params.push(courseId); }
    if (className) { where.push('s.class_name = ?'); params.push(className); }
    if (from) { where.push('r.recorded_at >= ?'); params.push(from); }
    if (to) { where.push('r.recorded_at <= ?'); params.push(to); }
    if (user.role === 'TEACHER') { where.push('c.teacher_id = ?'); params.push(user.id); }
    if (user.role === 'STUDENT') { where.push('r.user_id = ?'); params.push(user.id); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const counts = db.prepare(`
      SELECT r.emoji_type AS emojiType, COUNT(*) AS count,
             ROUND(AVG(CASE WHEN r.source = 'AI' THEN r.confidence END), 3) AS averageConfidence
      FROM emoji_records r
      JOIN class_sessions s ON s.id = r.session_id
      JOIN courses c ON c.id = s.course_id
      ${clause}
      GROUP BY r.emoji_type ORDER BY count DESC
    `).all(...params);
    const total = counts.reduce((sum, row) => sum + row.count, 0);
    return {
      total,
      counts: EMOJI_TYPES.map((type) => {
        const row = counts.find((item) => item.emojiType === type);
        return { emojiType: type, count: row?.count || 0, percentage: total ? Number((((row?.count || 0) / total) * 100).toFixed(1)) : 0, averageConfidence: row?.averageConfidence ?? null };
      })
    };
  }

  const registerSchema = z.object({
    username: z.string().regex(usernamePattern, '用户名为 3-30 位中英文、数字、下划线或连字符。'),
    email: z.string().email('邮箱格式不正确。'),
    password: z.string().min(8).regex(/[A-Z]/, '密码须包含大写字母。').regex(/[a-z]/, '密码须包含小写字母。').regex(/\d/, '密码须包含数字。'),
    role: z.enum(roleValues).default('STUDENT'),
    adminCode: z.string().optional()
  });

  app.post('/api/auth/register', asyncRoute(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', '注册信息不完整或格式不正确。', parsed.error.flatten());
    const { username, email, password, role, adminCode } = parsed.data;
    if (role === 'ADMIN' && adminCode !== config.adminRegistrationCode) return fail(res, 403, 'ADMIN_CODE_INVALID', '管理员注册码无效。');
    const exists = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
    if (exists) return fail(res, 409, 'USER_EXISTS', '用户名或邮箱已被使用。');
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare(`INSERT INTO users (username, password_hash, role, email, status, created_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?)`)
      .run(username, hash, role, email, nowIso());
    const user = db.prepare('SELECT id, username, role, email, status, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    audit(db, { userId: user.id, action: 'REGISTER', details: { role }, ipAddress: req.ip });
    return ok(res, { user, token: signUser(user) }, 201);
  }));

  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    const parsed = z.object({ username: z.string().min(1), password: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', '请输入用户名和密码。');
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(parsed.data.username);
    if (!row || !(await bcrypt.compare(parsed.data.password, row.password_hash))) return fail(res, 401, 'LOGIN_FAILED', '用户名或密码错误。');
    if (row.status !== 'ACTIVE') return fail(res, 403, 'ACCOUNT_DISABLED', '账号已停用。');
    const user = { id: row.id, username: row.username, role: row.role, email: row.email, status: row.status, created_at: row.created_at };
    audit(db, { userId: user.id, action: 'LOGIN', ipAddress: req.ip });
    return ok(res, { user, token: signUser(user) });
  }));

  app.put('/api/auth/password', authenticate, asyncRoute(async (req, res) => {
    const parsed = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).regex(/[A-Z]/).regex(/[a-z]/).regex(/\d/) }).safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', '新密码至少 8 位，并包含大小写字母和数字。');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!(await bcrypt.compare(parsed.data.currentPassword, row.password_hash))) return fail(res, 400, 'CURRENT_PASSWORD_INVALID', '当前密码不正确。');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(parsed.data.newPassword, 12), req.user.id);
    audit(db, { userId: req.user.id, action: 'PASSWORD_CHANGED', ipAddress: req.ip });
    return ok(res, { message: '密码已修改，请妥善保管新密码。' });
  }));

  app.get('/api/users/me', authenticate, (req, res) => ok(res, req.user));

  app.get('/api/sessions', authenticate, (req, res) => ok(res, sessionListFor(req.user)));

  app.post('/api/emoji', authenticate, allowRoles('STUDENT'), (req, res) => {
    const parsed = z.object({ sessionId: z.number().int().positive(), emojiType: z.enum(EMOJI_TYPES), deviceId: z.string().max(100).optional() }).safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', '课堂、表情类型或设备标识无效。', parsed.error.flatten());
    if (!canAccessSession(req.user, parsed.data.sessionId)) return fail(res, 403, 'SESSION_FORBIDDEN', '你未被安排到该课堂。');
    const result = db.prepare(`
      INSERT INTO emoji_records (user_id, session_id, emoji_type, recorded_at, source, confidence, device_id)
      VALUES (?, ?, ?, ?, 'MANUAL', NULL, ?)
    `).run(req.user.id, parsed.data.sessionId, parsed.data.emojiType, nowIso(), parsed.data.deviceId || 'web-client');
    const record = db.prepare('SELECT * FROM emoji_records WHERE id = ?').get(result.lastInsertRowid);
    app.locals.io?.to(`session:${parsed.data.sessionId}`).emit('emoji:new', { sessionId: parsed.data.sessionId, emojiType: parsed.data.emojiType, source: 'MANUAL', recordedAt: record.recorded_at });
    return ok(res, record, 201);
  });

  app.get('/api/emoji/history', authenticate, (req, res) => {
    const sessionId = req.query.sessionId ? parseId(req.query.sessionId) : null;
    if (req.query.sessionId && !sessionId) return fail(res, 400, 'INVALID_SESSION', '课堂编号无效。');
    if (sessionId && !canAccessSession(req.user, sessionId)) return fail(res, 403, 'SESSION_FORBIDDEN', '无权查看该课堂。');
    const limit = Math.min(parseId(req.query.limit) || 100, 500);
    const where = [];
    const params = [];
    if (req.user.role === 'STUDENT') { where.push('r.user_id = ?'); params.push(req.user.id); }
    if (req.user.role === 'TEACHER') { where.push('c.teacher_id = ?'); params.push(req.user.id); }
    if (sessionId) { where.push('r.session_id = ?'); params.push(sessionId); }
    const rows = db.prepare(`
      SELECT r.id, r.user_id AS userId, u.username, r.session_id AS sessionId, c.name AS courseName,
             s.class_name AS className, r.emoji_type AS emojiType, r.recorded_at AS recordedAt,
             r.source, r.confidence, r.device_id AS deviceId
      FROM emoji_records r
      LEFT JOIN users u ON u.id = r.user_id
      JOIN class_sessions s ON s.id = r.session_id
      JOIN courses c ON c.id = s.course_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.recorded_at DESC LIMIT ?
    `).all(...params, limit);
    return ok(res, rows);
  });

  app.get('/api/emoji/statistics', authenticate, (req, res) => {
    const sessionId = req.query.sessionId ? parseId(req.query.sessionId) : null;
    if (sessionId && !canAccessSession(req.user, sessionId)) return fail(res, 403, 'SESSION_FORBIDDEN', '无权查看该课堂统计。');
    return ok(res, queryStats({ sessionId, user: req.user }));
  });

  app.get('/api/admin/users', authenticate, allowRoles('ADMIN'), (req, res) => {
    const users = db.prepare('SELECT id, username, role, email, status, created_at AS createdAt FROM users ORDER BY created_at DESC').all();
    return ok(res, users);
  });

  app.patch('/api/admin/users/:id/status', authenticate, allowRoles('ADMIN'), (req, res) => {
    const id = parseId(req.params.id);
    const parsed = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }).safeParse(req.body);
    if (!id || !parsed.success) return fail(res, 400, 'VALIDATION_ERROR', '用户编号或状态无效。');
    if (id === req.user.id && parsed.data.status === 'DISABLED') return fail(res, 400, 'SELF_DISABLE_BLOCKED', '不能停用当前登录账号。');
    const result = db.prepare('UPDATE users SET status = ? WHERE id = ?').run(parsed.data.status, id);
    if (!result.changes) return fail(res, 404, 'USER_NOT_FOUND', '用户不存在。');
    audit(db, { userId: req.user.id, action: 'USER_STATUS_CHANGED', details: { targetUserId: id, status: parsed.data.status }, ipAddress: req.ip });
    return ok(res, { id, status: parsed.data.status });
  });

  app.get('/api/admin/courses', authenticate, allowRoles('ADMIN'), (req, res) => {
    const rows = db.prepare(`SELECT c.id, c.name, c.teacher_id AS teacherId, u.username AS teacherName FROM courses c JOIN users u ON u.id = c.teacher_id ORDER BY c.name`).all();
    return ok(res, rows);
  });

  app.post('/api/admin/courses', authenticate, allowRoles('ADMIN'), (req, res) => {
    const parsed = z.object({ name: z.string().min(2).max(100), teacherId: z.number().int().positive() }).safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', '课程名称或教师无效。');
    const teacher = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'TEACHER' AND status = 'ACTIVE'").get(parsed.data.teacherId);
    if (!teacher) return fail(res, 400, 'TEACHER_INVALID', '请选择有效教师。');
    const result = db.prepare('INSERT INTO courses (name, teacher_id, created_at) VALUES (?, ?, ?)').run(parsed.data.name, parsed.data.teacherId, nowIso());
    audit(db, { userId: req.user.id, action: 'COURSE_CREATED', details: { courseId: Number(result.lastInsertRowid) }, ipAddress: req.ip });
    return ok(res, { id: Number(result.lastInsertRowid), ...parsed.data }, 201);
  });

  app.post('/api/admin/sessions', authenticate, allowRoles('ADMIN'), (req, res) => {
    const parsed = z.object({
      courseId: z.number().int().positive(), startsAt: z.string().datetime(), endsAt: z.string().datetime(),
      classroom: z.string().min(1).max(100), className: z.string().min(1).max(100)
    }).refine((data) => new Date(data.endsAt) > new Date(data.startsAt), { message: '结束时间必须晚于开始时间。' }).safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', '课堂信息无效。', parsed.error.flatten());
    if (!db.prepare('SELECT id FROM courses WHERE id = ?').get(parsed.data.courseId)) return fail(res, 404, 'COURSE_NOT_FOUND', '课程不存在。');
    const result = db.prepare(`
      INSERT INTO class_sessions (course_id, starts_at, ends_at, classroom, class_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(parsed.data.courseId, parsed.data.startsAt, parsed.data.endsAt, parsed.data.classroom, parsed.data.className, nowIso());
    audit(db, { userId: req.user.id, action: 'SESSION_CREATED', details: { sessionId: Number(result.lastInsertRowid) }, ipAddress: req.ip });
    return ok(res, { id: Number(result.lastInsertRowid), ...parsed.data }, 201);
  });

  app.get('/api/admin/sessions/:id/schedule', authenticate, allowRoles('ADMIN'), (req, res) => {
    const sessionId = parseId(req.params.id);
    if (!sessionId) return fail(res, 400, 'INVALID_SESSION', '课堂编号无效。');
    if (!db.prepare('SELECT id FROM class_sessions WHERE id = ?').get(sessionId)) return fail(res, 404, 'SESSION_NOT_FOUND', '课堂不存在。');
    const users = db.prepare(`
      SELECT u.id, u.username, u.email
      FROM schedule_users su JOIN users u ON u.id = su.user_id
      WHERE su.session_id = ? ORDER BY u.username
    `).all(sessionId);
    return ok(res, users);
  });

  app.post('/api/admin/sessions/:id/schedule', authenticate, allowRoles('ADMIN'), (req, res) => {
    const sessionId = parseId(req.params.id);
    const parsed = z.object({ userIds: z.array(z.number().int().positive()).max(500) }).safeParse(req.body);
    if (!sessionId || !parsed.success) return fail(res, 400, 'VALIDATION_ERROR', '课堂编号或用户列表无效。');
    if (!db.prepare('SELECT id FROM class_sessions WHERE id = ?').get(sessionId)) return fail(res, 404, 'SESSION_NOT_FOUND', '课堂不存在。');
    const userIds = [...new Set(parsed.data.userIds)];
    if (userIds.length) {
      const placeholders = userIds.map(() => '?').join(',');
      const valid = db.prepare(`SELECT id FROM users WHERE role = 'STUDENT' AND status = 'ACTIVE' AND id IN (${placeholders})`).all(...userIds);
      if (valid.length !== userIds.length) return fail(res, 400, 'STUDENT_INVALID', '安排列表中包含不存在、已停用或非学生账号。');
    }
    const insert = db.prepare('INSERT OR IGNORE INTO schedule_users (session_id, user_id, scheduled_at) VALUES (?, ?, ?)');
    const replaceSchedule = () => {
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM schedule_users WHERE session_id = ?').run(sessionId);
        for (const userId of userIds) insert.run(sessionId, userId, nowIso());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    };
    replaceSchedule();
    audit(db, { userId: req.user.id, action: 'SESSION_USERS_SCHEDULED', details: { sessionId, userIds }, ipAddress: req.ip });
    return ok(res, { sessionId, scheduledCount: userIds.length });
  });

  app.get('/api/admin/dashboard/realtime', authenticate, allowRoles('TEACHER', 'ADMIN'), (req, res) => {
    const sessionId = parseId(req.query.sessionId);
    if (!sessionId) return fail(res, 400, 'INVALID_SESSION', '请指定课堂编号。');
    if (!canAccessSession(req.user, sessionId)) return fail(res, 403, 'SESSION_FORBIDDEN', '无权查看该课堂。');
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const stats = queryStats({ sessionId, from: since, user: req.user });
    const trend = db.prepare(`
      SELECT substr(recorded_at, 1, 16) AS minute, emoji_type AS emojiType, COUNT(*) AS count
      FROM emoji_records WHERE session_id = ? AND recorded_at >= ?
      GROUP BY minute, emoji_type ORDER BY minute
    `).all(sessionId, since);
    const latest = db.prepare(`SELECT emoji_type AS emojiType, source, confidence, recorded_at AS recordedAt FROM emoji_records WHERE session_id = ? ORDER BY recorded_at DESC LIMIT 20`).all(sessionId);
    return ok(res, { sessionId, windowMinutes: 15, stats, trend, latest, generatedAt: nowIso() });
  });

  app.get('/api/admin/statistics', authenticate, allowRoles('TEACHER', 'ADMIN'), (req, res) => {
    const filters = parseAnalyticsFilters(req.query);
    if (filters.error) return fail(res, 400, 'INVALID_FILTER', filters.error);
    const stats = queryStats({ ...filters, user: req.user });
    const joinConditions = ['r.session_id = s.id'];
    const joinParams = [];
    if (filters.from) { joinConditions.push('r.recorded_at >= ?'); joinParams.push(filters.from); }
    if (filters.to) { joinConditions.push('r.recorded_at <= ?'); joinParams.push(filters.to); }
    const where = [];
    const whereParams = [];
    if (filters.courseId) { where.push('c.id = ?'); whereParams.push(filters.courseId); }
    if (filters.className) { where.push('s.class_name = ?'); whereParams.push(filters.className); }
    if (req.user.role === 'TEACHER') { where.push('c.teacher_id = ?'); whereParams.push(req.user.id); }
    const bySession = db.prepare(`
      SELECT s.id AS sessionId, c.name AS courseName, s.class_name AS className, s.starts_at AS startsAt,
             COUNT(r.id) AS total
      FROM class_sessions s JOIN courses c ON c.id = s.course_id
      LEFT JOIN emoji_records r ON ${joinConditions.join(' AND ')}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY s.id ORDER BY s.starts_at DESC LIMIT 100
    `).all(...joinParams, ...whereParams);
    const recordWhere = [];
    const recordParams = [];
    if (filters.courseId) { recordWhere.push('c.id = ?'); recordParams.push(filters.courseId); }
    if (filters.className) { recordWhere.push('s.class_name = ?'); recordParams.push(filters.className); }
    if (filters.from) { recordWhere.push('r.recorded_at >= ?'); recordParams.push(filters.from); }
    if (filters.to) { recordWhere.push('r.recorded_at <= ?'); recordParams.push(filters.to); }
    if (req.user.role === 'TEACHER') { recordWhere.push('c.teacher_id = ?'); recordParams.push(req.user.id); }
    const trend = db.prepare(`
      SELECT substr(r.recorded_at, 1, 16) AS bucket, r.emoji_type AS emojiType, COUNT(*) AS count
      FROM emoji_records r
      JOIN class_sessions s ON s.id = r.session_id JOIN courses c ON c.id = s.course_id
      ${recordWhere.length ? `WHERE ${recordWhere.join(' AND ')}` : ''}
      GROUP BY bucket, r.emoji_type ORDER BY bucket DESC LIMIT 1000
    `).all(...recordParams).reverse();
    const optionWhere = req.user.role === 'TEACHER' ? 'WHERE c.teacher_id = ?' : '';
    const optionParams = req.user.role === 'TEACHER' ? [req.user.id] : [];
    const courses = db.prepare(`
      SELECT DISTINCT c.id, c.name FROM courses c
      JOIN class_sessions s ON s.course_id = c.id ${optionWhere}
      ORDER BY c.name
    `).all(...optionParams);
    const classes = db.prepare(`
      SELECT DISTINCT s.class_name AS className FROM class_sessions s
      JOIN courses c ON c.id = s.course_id ${optionWhere}
      ORDER BY s.class_name
    `).all(...optionParams).map((row) => row.className);
    return ok(res, { ...stats, bySession, trend, filters, options: { courses, classes } });
  });

  app.get('/api/admin/emoji/export', authenticate, allowRoles('ADMIN'), (req, res) => {
    const filters = parseAnalyticsFilters(req.query);
    if (filters.error) return fail(res, 400, 'INVALID_FILTER', filters.error);
    const where = [];
    const params = [];
    if (filters.courseId) { where.push('c.id = ?'); params.push(filters.courseId); }
    if (filters.className) { where.push('s.class_name = ?'); params.push(filters.className); }
    if (filters.from) { where.push('r.recorded_at >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('r.recorded_at <= ?'); params.push(filters.to); }
    const rows = db.prepare(`
      SELECT r.id, COALESCE(u.username, '匿名') AS username, c.name AS course, s.class_name AS className,
             r.emoji_type AS emojiType, r.recorded_at AS recordedAt, r.source, r.confidence, r.device_id AS deviceId
      FROM emoji_records r LEFT JOIN users u ON u.id = r.user_id
      JOIN class_sessions s ON s.id = r.session_id JOIN courses c ON c.id = s.course_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.recorded_at DESC
    `).all(...params).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, sanitizeCsvCell(value)])));
    const csv = '\uFEFF' + stringify(rows, { header: true });
    audit(db, { userId: req.user.id, action: 'EMOJI_CSV_EXPORTED', details: { count: rows.length, filters }, ipAddress: req.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="emoji-records-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csv);
  });

  app.post('/api/ai/emoji-results', (req, res) => {
    if (req.headers['x-ai-token'] !== config.aiToken) return fail(res, 401, 'AI_TOKEN_INVALID', 'AI 服务令牌无效。');
    const parsed = z.object({
      sessionId: z.number().int().positive(), emojiType: z.enum(EMOJI_TYPES), confidence: z.number().min(0).max(1),
      recordedAt: z.string().datetime().optional(), deviceId: z.string().max(100).optional(), anonymous: z.boolean().default(true), userId: z.number().int().positive().optional()
    }).safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'AI 推理结果格式无效。', parsed.error.flatten());
    if (!db.prepare('SELECT id FROM class_sessions WHERE id = ?').get(parsed.data.sessionId)) return fail(res, 404, 'SESSION_NOT_FOUND', '课堂不存在。');
    const threshold = Number(req.headers['x-confidence-threshold'] || 0);
    if (parsed.data.confidence < threshold) return ok(res, { accepted: false, reason: 'LOW_CONFIDENCE', threshold });
    const userId = parsed.data.anonymous ? null : (parsed.data.userId || null);
    const result = db.prepare(`
      INSERT INTO emoji_records (user_id, session_id, emoji_type, recorded_at, source, confidence, device_id)
      VALUES (?, ?, ?, ?, 'AI', ?, ?)
    `).run(userId, parsed.data.sessionId, parsed.data.emojiType, parsed.data.recordedAt || nowIso(), parsed.data.confidence, parsed.data.deviceId || 'ai-camera');
    app.locals.io?.to(`session:${parsed.data.sessionId}`).emit('emoji:new', { sessionId: parsed.data.sessionId, emojiType: parsed.data.emojiType, source: 'AI', confidence: parsed.data.confidence, recordedAt: parsed.data.recordedAt || nowIso() });
    return ok(res, { accepted: true, id: Number(result.lastInsertRowid) }, 201);
  });

  app.get('/api/health', (req, res) => ok(res, { status: 'UP', timestamp: nowIso() }));
  app.get('/api/openapi.json', (req, res) => res.json(openapi));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'Emoji Checker API' }));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('*', (req, res, next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  app.use((req, res) => fail(res, 404, 'NOT_FOUND', '请求的资源不存在。'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error(error);
    return fail(res, 500, 'INTERNAL_ERROR', '服务器处理请求时发生错误。');
  });

  return app;
}

function sanitizeCsvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

module.exports = { createApp, sanitizeCsvCell };
