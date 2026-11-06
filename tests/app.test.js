process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: createSocketClient } = require('socket.io-client');
const { createApp, sanitizeCsvCell } = require('../server/app');
const { attachRealtime } = require('../server/realtime');

async function fixture() {
  const app = createApp({ dbPath: ':memory:', seed: true, jwtSecret: 'test-secret', aiToken: 'test-ai-token', adminRegistrationCode: 'test-admin-code' });
  const server = http.createServer(app);
  const io = attachRealtime(server, app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options = {}) => {
    const headers = { ...options.headers };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${url}`, { ...options, headers });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    return { response, body };
  };
  const login = async (username, password) => {
    const { response, body } = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200);
    return body.data.token;
  };
  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const close = async () => {
    await new Promise((resolve) => io.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    app.locals.db.close();
  };
  return { request, login, auth, close, app, base };
}

test('学生可以登录、提交情绪并查询个人历史', async () => {
  const ctx = await fixture();
  try {
    const token = await ctx.login('student', 'Student123!');
    const { body: sessions } = await ctx.request('/api/sessions', { headers: ctx.auth(token) });
    const sessionId = sessions.data[0].id;
    const { response: created, body } = await ctx.request('/api/emoji', {
      method: 'POST', headers: ctx.auth(token), body: JSON.stringify({ sessionId, emojiType: 'HAPPY', deviceId: 'test' })
    });
    assert.equal(created.status, 201);
    assert.equal(body.data.emoji_type, 'HAPPY');
    const { body: history } = await ctx.request('/api/emoji/history', { headers: ctx.auth(token) });
    assert.ok(history.data.some((row) => row.emojiType === 'HAPPY'));
    assert.ok(history.data.every((row) => row.userId === 3));
  } finally { await ctx.close(); }
});

test('注册校验弱密码，用户可以修改密码后重新登录', async () => {
  const ctx = await fixture();
  try {
    const weak = await ctx.request('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ username: 'weakuser', email: 'weak@example.edu', password: '12345678', role: 'STUDENT' })
    });
    assert.equal(weak.response.status, 400);
    const token = await ctx.login('student', 'Student123!');
    const changed = await ctx.request('/api/auth/password', {
      method: 'PUT', headers: ctx.auth(token), body: JSON.stringify({ currentPassword: 'Student123!', newPassword: 'Changed123!' })
    });
    assert.equal(changed.response.status, 200);
    await ctx.login('student', 'Changed123!');
  } finally { await ctx.close(); }
});

test('管理员注册必须使用正确的独立注册码', async () => {
  const ctx = await fixture();
  try {
    const denied = await ctx.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: 'admin2', email: 'admin2@example.edu', password: 'Admin234!', role: 'ADMIN', adminCode: 'wrong-code'
      })
    });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.error.code, 'ADMIN_CODE_INVALID');

    const created = await ctx.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: 'admin2', email: 'admin2@example.edu', password: 'Admin234!', role: 'ADMIN', adminCode: 'test-admin-code'
      })
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.data.user.role, 'ADMIN');
    await ctx.login('admin2', 'Admin234!');
  } finally { await ctx.close(); }
});

test('认证和 RBAC 阻止未登录与学生访问管理员接口', async () => {
  const ctx = await fixture();
  try {
    const anonymous = await ctx.request('/api/sessions');
    assert.equal(anonymous.response.status, 401);
    const token = await ctx.login('student', 'Student123!');
    const denied = await ctx.request('/api/admin/users', { headers: ctx.auth(token) });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.error.code, 'FORBIDDEN');
  } finally { await ctx.close(); }
});

test('管理员可以创建课程课堂并完整替换排课名单', async () => {
  const ctx = await fixture();
  try {
    const token = await ctx.login('admin', 'Admin123!');
    const users = (await ctx.request('/api/admin/users', { headers: ctx.auth(token) })).body.data;
    const teacher = users.find((user) => user.role === 'TEACHER');
    const student = users.find((user) => user.role === 'STUDENT');
    const course = await ctx.request('/api/admin/courses', {
      method: 'POST', headers: ctx.auth(token), body: JSON.stringify({ name: '自动化测试课程', teacherId: teacher.id })
    });
    assert.equal(course.response.status, 201);
    const session = await ctx.request('/api/admin/sessions', {
      method: 'POST', headers: ctx.auth(token), body: JSON.stringify({
        courseId: course.body.data.id, startsAt: '2026-11-05T08:00:00.000Z', endsAt: '2026-11-05T10:00:00.000Z', classroom: '测试楼 101', className: '测试班'
      })
    });
    assert.equal(session.response.status, 201);
    const invalid = await ctx.request(`/api/admin/sessions/${session.body.data.id}/schedule`, {
      method: 'POST', headers: ctx.auth(token), body: JSON.stringify({ userIds: [teacher.id] })
    });
    assert.equal(invalid.response.status, 400);
    const saved = await ctx.request(`/api/admin/sessions/${session.body.data.id}/schedule`, {
      method: 'POST', headers: ctx.auth(token), body: JSON.stringify({ userIds: [student.id] })
    });
    assert.equal(saved.body.data.scheduledCount, 1);
    const assigned = await ctx.request(`/api/admin/sessions/${session.body.data.id}/schedule`, { headers: ctx.auth(token) });
    assert.deepEqual(assigned.body.data.map((user) => user.id), [student.id]);
    const studentToken = await ctx.login('student', 'Student123!');
    const studentSessions = await ctx.request('/api/sessions', { headers: ctx.auth(studentToken) });
    assert.ok(studentSessions.body.data.some((row) => row.id === session.body.data.id));
    const cleared = await ctx.request(`/api/admin/sessions/${session.body.data.id}/schedule`, {
      method: 'POST', headers: ctx.auth(token), body: JSON.stringify({ userIds: [] })
    });
    assert.equal(cleared.body.data.scheduledCount, 0);
  } finally { await ctx.close(); }
});

test('教师不能查看其他教师的课堂数据', async () => {
  const ctx = await fixture();
  try {
    const secondTeacher = await ctx.request('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ username: 'teacher2', email: 'teacher2@example.edu', password: 'Teacher234!', role: 'TEACHER' })
    });
    const adminToken = await ctx.login('admin', 'Admin123!');
    const course = await ctx.request('/api/admin/courses', {
      method: 'POST', headers: ctx.auth(adminToken), body: JSON.stringify({ name: '其他教师课程', teacherId: secondTeacher.body.data.user.id })
    });
    const session = await ctx.request('/api/admin/sessions', {
      method: 'POST', headers: ctx.auth(adminToken), body: JSON.stringify({
        courseId: course.body.data.id, startsAt: '2026-11-05T08:00:00.000Z', endsAt: '2026-11-05T10:00:00.000Z', classroom: '测试楼 202', className: '隔离测试班'
      })
    });
    const teacherToken = await ctx.login('teacher', 'Teacher123!');
    const denied = await ctx.request(`/api/admin/dashboard/realtime?sessionId=${session.body.data.id}`, { headers: ctx.auth(teacherToken) });
    assert.equal(denied.response.status, 403);
    const stats = await ctx.request('/api/admin/statistics', { headers: ctx.auth(teacherToken) });
    assert.ok(stats.body.data.options.courses.every((item) => item.id !== course.body.data.id));
  } finally { await ctx.close(); }
});

test('教师历史包含学生信息且只返回本人所授课堂记录', async () => {
  const ctx = await fixture();
  try {
    const secondTeacher = await ctx.request('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ username: 'teacher3', email: 'teacher3@example.edu', password: 'Teacher345!', role: 'TEACHER' })
    });
    const adminToken = await ctx.login('admin', 'Admin123!');
    const users = (await ctx.request('/api/admin/users', { headers: ctx.auth(adminToken) })).body.data;
    const student = users.find((user) => user.username === 'student');
    const course = await ctx.request('/api/admin/courses', {
      method: 'POST', headers: ctx.auth(adminToken), body: JSON.stringify({ name: '教师历史隔离课程', teacherId: secondTeacher.body.data.user.id })
    });
    const session = await ctx.request('/api/admin/sessions', {
      method: 'POST', headers: ctx.auth(adminToken), body: JSON.stringify({
        courseId: course.body.data.id, startsAt: '2026-11-05T08:00:00.000Z', endsAt: '2026-11-05T10:00:00.000Z', classroom: '测试楼 303', className: '历史隔离班'
      })
    });
    await ctx.request(`/api/admin/sessions/${session.body.data.id}/schedule`, {
      method: 'POST', headers: ctx.auth(adminToken), body: JSON.stringify({ userIds: [student.id] })
    });
    const studentToken = await ctx.login('student', 'Student123!');
    await ctx.request('/api/emoji', {
      method: 'POST', headers: ctx.auth(studentToken), body: JSON.stringify({ sessionId: session.body.data.id, emojiType: 'SAD', deviceId: 'teacher-history-test' })
    });

    const firstTeacherToken = await ctx.login('teacher', 'Teacher123!');
    const firstHistory = await ctx.request('/api/emoji/history', { headers: ctx.auth(firstTeacherToken) });
    assert.ok(firstHistory.body.data.length > 0);
    assert.ok(firstHistory.body.data.every((row) => row.sessionId !== session.body.data.id));
    assert.ok(firstHistory.body.data.some((row) => row.username === 'student'));

    const secondTeacherToken = await ctx.login('teacher3', 'Teacher345!');
    const secondHistory = await ctx.request('/api/emoji/history', { headers: ctx.auth(secondTeacherToken) });
    assert.ok(secondHistory.body.data.some((row) => row.sessionId === session.body.data.id && row.username === 'student' && row.emojiType === 'SAD'));
    assert.ok(secondHistory.body.data.every((row) => row.sessionId === session.body.data.id));
  } finally { await ctx.close(); }
});

test('多维统计支持课程班级时间过滤并返回趋势', async () => {
  const ctx = await fixture();
  try {
    const token = await ctx.login('admin', 'Admin123!');
    const result = await ctx.request(`/api/admin/statistics?course=1&class=${encodeURIComponent('软件工程 1 班')}`, { headers: ctx.auth(token) });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.total, 6);
    assert.ok(result.body.data.trend.length > 0);
    assert.ok(result.body.data.options.courses.some((course) => course.id === 1));
    const invalid = await ctx.request('/api/admin/statistics?from=2026-12-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z', { headers: ctx.auth(token) });
    assert.equal(invalid.response.status, 400);
  } finally { await ctx.close(); }
});

test('学生提交后教师通过 Socket.IO 收到实时事件', async () => {
  const ctx = await fixture();
  let socket;
  try {
    const teacherToken = await ctx.login('teacher', 'Teacher123!');
    const studentToken = await ctx.login('student', 'Student123!');
    const sessions = await ctx.request('/api/sessions', { headers: ctx.auth(teacherToken) });
    const sessionId = sessions.body.data[0].id;
    socket = createSocketClient(ctx.base, { auth: { token: teacherToken }, transports: ['websocket'] });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    socket.emit('dashboard:join', sessionId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const event = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('未收到实时事件')), 1500);
      socket.once('emoji:new', (payload) => { clearTimeout(timer); resolve(payload); });
    });
    await ctx.request('/api/emoji', {
      method: 'POST', headers: ctx.auth(studentToken), body: JSON.stringify({ sessionId, emojiType: 'SURPRISED', deviceId: 'socket-test' })
    });
    const payload = await event;
    assert.equal(payload.sessionId, sessionId);
    assert.equal(payload.emojiType, 'SURPRISED');
  } finally {
    socket?.disconnect();
    await ctx.close();
  }
});

test('AI 接口校验令牌、阈值并写入匿名记录', async () => {
  const ctx = await fixture();
  try {
    const adminToken = await ctx.login('admin', 'Admin123!');
    const sessions = await ctx.request('/api/sessions', { headers: ctx.auth(adminToken) });
    const payload = JSON.stringify({ sessionId: sessions.body.data[0].id, emojiType: 'CALM', confidence: 0.61, anonymous: true });
    const denied = await ctx.request('/api/ai/emoji-results', { method: 'POST', body: payload, headers: { 'X-AI-Token': 'wrong' } });
    assert.equal(denied.response.status, 401);
    const filtered = await ctx.request('/api/ai/emoji-results', { method: 'POST', body: payload, headers: { 'X-AI-Token': 'test-ai-token', 'X-Confidence-Threshold': '0.65' } });
    assert.equal(filtered.body.data.accepted, false);
    const accepted = await ctx.request('/api/ai/emoji-results', { method: 'POST', body: payload, headers: { 'X-AI-Token': 'test-ai-token', 'X-Confidence-Threshold': '0.60' } });
    assert.equal(accepted.response.status, 201);
    const history = await ctx.request('/api/emoji/history', { headers: ctx.auth(adminToken) });
    const record = history.body.data.find((row) => row.source === 'AI');
    assert.equal(record.userId, null);
    assert.equal(record.confidence, 0.61);
  } finally { await ctx.close(); }
});

test('CSV 导出遵循筛选条件并防止公式注入', async () => {
  const ctx = await fixture();
  try {
    const token = await ctx.login('admin', 'Admin123!');
    await ctx.request('/api/ai/emoji-results', {
      method: 'POST', headers: { 'X-AI-Token': 'test-ai-token' },
      body: JSON.stringify({ sessionId: 1, emojiType: 'ANGRY', confidence: 0.9, anonymous: true, deviceId: '=2+2' })
    });
    const exported = await ctx.request(`/api/admin/emoji/export?course=1&class=${encodeURIComponent('软件工程 1 班')}`, { headers: ctx.auth(token) });
    assert.equal(exported.response.status, 200);
    assert.match(exported.response.headers.get('content-type'), /text\/csv/);
    assert.ok(exported.body.includes("'=2+2"));
    assert.ok(exported.body.includes('软件工程实践'));
  } finally { await ctx.close(); }
});

test('停用账号后已有令牌立即失效', async () => {
  const ctx = await fixture();
  try {
    const studentToken = await ctx.login('student', 'Student123!');
    const adminToken = await ctx.login('admin', 'Admin123!');
    const users = (await ctx.request('/api/admin/users', { headers: ctx.auth(adminToken) })).body.data;
    const student = users.find((user) => user.username === 'student');
    const disabled = await ctx.request(`/api/admin/users/${student.id}/status`, {
      method: 'PATCH', headers: ctx.auth(adminToken), body: JSON.stringify({ status: 'DISABLED' })
    });
    assert.equal(disabled.response.status, 200);
    const denied = await ctx.request('/api/users/me', { headers: ctx.auth(studentToken) });
    assert.equal(denied.response.status, 401);
  } finally { await ctx.close(); }
});

test('OpenAPI 文档覆盖新增管理接口', async () => {
  const ctx = await fixture();
  try {
    const result = await ctx.request('/api/openapi.json');
    assert.equal(result.body.openapi, '3.0.3');
    assert.ok(result.body.paths['/admin/sessions/{id}/schedule'].get);
    assert.ok(result.body.paths['/admin/users/{id}/status'].patch);
    assert.ok(result.body.paths['/admin/courses'].post);
  } finally { await ctx.close(); }
});

test('CSV 单元格工具处理所有危险前缀', () => {
  assert.equal(sanitizeCsvCell('=HYPERLINK("bad")'), "'=HYPERLINK(\"bad\")");
  assert.equal(sanitizeCsvCell('+1+1'), "'+1+1");
  assert.equal(sanitizeCsvCell('-1+1'), "'-1+1");
  assert.equal(sanitizeCsvCell('@SUM(A1:A2)'), "'@SUM(A1:A2)");
  assert.equal(sanitizeCsvCell('normal'), 'normal');
});
