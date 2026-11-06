const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

function attachRealtime(server, app) {
  const io = new Server(server, { cors: { origin: true, credentials: true } });
  app.locals.io = io;

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = jwt.verify(token, app.locals.config.jwtSecret);
      const user = app.locals.db.prepare('SELECT id, role, status FROM users WHERE id = ?').get(payload.sub);
      if (!user || user.status !== 'ACTIVE') return next(new Error('unauthorized'));
      socket.data.user = user;
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('dashboard:join', (sessionId) => {
      const id = Number(sessionId);
      if (!Number.isInteger(id) || id <= 0) return;
      const user = socket.data.user;
      let allowed = false;
      if (user.role === 'ADMIN') {
        allowed = Boolean(app.locals.db.prepare('SELECT id FROM class_sessions WHERE id = ?').get(id));
      } else if (user.role === 'TEACHER') {
        allowed = Boolean(app.locals.db.prepare(`
          SELECT s.id FROM class_sessions s JOIN courses c ON c.id = s.course_id
          WHERE s.id = ? AND c.teacher_id = ?
        `).get(id, user.id));
      }
      if (allowed) socket.join(`session:${id}`);
    });
    socket.on('dashboard:leave', (sessionId) => socket.leave(`session:${Number(sessionId)}`));
  });

  return io;
}

module.exports = { attachRealtime };
