const state = {
  token: localStorage.getItem('emoji_token'),
  user: JSON.parse(localStorage.getItem('emoji_user') || 'null'),
  sessions: [],
  page: 'home',
  socket: null,
  activeRealtimeSession: null,
  cameraStream: null,
  cameraDetectionActive: false,
  cameraDetectionTimer: null,
  cameraBusy: false,
  cameraMetrics: { samples: 0, accepted: 0, filtered: 0 },
  statisticsFilters: { course: '', className: '', from: '', to: '' }
};

const EMOJIS = {
  HAPPY: ['😄', '开心'], CALM: ['🙂', '平静'], CONFUSED: ['😕', '困惑'],
  SAD: ['😢', '难过'], ANGRY: ['😠', '生气'], SURPRISED: ['😮', '惊讶']
};
const ROLE_NAMES = { STUDENT: '学生', TEACHER: '教师', ADMIN: '管理员' };
const NAV = {
  STUDENT: [['home', '⌂', '情绪打卡'], ['history', '◷', '我的历史'], ['profile', '○', '账号设置']],
  TEACHER: [['home', '⌂', '教学看板'], ['camera', '◉', 'AI 摄像头'], ['history', '◷', '课堂记录'], ['statistics', '▥', '统计分析'], ['profile', '○', '账号设置']],
  ADMIN: [['home', '⌂', '管理概览'], ['realtime', '◉', '实时看板'], ['camera', '▦', 'AI 摄像头'], ['users', '♙', '用户管理'], ['sessions', '▣', '课程与排课'], ['history', '◷', '情绪数据'], ['statistics', '▥', '统计与导出'], ['profile', '○', '账号设置']]
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const formatDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
const emojiLabel = (type) => EMOJIS[type] ? `${EMOJIS[type][0]} ${EMOJIS[type][1]}` : type;

async function api(url, options = {}) {
  const headers = { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(url, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok || payload?.success === false) {
    if (response.status === 401 && state.token) logout(false);
    throw new Error(payload?.error?.message || '请求失败，请稍后重试。');
  }
  return payload.data ?? payload;
}

function toast(message, type = 'success') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast show ${type === 'error' ? 'error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.className = 'toast', 2600);
}

function saveSession(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('emoji_token', state.token);
  localStorage.setItem('emoji_user', JSON.stringify(state.user));
}

function logout(showMessage = true) {
  stopCameraPreview();
  if (state.socket) state.socket.disconnect();
  localStorage.removeItem('emoji_token');
  localStorage.removeItem('emoji_user');
  state.token = null; state.user = null; state.sessions = [];
  $('#appView').classList.add('hidden');
  $('#authView').classList.remove('hidden');
  if (showMessage) toast('已安全退出。');
}

async function bootstrap() {
  bindAuth();
  if (!state.token) return;
  try {
    state.user = await api('/api/users/me');
    await enterApp();
  } catch { logout(false); }
}

function bindAuth() {
  document.querySelectorAll('[data-auth-tab]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-auth-tab]').forEach((item) => item.classList.toggle('active', item === button));
    $('#loginForm').classList.toggle('hidden', button.dataset.authTab !== 'login');
    $('#registerForm').classList.toggle('hidden', button.dataset.authTab !== 'register');
  }));
  $('#regRole').addEventListener('change', (event) => $('#adminCodeWrap').classList.toggle('hidden', event.target.value !== 'ADMIN'));
  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: $('#loginUsername').value.trim(), password: $('#loginPassword').value }) });
      saveSession(data); await enterApp(); toast(`欢迎回来，${data.user.username}。`);
    } catch (error) { toast(error.message, 'error'); }
  });
  $('#registerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const data = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({
        username: $('#regUsername').value.trim(), email: $('#regEmail').value.trim(), password: $('#regPassword').value,
        role: $('#regRole').value, adminCode: $('#regAdminCode').value || undefined
      }) });
      saveSession(data); await enterApp(); toast('账号创建成功。');
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function enterApp() {
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#userName').textContent = state.user.username;
  $('#userRole').textContent = ROLE_NAMES[state.user.role];
  $('#userAvatar').textContent = state.user.username.slice(0, 1).toUpperCase();
  $('#logoutButton').onclick = () => logout();
  $('#menuButton').onclick = () => $('.sidebar').classList.toggle('open');
  state.sessions = await api('/api/sessions');
  renderNav();
  connectRealtime();
  await navigate('home');
}

function connectRealtime() {
  if (typeof io !== 'function') return;
  state.socket = io({ auth: { token: state.token } });
  state.socket.on('emoji:new', () => {
    if (state.page === 'home' && state.user.role === 'TEACHER') renderTeacherDashboard();
    if (state.page === 'home' && state.user.role === 'ADMIN') renderAdminHome();
    if (state.page === 'realtime' && state.user.role === 'ADMIN') renderTeacherDashboard();
  });
}

function renderNav() {
  $('#mainNav').innerHTML = NAV[state.user.role].map(([id, icon, label]) => `<button class="nav-button" data-page="${id}"><span class="nav-icon">${icon}</span>${label}</button>`).join('');
  document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
}

async function navigate(page) {
  if (state.page === 'camera' && page !== 'camera') stopCameraPreview();
  if (state.activeRealtimeSession && state.socket) state.socket.emit('dashboard:leave', state.activeRealtimeSession);
  state.activeRealtimeSession = null;
  state.page = page;
  document.querySelectorAll('[data-page]').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  $('.sidebar').classList.remove('open');
  const labels = NAV[state.user.role].find(([id]) => id === page);
  $('#pageTitle').textContent = labels?.[2] || '课堂情绪';
  $('#pageEyebrow').textContent = `${state.user.role} · ${page}`.toUpperCase();
  $('#content').innerHTML = '<div class="card empty">正在加载…</div>';
  try {
    if (page === 'home') return state.user.role === 'STUDENT' ? renderStudentHome() : state.user.role === 'TEACHER' ? renderTeacherDashboard() : renderAdminHome();
    if (page === 'realtime' && state.user.role === 'ADMIN') return renderTeacherDashboard();
    if (page === 'camera' && ['TEACHER', 'ADMIN'].includes(state.user.role)) return renderAiCamera();
    if (page === 'history') return renderHistory();
    if (page === 'users') return renderUsers();
    if (page === 'sessions') return renderSessions();
    if (page === 'statistics') return renderStatistics();
    if (page === 'profile') return renderProfile();
  } catch (error) { $('#content').innerHTML = `<div class="card empty">${escapeHtml(error.message)}</div>`; }
}

function sessionOptions(selected) {
  return state.sessions.map((session) => `<option value="${session.id}" ${Number(selected) === session.id ? 'selected' : ''}>${escapeHtml(session.courseName)} · ${escapeHtml(session.className)} · ${formatDate(session.startsAt)}</option>`).join('');
}

async function renderStudentHome() {
  const current = state.sessions.find((session) => new Date(session.startsAt) <= new Date() && new Date(session.endsAt) >= new Date()) || state.sessions[0];
  const stats = current ? await api(`/api/emoji/statistics?sessionId=${current.id}`) : { total: 0, counts: [] };
  const history = await api('/api/emoji/history?limit=8');
  $('#content').innerHTML = `
    <div class="grid three">
      <div class="card stat-card" style="--accent:#5b5bd6"><small>我的反馈总数</small><strong>${stats.total}</strong></div>
      <div class="card stat-card" style="--accent:#45c8bd"><small>已安排课堂</small><strong>${state.sessions.length}</strong></div>
      <div class="card stat-card" style="--accent:#ff758f"><small>最近状态</small><strong>${history[0] ? EMOJIS[history[0].emojiType][0] : '—'}</strong></div>
    </div>
    <div class="card section-gap">
      <div class="card-head"><div><h3>现在感觉怎么样？</h3><small>选择当前课堂并点击最符合你感受的表情</small></div>
      <select id="studentSession" class="session-select">${sessionOptions(current?.id)}</select></div>
      ${state.sessions.length ? `<div class="emoji-grid">${Object.entries(EMOJIS).map(([type, [face, label]]) => `<button class="emoji-button" data-emoji="${type}"><span class="face">${face}</span><span class="label">${label}</span></button>`).join('')}</div>` : '<div class="empty">管理员尚未为你安排课堂。</div>'}
    </div>
    <div class="grid two section-gap">
      <div class="card"><h3>本课堂情绪分布</h3>${renderBars(stats)}</div>
      <div class="card"><h3>最近反馈</h3>${renderHistoryTable(history, false)}</div>
    </div>`;
  document.querySelectorAll('[data-emoji]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api('/api/emoji', { method: 'POST', body: JSON.stringify({ sessionId: Number($('#studentSession').value), emojiType: button.dataset.emoji, deviceId: navigator.userAgent.slice(0, 100) }) });
      toast(`已记录：${emojiLabel(button.dataset.emoji)}`); await renderStudentHome();
    } catch (error) { toast(error.message, 'error'); }
  }));
}

async function renderTeacherDashboard() {
  const selected = Number($('#dashboardSession')?.value) || state.sessions[0]?.id;
  if (!selected) { $('#content').innerHTML = '<div class="card empty">暂无可查看的课堂。</div>'; return; }
  state.activeRealtimeSession = selected;
  state.socket?.emit('dashboard:join', selected);
  const data = await api(`/api/admin/dashboard/realtime?sessionId=${selected}`);
  const dominant = [...data.stats.counts].sort((a, b) => b.count - a.count)[0];
  const aiCount = data.latest.filter((item) => item.source === 'AI').length;
  $('#content').innerHTML = `
    <div class="card-head"><div><h3>实时课堂情绪</h3><small>最近 ${data.windowMinutes} 分钟，收到新数据时自动刷新</small></div><select id="dashboardSession" class="session-select">${sessionOptions(selected)}</select></div>
    <div class="grid four">
      <div class="card stat-card"><small>实时样本</small><strong>${data.stats.total}</strong></div>
      <div class="card stat-card" style="--accent:#45c8bd"><small>主导情绪</small><strong>${dominant?.count ? EMOJIS[dominant.emojiType][0] : '—'}</strong></div>
      <div class="card stat-card" style="--accent:#ff758f"><small>需关注反馈</small><strong>${(data.stats.counts.find((x) => x.emojiType === 'CONFUSED')?.count || 0) + (data.stats.counts.find((x) => x.emojiType === 'SAD')?.count || 0)}</strong></div>
      <div class="card stat-card" style="--accent:#f6b94d"><small>最近 AI 样本</small><strong>${aiCount}</strong></div>
    </div>
    <div class="grid two section-gap">
      <div class="card"><h3>情绪占比</h3>${renderBars(data.stats)}</div>
      <div class="card"><h3>最新动态</h3><div class="pulse-list">${data.latest.length ? data.latest.map((item) => `<span class="pulse-item">${emojiLabel(item.emojiType)} · ${item.source}${item.confidence ? ` · ${Math.round(item.confidence * 100)}%` : ''}</span>`).join('') : '<div class="empty">等待课堂反馈…</div>'}</div></div>
    </div>
    <div class="card section-gap"><div class="card-head"><div><h3>15 分钟情绪趋势</h3><small>按分钟展示各类情绪数量</small></div><small>更新于 ${formatDate(data.generatedAt)}</small></div>${renderTrendChart(data.trend, 'minute')}</div>`;
  $('#dashboardSession').onchange = () => renderTeacherDashboard();
}

async function renderAiCamera() {
  const selected = Number($('#cameraSession')?.value) || state.sessions[0]?.id;
  const health = await api('/api/ai/health').catch(() => null);
  stopCameraPreview();
  state.cameraMetrics = { samples: 0, accepted: 0, filtered: 0 };
  $('#content').innerHTML = `
    <div class="grid two camera-layout">
      <div class="card camera-card">
        <div class="card-head"><div><h3>摄像头实时预览</h3><small>画面仅在浏览器内存中处理，不保存照片或视频</small></div><span id="cameraPermissionBadge" class="badge gray">未打开</span></div>
        <div class="camera-stage">
          <video id="cameraPreview" autoplay muted playsinline></video>
          <div id="cameraPlaceholder" class="camera-placeholder"><strong>摄像头尚未打开</strong><span>点击下方按钮并允许浏览器访问摄像头</span></div>
        </div>
        <canvas id="cameraCanvas" class="hidden"></canvas>
        <div class="camera-actions">
          <button id="startCameraPreview" class="secondary-button">打开摄像头预览</button>
          <button id="analyzeCameraFrame" class="secondary-button" disabled>检测当前画面</button>
          <button id="startCameraDetection" class="primary-button" disabled>开始连续检测</button>
          <button id="stopCameraPreview" class="danger-button" disabled>停止并释放</button>
        </div>
      </div>
      <div class="card camera-control-card">
        <div class="card-head"><div><h3>AI 检测控制</h3><small>连续检测默认每 3 秒采样一次</small></div><span class="badge ${health?.visionAvailable ? 'green' : 'gray'}">${health?.visionAvailable ? '视觉服务可用' : '视觉服务不可用'}</span></div>
        <div><label for="cameraSession">写入课堂</label><select id="cameraSession">${sessionOptions(selected)}</select></div>
        <div id="cameraStatus" class="camera-status">等待打开摄像头。</div>
        <div class="grid three camera-metrics">
          <div><small>已检测</small><strong id="cameraSamples">0</strong></div>
          <div><small>已入库</small><strong id="cameraAccepted">0</strong></div>
          <div><small>已过滤</small><strong id="cameraFiltered">0</strong></div>
        </div>
        <div id="cameraResult" class="camera-result"><div class="empty">尚无检测结果</div></div>
        <p class="helper-text camera-privacy">摄像头权限由浏览器控制；停止或离开本页时会立即关闭视频轨道。只有超过置信度阈值的情绪结果会匿名写入数据库。</p>
      </div>
    </div>`;

  $('#startCameraPreview').onclick = startCameraPreview;
  $('#analyzeCameraFrame').onclick = () => analyzeCameraFrame(false);
  $('#startCameraDetection').onclick = startContinuousCameraDetection;
  $('#stopCameraPreview').onclick = () => stopCameraPreview(true);
  if (!state.sessions.length) {
    setCameraStatus('当前账号没有可写入的课堂。', 'error');
    $('#startCameraDetection').disabled = true;
  }
}

async function startCameraPreview() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setCameraStatus('当前浏览器不支持摄像头访问，请使用最新版 Chrome、Edge 或 Firefox。', 'error');
    return;
  }
  stopCameraPreview();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
    state.cameraStream = stream;
    const video = $('#cameraPreview');
    video.srcObject = stream;
    await video.play();
    $('#cameraPlaceholder').classList.add('hidden');
    $('#cameraPermissionBadge').textContent = '预览中';
    $('#cameraPermissionBadge').className = 'badge green';
    $('#analyzeCameraFrame').disabled = false;
    $('#startCameraDetection').disabled = !state.sessions.length;
    $('#stopCameraPreview').disabled = false;
    setCameraStatus('摄像头已打开，可以检测当前画面或启动连续检测。', 'success');
  } catch (error) {
    setCameraStatus(error.name === 'NotAllowedError' ? '摄像头权限被拒绝，请在浏览器地址栏中允许访问。' : `无法打开摄像头：${error.message}`, 'error');
  }
}

function stopCameraDetection() {
  state.cameraDetectionActive = false;
  clearTimeout(state.cameraDetectionTimer);
  state.cameraDetectionTimer = null;
  const button = $('#startCameraDetection');
  if (button) { button.disabled = !state.cameraStream || !state.sessions.length; button.textContent = '开始连续检测'; }
}

function stopCameraPreview(showFeedback = false) {
  stopCameraDetection();
  state.cameraStream?.getTracks().forEach((track) => track.stop());
  state.cameraStream = null;
  state.cameraBusy = false;
  const video = $('#cameraPreview');
  if (video) video.srcObject = null;
  $('#cameraPlaceholder')?.classList.remove('hidden');
  if ($('#cameraPermissionBadge')) { $('#cameraPermissionBadge').textContent = '已关闭'; $('#cameraPermissionBadge').className = 'badge gray'; }
  if ($('#analyzeCameraFrame')) $('#analyzeCameraFrame').disabled = true;
  if ($('#startCameraDetection')) $('#startCameraDetection').disabled = true;
  if ($('#stopCameraPreview')) $('#stopCameraPreview').disabled = true;
  if (showFeedback) setCameraStatus('摄像头已关闭并释放，其他应用现在可以使用摄像头。', 'success');
}

async function startContinuousCameraDetection() {
  if (!state.cameraStream || state.cameraDetectionActive) return;
  state.cameraDetectionActive = true;
  $('#startCameraDetection').disabled = true;
  $('#startCameraDetection').textContent = '连续检测中…';
  setCameraStatus('连续检测已启动，请保持面部完整入镜。', 'success');
  await analyzeCameraFrame(true);
}

async function analyzeCameraFrame(scheduleNext) {
  if (!state.cameraStream || state.cameraBusy) return;
  const video = $('#cameraPreview');
  if (!video?.videoWidth || !video.videoHeight) {
    setCameraStatus('摄像头画面尚未就绪，请稍后重试。', 'error');
    return;
  }
  state.cameraBusy = true;
  try {
    const canvas = $('#cameraCanvas');
    let result = null;
    let attempts = 0;
    while (attempts < 3 && state.cameraStream) {
      attempts += 1;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      result = await api('/api/ai/analyze-frame', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: Number($('#cameraSession').value),
          imageBase64: canvas.toDataURL('image/jpeg', 0.9),
          deviceId: 'web-camera-preview'
        })
      });
      if (result.faces || attempts === 3) break;
      setCameraStatus(`第 ${attempts} 帧未检测到人脸，正在自动重试…`);
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    const accepted = result.accepted || [];
    const filtered = result.filtered || [];
    state.cameraMetrics.samples += attempts;
    state.cameraMetrics.accepted += accepted.length;
    state.cameraMetrics.filtered += filtered.length;
    renderCameraMetrics();
    if (!result.faces) {
      setCameraStatus('连续 3 帧均未检测到人脸，请正对镜头、靠近一些并保证光线充足。');
      $('#cameraResult').innerHTML = '<div class="empty">连续 3 帧未检测到人脸</div>';
    } else if (accepted.length) {
      const latest = accepted[0];
      setCameraStatus(`检测成功：${emojiLabel(latest.emojiType)}，置信度 ${Math.round(latest.confidence * 100)}%，已写入数据库。`, 'success');
      $('#cameraResult').innerHTML = accepted.map((item) => `<div class="camera-result-item"><span class="camera-result-emoji">${EMOJIS[item.emojiType]?.[0] || '🙂'}</span><div><strong>${escapeHtml(item.rawEmotion)} → ${escapeHtml(EMOJIS[item.emojiType]?.[1] || item.emojiType)}</strong><small>置信度 ${Math.round(item.confidence * 100)}% · 已入库</small></div></div>`).join('');
    } else {
      const latest = filtered[0];
      setCameraStatus(`检测到人脸，但置信度 ${latest ? Math.round(latest.confidence * 100) : 0}% 低于阈值 ${Math.round((result.threshold || 0.65) * 100)}%，未入库。`);
      $('#cameraResult').innerHTML = filtered.map((item) => `<div class="camera-result-item muted"><span class="camera-result-emoji">${EMOJIS[item.emojiType]?.[0] || '🙂'}</span><div><strong>${escapeHtml(item.rawEmotion)} → ${escapeHtml(EMOJIS[item.emojiType]?.[1] || item.emojiType)}</strong><small>置信度 ${Math.round(item.confidence * 100)}% · 已过滤</small></div></div>`).join('');
    }
  } catch (error) {
    setCameraStatus(error.message, 'error');
  } finally {
    state.cameraBusy = false;
    if (scheduleNext && state.cameraDetectionActive) state.cameraDetectionTimer = setTimeout(() => analyzeCameraFrame(true), 3000);
  }
}

function renderCameraMetrics() {
  if ($('#cameraSamples')) $('#cameraSamples').textContent = state.cameraMetrics.samples;
  if ($('#cameraAccepted')) $('#cameraAccepted').textContent = state.cameraMetrics.accepted;
  if ($('#cameraFiltered')) $('#cameraFiltered').textContent = state.cameraMetrics.filtered;
}

function setCameraStatus(message, type = '') {
  const node = $('#cameraStatus');
  if (!node) return;
  node.textContent = message;
  node.className = `camera-status ${type}`;
}

async function renderAdminHome() {
  const [users, stats] = await Promise.all([api('/api/admin/users'), api('/api/admin/statistics')]);
  const activeSession = state.sessions.find((session) => new Date(session.startsAt) <= new Date() && new Date(session.endsAt) >= new Date());
  $('#content').innerHTML = `
    <div class="grid four">
      <div class="card stat-card"><small>用户总数</small><strong>${users.length}</strong></div>
      <div class="card stat-card" style="--accent:#45c8bd"><small>课程课堂</small><strong>${state.sessions.length}</strong></div>
      <div class="card stat-card" style="--accent:#ff758f"><small>情绪记录</small><strong>${stats.total}</strong></div>
      <div class="card stat-card" style="--accent:#f6b94d"><small>进行中课堂</small><strong>${activeSession ? 1 : 0}</strong></div>
    </div>
    <div class="grid two section-gap">
      <div class="card"><h3>全局情绪分布</h3>${renderBars(stats)}</div>
      <div class="card"><h3>用户构成</h3>${['STUDENT','TEACHER','ADMIN'].map((role) => `<div class="profile-line"><span>${ROLE_NAMES[role]}</span><strong>${users.filter((user) => user.role === role).length} 人</strong></div>`).join('')}</div>
    </div>
    <div class="card section-gap"><div class="card-head"><h3>最近课堂</h3><button class="secondary-button" id="goSessions">管理排课</button></div>${renderSessionsTable(state.sessions.slice(0, 6))}</div>`;
  $('#goSessions').onclick = () => navigate('sessions');
}

async function renderHistory() {
  const selected = Number($('#historySession')?.value) || 0;
  const query = selected ? `?sessionId=${selected}&limit=300` : '?limit=300';
  const rows = await api(`/api/emoji/history${query}`);
  $('#content').innerHTML = `<div class="card"><div class="card-head"><div><h3>情绪记录</h3><small>共显示 ${rows.length} 条记录</small></div><select id="historySession" class="session-select"><option value="0">全部有权课堂</option>${sessionOptions(selected)}</select></div>${renderHistoryTable(rows, state.user.role !== 'STUDENT')}</div>`;
  $('#historySession').onchange = () => renderHistory();
}

async function renderUsers() {
  const users = await api('/api/admin/users');
  $('#content').innerHTML = `<div class="card"><div class="card-head"><div><h3>用户管理</h3><small>停用账号后，其令牌将无法继续访问系统</small></div><span class="badge">${users.length} 位用户</span></div><div class="table-wrap"><table><thead><tr><th>用户</th><th>邮箱</th><th>角色</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead><tbody>${users.map((user) => `<tr><td><strong>${escapeHtml(user.username)}</strong></td><td>${escapeHtml(user.email)}</td><td><span class="badge">${ROLE_NAMES[user.role]}</span></td><td><span class="badge ${user.status === 'ACTIVE' ? 'green' : 'gray'}">${user.status}</span></td><td>${formatDate(user.createdAt)}</td><td>${user.id === state.user.id ? '当前账号' : `<button class="danger-button" data-user-status="${user.id}" data-next="${user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'}">${user.status === 'ACTIVE' ? '停用' : '启用'}</button>`}</td></tr>`).join('')}</tbody></table></div></div>`;
  document.querySelectorAll('[data-user-status]').forEach((button) => button.onclick = async () => {
    try { await api(`/api/admin/users/${button.dataset.userStatus}/status`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.next }) }); toast('用户状态已更新。'); renderUsers(); } catch (error) { toast(error.message, 'error'); }
  });
}

async function renderSessions() {
  const [users, courses] = await Promise.all([api('/api/admin/users'), api('/api/admin/courses')]);
  const teachers = users.filter((user) => user.role === 'TEACHER' && user.status === 'ACTIVE');
  const students = users.filter((user) => user.role === 'STUDENT' && user.status === 'ACTIVE');
  $('#content').innerHTML = `
    <div class="grid two">
      <form id="courseForm" class="card form-stack"><h3>创建课程</h3><div><label>课程名称</label><input id="courseName" required></div><div><label>授课教师</label><select id="courseTeacher">${teachers.map((user) => `<option value="${user.id}">${escapeHtml(user.username)}</option>`).join('')}</select></div><button class="primary-button">创建课程</button></form>
      <form id="sessionForm" class="card form-stack"><h3>创建课堂会话</h3><div><label>课程</label><select id="sessionCourse">${courses.map((course) => `<option value="${course.id}">${escapeHtml(course.name)}</option>`).join('')}</select></div><div class="grid two"><div><label>开始时间</label><input id="sessionStart" type="datetime-local" required></div><div><label>结束时间</label><input id="sessionEnd" type="datetime-local" required></div></div><div class="grid two"><div><label>班级</label><input id="sessionClass" required></div><div><label>教室</label><input id="sessionRoom" required></div></div><button class="primary-button">创建课堂</button></form>
    </div>
    <div class="card section-gap"><h3>安排课堂用户</h3><p class="helper-text">选择后保存完整名单；取消全部选择并保存可清空排课。</p><form id="scheduleForm" class="toolbar"><div><label>课堂</label><select id="scheduleSession">${sessionOptions()}</select></div><div><label>学生（可多选）</label><select id="scheduleStudents" multiple size="5">${students.map((user) => `<option value="${user.id}">${escapeHtml(user.username)} · ${escapeHtml(user.email)}</option>`).join('')}</select></div><button class="primary-button">保存安排</button></form></div>
    <div class="card section-gap"><h3>课堂列表</h3>${renderSessionsTable(state.sessions)}</div>`;
  $('#courseForm').onsubmit = async (event) => { event.preventDefault(); try { await api('/api/admin/courses', { method: 'POST', body: JSON.stringify({ name: $('#courseName').value.trim(), teacherId: Number($('#courseTeacher').value) }) }); toast('课程已创建。'); renderSessions(); } catch (error) { toast(error.message, 'error'); } };
  $('#sessionForm').onsubmit = async (event) => { event.preventDefault(); try { await api('/api/admin/sessions', { method: 'POST', body: JSON.stringify({ courseId: Number($('#sessionCourse').value), startsAt: new Date($('#sessionStart').value).toISOString(), endsAt: new Date($('#sessionEnd').value).toISOString(), className: $('#sessionClass').value.trim(), classroom: $('#sessionRoom').value.trim() }) }); state.sessions = await api('/api/sessions'); toast('课堂已创建。'); renderSessions(); } catch (error) { toast(error.message, 'error'); } };
  const loadSchedule = async () => {
    const sessionId = Number($('#scheduleSession').value);
    if (!sessionId) return;
    const assigned = await api(`/api/admin/sessions/${sessionId}/schedule`);
    const selectedIds = new Set(assigned.map((user) => user.id));
    [...$('#scheduleStudents').options].forEach((option) => { option.selected = selectedIds.has(Number(option.value)); });
  };
  $('#scheduleSession').onchange = () => loadSchedule().catch((error) => toast(error.message, 'error'));
  $('#scheduleForm').onsubmit = async (event) => { event.preventDefault(); const userIds = [...$('#scheduleStudents').selectedOptions].map((item) => Number(item.value)); try { await api(`/api/admin/sessions/${$('#scheduleSession').value}/schedule`, { method: 'POST', body: JSON.stringify({ userIds }) }); toast(`排课名单已保存，共 ${userIds.length} 人。`); } catch (error) { toast(error.message, 'error'); } };
  await loadSchedule();
}

async function renderStatistics() {
  const query = buildStatisticsQuery(state.statisticsFilters);
  const stats = await api(`/api/admin/statistics${query}`);
  const courseOptions = stats.options.courses.map((course) => `<option value="${course.id}" ${String(course.id) === String(state.statisticsFilters.course) ? 'selected' : ''}>${escapeHtml(course.name)}</option>`).join('');
  const classOptions = stats.options.classes.map((className) => `<option value="${escapeHtml(className)}" ${className === state.statisticsFilters.className ? 'selected' : ''}>${escapeHtml(className)}</option>`).join('');
  $('#content').innerHTML = `
    <form id="statisticsFilter" class="card filter-grid">
      <div><label>课程</label><select id="statsCourse"><option value="">全部课程</option>${courseOptions}</select></div>
      <div><label>班级</label><select id="statsClass"><option value="">全部班级</option>${classOptions}</select></div>
      <div><label>开始时间</label><input id="statsFrom" type="datetime-local" value="${escapeHtml(state.statisticsFilters.from)}"></div>
      <div><label>结束时间</label><input id="statsTo" type="datetime-local" value="${escapeHtml(state.statisticsFilters.to)}"></div>
      <div class="filter-actions"><button class="primary-button" type="submit">应用筛选</button><button class="secondary-button" type="button" id="resetStatistics">重置</button></div>
    </form>
    <div class="grid three"><div class="card stat-card"><small>总样本量</small><strong>${stats.total}</strong></div><div class="card stat-card" style="--accent:#45c8bd"><small>覆盖课堂</small><strong>${stats.bySession.length}</strong></div><div class="card stat-card" style="--accent:#ff758f"><small>积极反馈</small><strong>${(stats.counts.find((x) => x.emojiType === 'HAPPY')?.percentage || 0)}%</strong></div></div>
    <div class="grid two section-gap"><div class="card"><h3>多维情绪统计</h3>${renderBars(stats)}</div><div class="card"><h3>课堂样本量</h3>${stats.bySession.length ? `<div class="table-wrap"><table><thead><tr><th>课程</th><th>班级</th><th>时间</th><th>样本</th></tr></thead><tbody>${stats.bySession.map((row) => `<tr><td>${escapeHtml(row.courseName)}</td><td>${escapeHtml(row.className)}</td><td>${formatDate(row.startsAt)}</td><td>${row.total}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">暂无数据</div>'}</div></div>
    <div class="card section-gap"><h3>筛选范围情绪趋势</h3>${renderTrendChart(stats.trend, 'bucket')}</div>
    ${state.user.role === 'ADMIN' ? '<div class="card section-gap"><div class="card-head"><div><h3>数据导出</h3><small>导出内容与当前筛选条件一致，并已防止 CSV 公式注入</small></div><button id="exportCsv" class="primary-button">导出筛选结果</button></div></div>' : ''}`;
  $('#statisticsFilter').onsubmit = async (event) => {
    event.preventDefault();
    state.statisticsFilters = { course: $('#statsCourse').value, className: $('#statsClass').value, from: $('#statsFrom').value, to: $('#statsTo').value };
    try { await renderStatistics(); } catch (error) { toast(error.message, 'error'); }
  };
  $('#resetStatistics').onclick = () => { state.statisticsFilters = { course: '', className: '', from: '', to: '' }; renderStatistics(); };
  if ($('#exportCsv')) $('#exportCsv').onclick = () => downloadCsv(buildStatisticsQuery(state.statisticsFilters));
}

function buildStatisticsQuery(filters) {
  const params = new URLSearchParams();
  if (filters.course) params.set('course', filters.course);
  if (filters.className) params.set('class', filters.className);
  if (filters.from) params.set('from', new Date(filters.from).toISOString());
  if (filters.to) params.set('to', new Date(filters.to).toISOString());
  const query = params.toString();
  return query ? `?${query}` : '';
}

async function downloadCsv(query = '') {
  try {
    const response = await fetch(`/api/admin/emoji/export${query}`, { headers: { Authorization: `Bearer ${state.token}` } });
    if (!response.ok) throw new Error('导出失败。');
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `emoji-records-${new Date().toISOString().slice(0,10)}.csv`; link.click(); URL.revokeObjectURL(url); toast('CSV 已导出。');
  } catch (error) { toast(error.message, 'error'); }
}

function renderProfile() {
  $('#content').innerHTML = `<div class="grid two"><div class="card"><h3>账号信息</h3><div class="profile-line"><span>用户名</span><strong>${escapeHtml(state.user.username)}</strong></div><div class="profile-line"><span>邮箱</span><strong>${escapeHtml(state.user.email)}</strong></div><div class="profile-line"><span>角色</span><strong>${ROLE_NAMES[state.user.role]}</strong></div><div class="profile-line"><span>状态</span><strong>${state.user.status}</strong></div></div><form id="passwordForm" class="card form-stack"><h3>修改密码</h3><div><label>当前密码</label><input id="currentPassword" type="password" required></div><div><label>新密码</label><input id="newPassword" type="password" minlength="8" required></div><button class="primary-button">更新密码</button></form></div>`;
  $('#passwordForm').onsubmit = async (event) => { event.preventDefault(); try { await api('/api/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword: $('#currentPassword').value, newPassword: $('#newPassword').value }) }); event.target.reset(); toast('密码已修改。'); } catch (error) { toast(error.message, 'error'); } };
}

function renderBars(stats) {
  if (!stats.total) return '<div class="empty">暂无情绪数据</div>';
  return `<div class="chart">${stats.counts.map((row) => `<div class="bar-row"><span>${emojiLabel(row.emojiType)}</span><div class="bar-track"><div class="bar-fill" style="width:${row.percentage}%"></div></div><strong>${row.percentage}%</strong></div>`).join('')}</div>`;
}

function renderTrendChart(rows, timeKey) {
  if (!rows?.length) return '<div class="empty">当前范围暂无趋势数据</div>';
  const colors = { HAPPY: '#16a085', CALM: '#5b5bd6', CONFUSED: '#f39c12', SAD: '#3498db', ANGRY: '#e74c3c', SURPRISED: '#9b59b6' };
  const allTimes = [...new Set(rows.map((row) => row[timeKey]))].sort();
  const times = allTimes.slice(-36);
  const values = new Map(rows.map((row) => [`${row[timeKey]}|${row.emojiType}`, Number(row.count)]));
  const width = 900; const height = 270; const left = 44; const right = 18; const top = 18; const bottom = 42;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const max = Math.max(1, ...times.flatMap((time) => Object.keys(EMOJIS).map((type) => values.get(`${time}|${type}`) || 0)));
  const x = (index) => left + (times.length === 1 ? plotWidth / 2 : (index / (times.length - 1)) * plotWidth);
  const y = (value) => top + plotHeight - (value / max) * plotHeight;
  const grid = [0, 0.5, 1].map((ratio) => `<g><line x1="${left}" y1="${top + plotHeight * ratio}" x2="${width - right}" y2="${top + plotHeight * ratio}" class="trend-grid-line"/><text x="${left - 8}" y="${top + plotHeight * ratio + 4}" class="trend-axis-label" text-anchor="end">${Math.round(max * (1 - ratio))}</text></g>`).join('');
  const lines = Object.keys(EMOJIS).map((type) => {
    const points = times.map((time, index) => `${x(index)},${y(values.get(`${time}|${type}`) || 0)}`).join(' ');
    return `<polyline points="${points}" fill="none" stroke="${colors[type]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  const labelIndexes = [...new Set([0, Math.floor((times.length - 1) / 2), times.length - 1])];
  const labels = labelIndexes.map((index) => `<text x="${x(index)}" y="${height - 14}" class="trend-axis-label" text-anchor="middle">${escapeHtml(formatTrendTime(times[index]))}</text>`).join('');
  const legend = Object.keys(EMOJIS).map((type) => `<span><i style="background:${colors[type]}"></i>${escapeHtml(EMOJIS[type][1])}</span>`).join('');
  return `<div class="trend-wrap"><div class="trend-legend">${legend}</div><svg class="trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="情绪时间趋势图">${grid}${lines}${labels}</svg></div>`;
}

function formatTrendTime(value) {
  const normalized = value.length === 16 ? `${value}:00Z` : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderHistoryTable(rows, showUser) {
  if (!rows.length) return '<div class="empty">暂无记录</div>';
  return `<div class="table-wrap"><table><thead><tr>${showUser ? '<th>用户</th>' : ''}<th>情绪</th><th>课程 / 班级</th><th>来源</th><th>置信度</th><th>时间</th></tr></thead><tbody>${rows.map((row) => `<tr>${showUser ? `<td>${escapeHtml(row.username || '匿名')}</td>` : ''}<td><strong>${emojiLabel(row.emojiType)}</strong></td><td>${escapeHtml(row.courseName)} / ${escapeHtml(row.className)}</td><td><span class="badge ${row.source === 'AI' ? '' : 'green'}">${row.source}</span></td><td>${row.confidence == null ? '-' : `${Math.round(row.confidence * 100)}%`}</td><td>${formatDate(row.recordedAt)}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderSessionsTable(rows) {
  if (!rows.length) return '<div class="empty">暂无课堂</div>';
  return `<div class="table-wrap"><table><thead><tr><th>课程</th><th>班级</th><th>教师</th><th>教室</th><th>开始</th><th>结束</th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${escapeHtml(row.courseName)}</strong></td><td>${escapeHtml(row.className)}</td><td>${escapeHtml(row.teacherName)}</td><td>${escapeHtml(row.classroom)}</td><td>${formatDate(row.startsAt)}</td><td>${formatDate(row.endsAt)}</td></tr>`).join('')}</tbody></table></div>`;
}

bootstrap();
