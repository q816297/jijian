// ============================================
// Cloudflare Workers + D1 论坛应用
// ============================================

const RATE_LIMIT = { maxRequests: 60, windowMs: 60000 };
const PAGE_SIZE = 20;

// ============ 工具函数 ============
async function hashPassword(password, secret) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + secret);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function createToken(payload, secret) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify({ ...payload, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }));
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`));
  return `${header}.${body}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
}

async function verifyToken(token, secret) {
  try {
    const [header, body, sig] = token.split('.');
    const payload = JSON.parse(atob(body));
    if (payload.exp < Date.now()) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(sig), c => c.charCodeAt(0)), encoder.encode(`${header}.${body}`));
    return valid ? payload : null;
  } catch { return null; }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}

// ============ 速率限制 ============
const rateLimitMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT.windowMs };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + RATE_LIMIT.windowMs; }
  record.count++;
  rateLimitMap.set(ip, record);
  return record.count <= RATE_LIMIT.maxRequests;
}

// ============ 数据库初始化 ============
async function initDB(db, secret) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      role TEXT DEFAULT 'user', avatar TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL,
      user_id INTEGER, category TEXT DEFAULT 'general', views INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, post_id INTEGER, user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (post_id) REFERENCES posts(id), FOREIGN KEY (user_id) REFERENCES users(id)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_replies_post ON replies(post_id)`)
  ]);
  // 创建默认站长账户
  const admin = await db.prepare('SELECT id FROM users WHERE role = ?').bind('webmaster').first();
  if (!admin) {
    const pwd = await hashPassword('admin123', secret);
    await db.prepare('INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)').bind('admin', pwd, 'webmaster').run();
  }
}

// ============ API 路由处理 ============
async function handleAPI(request, db, path, user, secret) {
  const method = request.method;

  // 用户注册
  if (path === '/api/register' && method === 'POST') {
    const { username, password } = await request.json();
    if (!username || !password || username.length < 2 || password.length < 6) {
      return json({ error: '用户名至少2位，密码至少6位' }, 400);
    }
    try {
      const hash = await hashPassword(password, secret);
      await db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').bind(username, hash).run();
      return json({ success: true });
    } catch { return json({ error: '用户名已存在' }, 400); }
  }

  // 用户登录
  if (path === '/api/login' && method === 'POST') {
    const { username, password } = await request.json();
    const hash = await hashPassword(password, secret);
    const user = await db.prepare('SELECT id, username, role, avatar FROM users WHERE username = ? AND password = ?').bind(username, hash).first();
    if (!user) return json({ error: '用户名或密码错误' }, 401);
    const token = await createToken({ id: user.id, username: user.username, role: user.role }, secret);
    return json({ token, user });
  }

  // 修改密码
  if (path === '/api/user/password' && method === 'PUT') {
    if (!user) return json({ error: '请先登录' }, 401);
    const { currentPassword, newPassword } = await request.json();
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return json({ error: '新密码至少6位' }, 400);
    }
    
    const currentHash = await hashPassword(currentPassword, secret);
    const dbUser = await db.prepare('SELECT id FROM users WHERE id = ? AND password = ?').bind(user.id, currentHash).first();
    if (!dbUser) return json({ error: '当前密码错误' }, 403);
    
    const newHash = await hashPassword(newPassword, secret);
    await db.prepare('UPDATE users SET password = ? WHERE id = ?').bind(newHash, user.id).run();
    return json({ success: true });
  }

  // 修改用户名（新增API）
  if (path === '/api/user/username' && method === 'PUT') {
    if (!user) return json({ error: '请先登录' }, 401);
    const { currentPassword, newUsername } = await request.json();
    if (!currentPassword || !newUsername || newUsername.length < 2) {
      return json({ error: '新用户名至少2位' }, 400);
    }
    
    // 验证当前密码
    const currentHash = await hashPassword(currentPassword, secret);
    const dbUser = await db.prepare('SELECT id FROM users WHERE id = ? AND password = ?').bind(user.id, currentHash).first();
    if (!dbUser) return json({ error: '当前密码错误' }, 403);
    
    // 检查新用户名是否已存在
    const existing = await db.prepare('SELECT id FROM users WHERE username = ?').bind(newUsername).first();
    if (existing) return json({ error: '用户名已存在' }, 400);
    
    // 更新用户名
    await db.prepare('UPDATE users SET username = ? WHERE id = ?').bind(newUsername, user.id).run();
    return json({ success: true, newUsername });
  }

  // 获取帖子列表
  if (path.startsWith('/api/posts') && method === 'GET') {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page')) || 1;
    const category = url.searchParams.get('category');
    const offset = (page - 1) * PAGE_SIZE;
    
    let query = `SELECT p.*, u.username, u.avatar, (SELECT COUNT(*) FROM replies WHERE post_id = p.id) as reply_count 
                 FROM posts p LEFT JOIN users u ON p.user_id = u.id`;
    let countQuery = 'SELECT COUNT(*) as total FROM posts';
    const params = [];
    
    if (category) {
      query += ' WHERE p.category = ?';
      countQuery += ' WHERE category = ?';
      params.push(category);
    }
    query += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
    
    const posts = await db.prepare(query).bind(...params, PAGE_SIZE, offset).all();
    const total = await db.prepare(countQuery).bind(...params).first();
    return json({ posts: posts.results, total: total.total, page, pageSize: PAGE_SIZE });
  }

  // 获取单个帖子详情
  if (path.match(/^\/api\/post\/\d+$/) && method === 'GET') {
    const id = path.split('/').pop();
    await db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').bind(id).run();
    const post = await db.prepare(`SELECT p.*, u.username, u.avatar FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?`).bind(id).first();
    if (!post) return json({ error: '帖子不存在' }, 404);
    const replies = await db.prepare(`SELECT r.*, u.username, u.avatar FROM replies r LEFT JOIN users u ON r.user_id = u.id WHERE r.post_id = ? ORDER BY r.created_at`).bind(id).all();
    return json({ post, replies: replies.results });
  }

  // 以下接口需要登录
  if (!user) return json({ error: '请先登录' }, 401);

  // 发帖
  if (path === '/api/posts' && method === 'POST') {
    const { title, content, category } = await request.json();
    if (!title || !content) return json({ error: '标题和内容不能为空' }, 400);
    const result = await db.prepare('INSERT INTO posts (title, content, category, user_id) VALUES (?, ?, ?, ?)').bind(title, content, category || 'general', user.id).run();
    return json({ success: true, id: result.meta.last_row_id });
  }

  // 回帖
  if (path === '/api/replies' && method === 'POST') {
    const { post_id, content } = await request.json();
    if (!content) return json({ error: '内容不能为空' }, 400);
    await db.prepare('INSERT INTO replies (post_id, content, user_id) VALUES (?, ?, ?)').bind(post_id, content, user.id).run();
    return json({ success: true });
  }

  // 编辑帖子
  if (path.match(/^\/api\/post\/\d+$/) && method === 'PUT') {
    const id = path.split('/').pop();
    const { title, content } = await request.json();
    const post = await db.prepare('SELECT user_id FROM posts WHERE id = ?').bind(id).first();
    if (!post) return json({ error: '帖子不存在' }, 404);
    if (post.user_id !== user.id && !['admin', 'webmaster'].includes(user.role)) {
      return json({ error: '无权限编辑' }, 403);
    }
    await db.prepare('UPDATE posts SET title = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(title, content, id).run();
    return json({ success: true });
  }

  // 删除帖子
  if (path.match(/^\/api\/post\/\d+$/) && method === 'DELETE') {
    const id = path.split('/').pop();
    const post = await db.prepare('SELECT user_id FROM posts WHERE id = ?').bind(id).first();
    if (!post) return json({ error: '帖子不存在' }, 404);
    if (post.user_id !== user.id && !['admin', 'webmaster'].includes(user.role)) {
      return json({ error: '无权限删除' }, 403);
    }
    await db.batch([
      db.prepare('DELETE FROM replies WHERE post_id = ?').bind(id),
      db.prepare('DELETE FROM posts WHERE id = ?').bind(id)
    ]);
    return json({ success: true });
  }

  // 站长：管理用户权限
  if (path === '/api/admin/users' && method === 'GET' && user.role === 'webmaster') {
    const users = await db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC').all();
    return json({ users: users.results });
  }

  if (path.match(/^\/api\/admin\/user\/\d+\/role$/) && method === 'PUT' && user.role === 'webmaster') {
    const id = path.split('/')[4];
    const { role } = await request.json();
    if (!['user', 'admin'].includes(role)) return json({ error: '无效角色' }, 400);
    await db.prepare('UPDATE users SET role = ? WHERE id = ? AND role != ?').bind(role, id, 'webmaster').run();
    return json({ success: true });
  }

  return json({ error: 'Not Found' }, 404);
}

// ============ HTML 页面 ============
function getHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Crystal Forum - 水晶论坛</title>
  <meta name="theme-color" content="#667eea">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    :root {
      --glass-bg: rgba(255, 255, 255, 0.25);
      --glass-border: rgba(255, 255, 255, 0.4);
      --glass-shadow: 0 8px 32px rgba(31, 38, 135, 0.15);
      --primary: #007AFF;
      --danger: #FF3B30;
      --success: #34C759;
      --text: #1d1d1f;
      --text-secondary: #86868b;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
      min-height: 100vh;
      color: var(--text);
      line-height: 1.6;
    }
    .glass {
      background: var(--glass-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--glass-border);
      border-radius: 20px;
      box-shadow: var(--glass-shadow);
    }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    
    /* Header */
    header {
      position: sticky; top: 0; z-index: 100;
      padding: 15px 30px; margin-bottom: 30px;
      display: flex; justify-content: space-between; align-items: center;
    }
    .logo {
      font-size: 24px; font-weight: 700;
      background: linear-gradient(135deg, #fff, #e0e0e0);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      text-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    .nav-btns { display: flex; gap: 10px; }
    
    /* Buttons */
    .btn {
      padding: 10px 24px; border: none; border-radius: 12px;
      font-size: 15px; font-weight: 500; cursor: pointer;
      transition: all 0.3s ease; display: inline-flex; align-items: center; gap: 6px;
      touch-action: manipulation;
    }
    .btn:active { transform: scale(0.95); }
    .btn-primary {
      background: linear-gradient(135deg, var(--primary), #5856D6);
      color: white; box-shadow: 0 4px 15px rgba(0, 122, 255, 0.4);
    }
    .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0, 122, 255, 0.5); }
    .btn-glass { background: var(--glass-bg); color: white; border: 1px solid var(--glass-border); }
    .btn-glass:hover { background: rgba(255,255,255,0.35); }
    .btn-danger { background: var(--danger); color: white; }
    .btn-sm { padding: 6px 14px; font-size: 13px; }
    
    /* Cards */
    .card { padding: 25px; margin-bottom: 20px; transition: transform 0.3s; }
    .card:hover { transform: translateY(-3px); }
    .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px; }
    .card-title {
      font-size: 18px; font-weight: 600; color: #fff;
      text-shadow: 0 1px 3px rgba(0,0,0,0.2);
    }
    .card-title a { color: inherit; text-decoration: none; }
    .card-title a:hover { text-decoration: underline; }
    .card-meta { font-size: 13px; color: rgba(255,255,255,0.7); display: flex; gap: 15px; flex-wrap: wrap; }
    .card-meta span { display: flex; align-items: center; gap: 4px; }
    .badge {
      padding: 4px 10px; border-radius: 20px; font-size: 12px;
      background: rgba(255,255,255,0.2); color: white;
    }
    .badge-admin { background: var(--primary); }
    .badge-webmaster { background: linear-gradient(135deg, #FF9500, #FF3B30); }
    
    /* Forms */
    .form-group { margin-bottom: 20px; }
    .form-group label { display: block; margin-bottom: 8px; color: white; font-weight: 500; }
    .form-control {
      width: 100%; padding: 14px 18px; border: 1px solid var(--glass-border);
      border-radius: 12px; font-size: 15px;
      background: rgba(255,255,255,0.15); color: white;
      transition: all 0.3s;
      appearance: none;
    }
    .form-control::placeholder { color: rgba(255,255,255,0.5); }
    .form-control:focus { outline: none; border-color: var(--primary); background: rgba(255,255,255,0.25); }
    textarea.form-control { min-height: 150px; resize: vertical; }
    select.form-control { cursor: pointer; }
    select.form-control option { background: #333; color: white; }
    
    /* Modal */
    .modal-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.5);
      backdrop-filter: blur(5px); display: none; justify-content: center; align-items: center; z-index: 1000;
      padding: 20px; overflow-y: auto;
    }
    .modal-overlay.active { display: flex; }
    .modal { width: 90%; max-width: 500px; padding: 30px; animation: slideUp 0.3s; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; }
    .modal-title { font-size: 22px; font-weight: 600; color: white; }
    .modal-close { background: none; border: none; font-size: 28px; color: white; cursor: pointer; opacity: 0.7; }
    .modal-close:hover { opacity: 1; }
    @keyframes slideUp { from { transform: translateY(30px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    
    /* Post Detail */
    .post-content { color: rgba(255,255,255,0.9); font-size: 16px; line-height: 1.8; white-space: pre-wrap; word-break: break-word; }
    .replies-section { margin-top: 30px; }
    .replies-title { color: white; font-size: 18px; margin-bottom: 20px; }
    .reply-item { padding: 20px; margin-bottom: 15px; }
    .reply-header { display: flex; justify-content: space-between; margin-bottom: 10px; }
    .reply-author { color: white; font-weight: 500; }
    .reply-time { color: rgba(255,255,255,0.6); font-size: 13px; }
    .reply-content { color: rgba(255,255,255,0.85); }
    
    /* Categories */
    .categories { display: flex; gap: 10px; margin-bottom: 25px; flex-wrap: wrap; }
    .cat-btn {
      padding: 8px 18px; border-radius: 20px; border: none;
      background: rgba(255,255,255,0.15); color: white;
      cursor: pointer; transition: all 0.3s; font-size: 14px;
    }
    .cat-btn:hover, .cat-btn.active { background: var(--primary); }
    
    /* Pagination */
    .pagination { display: flex; justify-content: center; gap: 10px; margin-top: 30px; flex-wrap: wrap; }
    .page-btn {
      width: 40px; height: 40px; border-radius: 10px; border: none;
      background: var(--glass-bg); color: white; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.3s;
    }
    .page-btn:hover, .page-btn.active { background: var(--primary); }
    .page-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    
    /* User Info */
    .user-info { display: flex; align-items: center; gap: 10px; color: white; cursor: pointer; }
    .user-info:active { transform: scale(0.95); }
    .avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: linear-gradient(135deg, #667eea, #764ba2);
      display: flex; align-items: center; justify-content: center;
      font-weight: 600; font-size: 14px;
    }
    
    /* Admin Panel */
    .admin-table { width: 100%; border-collapse: collapse; }
    .admin-table th, .admin-table td {
      padding: 15px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .admin-table th { color: rgba(255,255,255,0.7); font-weight: 500; }
    .admin-table td { color: white; }
    
    /* Toast */
    .toast {
      position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
      padding: 15px 30px; border-radius: 12px; color: white;
      font-weight: 500; z-index: 2000; animation: fadeInUp 0.3s;
      max-width: 90%; text-align: center;
    }
    .toast-success { background: var(--success); }
    .toast-error { background: var(--danger); }
    @keyframes fadeInUp { from { transform: translate(-50%, 20px); opacity: 0; } }
    
    /* Empty State */
    .empty { text-align: center; padding: 60px 20px; color: rgba(255,255,255,0.6); }
    .empty-icon { font-size: 60px; margin-bottom: 20px; opacity: 0.5; }
    
    /* User Menu */
    .user-menu {
      position: relative;
    }
    .user-menu-dropdown {
      position: absolute; top: 100%; right: 0; margin-top: 10px;
      background: var(--glass-bg); backdrop-filter: blur(20px);
      border: 1px solid var(--glass-border); border-radius: 12px;
      box-shadow: var(--glass-shadow); padding: 10px;
      min-width: 180px; display: none; z-index: 1001;
    }
    .user-menu-dropdown.active { display: block; }
    .user-menu-item {
      padding: 10px 15px; border-radius: 8px; cursor: pointer;
      color: white; background: none; border: none; width: 100%;
      text-align: left; font-size: 14px;
    }
    .user-menu-item:hover { background: rgba(255,255,255,0.2); }
    
    /* Mobile Optimizations */
    @media (max-width: 768px) {
      .container { padding: 15px; }
      header { flex-direction: column; gap: 15px; padding: 15px; }
      .logo { font-size: 20px; }
      .nav-btns { gap: 8px; }
      .card { padding: 20px; }
      .modal { padding: 20px; width: 95%; }
      .modal-title { font-size: 18px; }
      .form-control { padding: 12px 15px; font-size: 16px; }
      .btn { padding: 12px 20px; font-size: 16px; }
      .btn-sm { padding: 8px 12px; font-size: 14px; }
      .card-title { font-size: 16px; }
      .post-content { font-size: 15px; }
      .categories { gap: 8px; }
      .cat-btn { padding: 6px 12px; font-size: 13px; }
      .admin-table { font-size: 14px; }
      .admin-table th, .admin-table td { padding: 10px 5px; }
      .pagination { gap: 5px; }
      .page-btn { width: 36px; height: 36px; }
    }
    
    @media (max-width: 480px) {
      .container { padding: 10px; }
      header { padding: 10px; }
      .logo { font-size: 18px; }
      .user-info { gap: 6px; }
      .avatar { width: 32px; height: 32px; font-size: 12px; }
      .card { padding: 15px; margin-bottom: 15px; }
      .card-meta { gap: 10px; font-size: 12px; }
      .modal { padding: 15px; }
      .form-group { margin-bottom: 15px; }
      .btn { padding: 10px 18px; }
      .reply-item { padding: 15px; }
      .user-menu-dropdown { min-width: 160px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="glass">
      <div class="logo">💎 Crystal Forum</div>
      <div class="nav-btns" id="navBtns"></div>
    </header>
    <main id="app"></main>
  </div>

  <!-- Login Modal -->
  <div class="modal-overlay" id="loginModal">
    <div class="modal glass">
      <div class="modal-header">
        <h2 class="modal-title">登录</h2>
        <button class="modal-close" onclick="closeModal('loginModal')">&times;</button>
      </div>
      <form onsubmit="handleLogin(event)">
        <div class="form-group">
          <label>用户名</label>
          <input type="text" class="form-control" id="loginUsername" required placeholder="输入用户名" autocomplete="username">
        </div>
        <div class="form-group">
          <label>密码</label>
          <input type="password" class="form-control" id="loginPassword" required placeholder="输入密码" autocomplete="current-password">
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%">登录</button>
      </form>
      <p style="text-align:center;margin-top:20px;color:rgba(255,255,255,0.7)">
        没有账号？<a href="#" onclick="openModal('registerModal');closeModal('loginModal')" style="color:var(--primary)">立即注册</a>
      </p>
    </div>
  </div>

  <!-- Register Modal -->
  <div class="modal-overlay" id="registerModal">
    <div class="modal glass">
      <div class="modal-header">
        <h2 class="modal-title">注册</h2>
        <button class="modal-close" onclick="closeModal('registerModal')">&times;</button>
      </div>
      <form onsubmit="handleRegister(event)">
        <div class="form-group">
          <label>用户名</label>
          <input type="text" class="form-control" id="regUsername" required placeholder="至少2个字符" minlength="2" autocomplete="username">
        </div>
        <div class="form-group">
          <label>密码</label>
          <input type="password" class="form-control" id="regPassword" required placeholder="至少6个字符" minlength="6" autocomplete="new-password">
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%">注册</button>
      </form>
    </div>
  </div>

  <!-- New Post Modal -->
  <div class="modal-overlay" id="postModal">
    <div class="modal glass" style="max-width:700px">
      <div class="modal-header">
        <h2 class="modal-title" id="postModalTitle">发布新帖</h2>
        <button class="modal-close" onclick="closeModal('postModal')">&times;</button>
      </div>
      <form onsubmit="handlePost(event)">
        <input type="hidden" id="editPostId">
        <div class="form-group">
          <label>标题</label>
          <input type="text" class="form-control" id="postTitle" required placeholder="帖子标题">
        </div>
        <div class="form-group">
          <label>分类</label>
          <select class="form-control" id="postCategory">
            <option value="general">综合讨论</option>
            <option value="tech">技术交流</option>
            <option value="share">资源分享</option>
            <option value="help">问题求助</option>
            <option value="off-topic">灌水闲聊</option>
          </select>
        </div>
        <div class="form-group">
          <label>内容</label>
          <textarea class="form-control" id="postContent" required placeholder="帖子内容..."></textarea>
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%">发布</button>
      </form>
    </div>
  </div>

  <!-- Change Password Modal -->
  <div class="modal-overlay" id="passwordModal">
    <div class="modal glass">
      <div class="modal-header">
        <h2 class="modal-title">修改密码</h2>
        <button class="modal-close" onclick="closeModal('passwordModal')">&times;</button>
      </div>
      <form onsubmit="handleChangePassword(event)">
        <div class="form-group">
          <label>当前密码</label>
          <input type="password" class="form-control" id="currentPassword" required placeholder="输入当前密码" autocomplete="current-password">
        </div>
        <div class="form-group">
          <label>新密码</label>
          <input type="password" class="form-control" id="newPassword" required placeholder="至少6位" minlength="6" autocomplete="new-password">
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%">确认修改</button>
      </form>
    </div>
  </div>

  <!-- Change Username Modal -->
  <div class="modal-overlay" id="usernameModal">
    <div class="modal glass">
      <div class="modal-header">
        <h2 class="modal-title">修改用户名</h2>
        <button class="modal-close" onclick="closeModal('usernameModal')">&times;</button>
      </div>
      <form onsubmit="handleChangeUsername(event)">
        <div class="form-group">
          <label>当前密码（验证身份）</label>
          <input type="password" class="form-control" id="verifyPassword" required placeholder="输入当前密码" autocomplete="current-password">
        </div>
        <div class="form-group">
          <label>新用户名</label>
          <input type="text" class="form-control" id="newUsername" required placeholder="至少2个字符" minlength="2" autocomplete="username">
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%">确认修改</button>
      </form>
    </div>
  </div>

  <script>
    // ============ State ============
    let currentUser = null;
    let currentPage = 1;
    let currentCategory = '';
    let currentView = 'list';
    let currentPostId = null;

    // ============ API ============
    async function api(path, options = {}) {
      const token = localStorage.getItem('token');
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      
      try {
        const res = await fetch(path, { ...options, headers });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '请求失败');
        return data;
      } catch (e) {
        toast(e.message, 'error');
        throw e;
      }
    }

    // ============ Auth ============
    async function handleLogin(e) {
      e.preventDefault();
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('loginUsername').value,
          password: document.getElementById('loginPassword').value
        })
      });
      localStorage.setItem('token', data.token);
      currentUser = data.user;
      closeModal('loginModal');
      toast('登录成功！', 'success');
      render();
    }

    async function handleRegister(e) {
      e.preventDefault();
      await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('regUsername').value,
          password: document.getElementById('regPassword').value
        })
      });
      closeModal('registerModal');
      toast('注册成功，请登录！', 'success');
      openModal('loginModal');
    }

    async function handleChangePassword(e) {
      e.preventDefault();
      try {
        await api('/api/user/password', {
          method: 'PUT',
          body: JSON.stringify({
            currentPassword: document.getElementById('currentPassword').value,
            newPassword: document.getElementById('newPassword').value
          })
        });
        closeModal('passwordModal');
        toast('密码修改成功！', 'success');
        document.getElementById('currentPassword').value = '';
        document.getElementById('newPassword').value = '';
      } catch (e) {}
    }

    async function handleChangeUsername(e) {
      e.preventDefault();
      try {
        const data = await api('/api/user/username', {
          method: 'PUT',
          body: JSON.stringify({
            currentPassword: document.getElementById('verifyPassword').value,
            newUsername: document.getElementById('newUsername').value
          })
        });
        closeModal('usernameModal');
        toast('用户名修改成功！', 'success');
        currentUser.username = data.newUsername;
        renderNav();
        document.getElementById('verifyPassword').value = '';
        document.getElementById('newUsername').value = '';
      } catch (e) {}
    }

    function logout() {
      localStorage.removeItem('token');
      currentUser = null;
      toast('已退出登录', 'success');
      render();
    }

    // ============ Posts ============
    async function loadPosts() {
      const params = new URLSearchParams({ page: currentPage });
      if (currentCategory) params.set('category', currentCategory);
      return await api('/api/posts?' + params);
    }

    async function loadPost(id) {
      return await api('/api/post/' + id);
    }

    async function handlePost(e) {
      e.preventDefault();
      const editId = document.getElementById('editPostId').value;
      const data = {
        title: document.getElementById('postTitle').value,
        content: document.getElementById('postContent').value,
        category: document.getElementById('postCategory').value
      };
      
      if (editId) {
        await api('/api/post/' + editId, { method: 'PUT', body: JSON.stringify(data) });
        toast('帖子已更新！', 'success');
      } else {
        await api('/api/posts', { method: 'POST', body: JSON.stringify(data) });
        toast('发布成功！', 'success');
      }
      closeModal('postModal');
      if (currentView === 'detail') {
        await renderPostDetail(currentPostId);
      } else {
        await renderPostList();
      }
    }

    async function deletePost(id) {
      if (!confirm('确定要删除这篇帖子吗？')) return;
      await api('/api/post/' + id, { method: 'DELETE' });
      toast('删除成功！', 'success');
      currentView = 'list';
      await renderPostList();
    }

    async function handleReply(e) {
      e.preventDefault();
      const content = document.getElementById('replyContent').value;
      await api('/api/replies', {
        method: 'POST',
        body: JSON.stringify({ post_id: currentPostId, content })
      });
      document.getElementById('replyContent').value = '';
      toast('回复成功！', 'success');
      await renderPostDetail(currentPostId);
    }

    // ============ Admin ============
    async function loadUsers() {
      return await api('/api/admin/users');
    }

    async function updateUserRole(userId, role) {
      await api('/api/admin/user/' + userId + '/role', {
        method: 'PUT',
        body: JSON.stringify({ role })
      });
      toast('权限已更新！', 'success');
      await renderAdmin();
    }

    // ============ UI ============
    function openModal(id) { document.getElementById(id).classList.add('active'); }
    function closeModal(id) { 
      document.getElementById(id).classList.remove('active');
      if (id === 'postModal') {
        document.getElementById('editPostId').value = '';
        document.getElementById('postTitle').value = '';
        document.getElementById('postContent').value = '';
        document.getElementById('postModalTitle').textContent = '发布新帖';
      }
      if (id === 'passwordModal') {
        document.getElementById('currentPassword').value = '';
        document.getElementById('newPassword').value = '';
      }
      if (id === 'usernameModal') {
        document.getElementById('verifyPassword').value = '';
        document.getElementById('newUsername').value = '';
      }
    }

    function toast(msg, type = 'success') {
      const t = document.createElement('div');
      t.className = 'toast toast-' + type;
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3000);
    }

    function formatTime(str) {
      const d = new Date(str);
      return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }

    function getCategoryName(cat) {
      const map = { general: '综合讨论', tech: '技术交流', share: '资源分享', help: '问题求助', 'off-topic': '灌水闲聊' };
      return map[cat] || cat;
    }

    function getRoleBadge(role) {
      if (role === 'webmaster') return '<span class="badge badge-webmaster">👑 站长</span>';
      if (role === 'admin') return '<span class="badge badge-admin">🛡️ 管理员</span>';
      return '';
    }

    function toggleUserMenu() {
      const dropdown = document.getElementById('userMenuDropdown');
      dropdown.classList.toggle('active');
    }

    document.addEventListener('click', (e) => {
      const menu = document.getElementById('userMenu');
      const dropdown = document.getElementById('userMenuDropdown');
      if (menu && !menu.contains(e.target)) {
        dropdown.classList.remove('active');
      }
    });

    // ============ Render ============
    function renderNav() {
      const nav = document.getElementById('navBtns');
      if (currentUser) {
        nav.innerHTML = \`
          <div class="user-menu" id="userMenu">
            <div class="user-info" onclick="toggleUserMenu()">
              <div class="avatar">\${currentUser.username[0].toUpperCase()}</div>
              <span>\${currentUser.username}</span>
              \${getRoleBadge(currentUser.role)}
            </div>
            <div class="user-menu-dropdown glass" id="userMenuDropdown">
              <button class="user-menu-item" onclick="openModal('usernameModal'); toggleUserMenu();">
                ✏️ 修改用户名
              </button>
              <button class="user-menu-item" onclick="openModal('passwordModal'); toggleUserMenu();">
                🔐 修改密码
              </button>
              \${currentUser.role === 'webmaster' ? 
                '<button class="user-menu-item" onclick="showAdmin(); toggleUserMenu();">👑 管理后台</button>' : ''}
              <button class="user-menu-item" onclick="logout()">
                🚪 退出登录
              </button>
            </div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="showNewPost()">✏️ 发帖</button>
        \`;
      } else {
        nav.innerHTML = \`
          <button class="btn btn-glass" onclick="openModal('loginModal')">登录</button>
          <button class="btn btn-primary" onclick="openModal('registerModal')">注册</button>
        \`;
      }
    }

    async function renderPostList() {
      currentView = 'list';
      const app = document.getElementById('app');
      app.innerHTML = '<div class="card glass" style="text-align:center;padding:50px">加载中...</div>';
      
      try {
        const { posts, total, page, pageSize } = await loadPosts();
        const totalPages = Math.ceil(total / pageSize);
        
        let html = \`
          <div class="categories">
            <button class="cat-btn \${!currentCategory ? 'active' : ''}" onclick="filterCategory('')">全部</button>
            <button class="cat-btn \${currentCategory === 'general' ? 'active' : ''}" onclick="filterCategory('general')">综合讨论</button>
            <button class="cat-btn \${currentCategory === 'tech' ? 'active' : ''}" onclick="filterCategory('tech')">技术交流</button>
            <button class="cat-btn \${currentCategory === 'share' ? 'active' : ''}" onclick="filterCategory('share')">资源分享</button>
            <button class="cat-btn \${currentCategory === 'help' ? 'active' : ''}" onclick="filterCategory('help')">问题求助</button>
            <button class="cat-btn \${currentCategory === 'off-topic' ? 'active' : ''}" onclick="filterCategory('off-topic')">灌水闲聊</button>
          </div>
        \`;
        
        if (posts.length === 0) {
          html += '<div class="card glass empty"><div class="empty-icon">📭</div><p>暂无帖子</p></div>';
        } else {
          posts.forEach(p => {
            html += \`
              <div class="card glass">
                <div class="card-header">
                  <div>
                    <h3 class="card-title"><a href="#" onclick="viewPost(\${p.id})">\${escapeHtml(p.title)}</a></h3>
                    <div class="card-meta">
                      <span>👤 \${escapeHtml(p.username || '匿名')}</span>
                      <span>📁 \${getCategoryName(p.category)}</span>
                      <span>💬 \${p.reply_count} 回复</span>
                      <span>👁️ \${p.views} 浏览</span>
                      <span>🕐 \${formatTime(p.created_at)}</span>
                    </div>
                  </div>
                </div>
              </div>
            \`;
          });
          
          if (totalPages > 1) {
            html += '<div class="pagination">';
            html += \`<button class="page-btn" onclick="goPage(\${page - 1})" \${page <= 1 ? 'disabled' : ''}>‹</button>\`;
            for (let i = 1; i <= totalPages && i <= 5; i++) {
              html += \`<button class="page-btn \${page === i ? 'active' : ''}" onclick="goPage(\${i})">\${i}</button>\`;
            }
            html += \`<button class="page-btn" onclick="goPage(\${page + 1})" \${page >= totalPages ? 'disabled' : ''}">›</button>\`;
            html += '</div>';
          }
        }
        app.innerHTML = html;
      } catch (e) {
        app.innerHTML = '<div class="card glass empty"><div class="empty-icon">❌</div><p>加载失败</p></div>';
      }
    }

    async function renderPostDetail(id) {
      currentView = 'detail';
      currentPostId = id;
      const app = document.getElementById('app');
      app.innerHTML = '<div class="card glass" style="text-align:center;padding:50px">加载中...</div>';
      
      try {
        const { post, replies } = await loadPost(id);
        const canEdit = currentUser && (currentUser.id === post.user_id || ['admin', 'webmaster'].includes(currentUser.role));
        
        let html = \`
          <button class="btn btn-glass btn-sm" onclick="renderPostList()" style="margin-bottom:20px">← 返回列表</button>
          <div class="card glass">
            <div class="card-header">
              <div>
                <h2 class="card-title">\${escapeHtml(post.title)}</h2>
                <div class="card-meta">
                  <span>👤 \${escapeHtml(post.username || '匿名')}</span>
                  <span>📁 \${getCategoryName(post.category)}</span>
                  <span>👁️ \${post.views} 浏览</span>
                  <span>🕐 \${formatTime(post.created_at)}</span>
                </div>
              </div>
              \${canEdit ? \`
                <div style="display:flex;gap:10px">
                  <button class="btn btn-glass btn-sm" onclick="editPost(\${post.id}, '\${escapeHtml(post.title)}', '\${escapeHtml(post.content)}', '\${post.category}')">编辑</button>
                  <button class="btn btn-danger btn-sm" onclick="deletePost(\${post.id})">删除</button>
                </div>
              \` : ''}
            </div>
            <div class="post-content">\${escapeHtml(post.content)}</div>
          </div>
          
          <div class="replies-section">
            <h3 class="replies-title">💬 回复 (\${replies.length})</h3>
        \`;
        
        if (replies.length === 0) {
          html += '<div class="card glass" style="text-align:center;color:rgba(255,255,255,0.6)">暂无回复</div>';
        } else {
          replies.forEach(r => {
            html += \`
              <div class="reply-item glass">
                <div class="reply-header">
                  <span class="reply-author">👤 \${escapeHtml(r.username || '匿名')}</span>
                  <span class="reply-time">\${formatTime(r.created_at)}</span>
                </div>
                <div class="reply-content">\${escapeHtml(r.content)}</div>
              </div>
            \`;
          });
        }
        
        if (currentUser) {
          html += \`
            <div class="card glass" style="margin-top:20px">
              <form onsubmit="handleReply(event)">
                <div class="form-group" style="margin-bottom:15px">
                  <textarea class="form-control" id="replyContent" required placeholder="写下你的回复..." style="min-height:100px"></textarea>
                </div>
                <button type="submit" class="btn btn-primary">发表回复</button>
              </form>
            </div>
          \`;
        } else {
          html += '<div class="card glass" style="text-align:center"><a href="#" onclick="openModal(\\'loginModal\\')" style="color:var(--primary)">登录后可以回复</a></div>';
        }
        
        html += '</div>';
        app.innerHTML = html;
      } catch (e) {
        app.innerHTML = '<div class="card glass empty"><div class="empty-icon">❌</div><p>加载失败</p></div>';
      }
    }

    async function renderAdmin() {
      currentView = 'admin';
      const app = document.getElementById('app');
      app.innerHTML = '<div class="card glass" style="text-align:center;padding:50px">加载中...</div>';
      
      try {
        const { users } = await loadUsers();
        let html = \`
          <button class="btn btn-glass btn-sm" onclick="renderPostList()" style="margin-bottom:20px">← 返回论坛</button>
          <div class="card glass">
            <h2 class="card-title" style="margin-bottom:20px">👑 用户管理</h2>
            <table class="admin-table">
              <thead><tr><th>用户名</th><th>角色</th><th>注册时间</th><th>操作</th></tr></thead>
              <tbody>
        \`;
        users.forEach(u => {
          const roleText = u.role === 'webmaster' ? '站长' : (u.role === 'admin' ? '管理员' : '普通用户');
          html += \`
            <tr>
              <td>\${escapeHtml(u.username)}</td>
              <td>\${roleText}</td>
              <td>\${formatTime(u.created_at)}</td>
              <td>
                \${u.role !== 'webmaster' ? \`
                  <select onchange="updateUserRole(\${u.id}, this.value)" class="form-control" style="width:auto;padding:5px 10px">
                    <option value="user" \${u.role === 'user' ? 'selected' : ''}>普通用户</option>
                    <option value="admin" \${u.role === 'admin' ? 'selected' : ''}>管理员</option>
                  </select>
                \` : '<span style="color:rgba(255,255,255,0.5)">-</span>'}
              </td>
            </tr>
          \`;
        });
        html += '</tbody></table></div>';
        app.innerHTML = html;
      } catch (e) {
        app.innerHTML = '<div class="card glass empty"><div class="empty-icon">❌</div><p>加载失败</p></div>';
      }
    }

    function render() {
      renderNav();
      if (currentView === 'admin') renderAdmin();
      else if (currentView === 'detail') renderPostDetail(currentPostId);
      else renderPostList();
    }

    // ============ Actions ============
    function viewPost(id) { renderPostDetail(id); }
    function filterCategory(cat) { currentCategory = cat; currentPage = 1; renderPostList(); }
    function goPage(p) { currentPage = p; renderPostList(); }
    function showNewPost() {
      if (!currentUser) { openModal('loginModal'); return; }
      document.getElementById('postModalTitle').textContent = '发布新帖';
      openModal('postModal');
    }
    function showAdmin() { renderAdmin(); }
    function editPost(id, title, content, category) {
      document.getElementById('editPostId').value = id;
      document.getElementById('postTitle').value = title;
      document.getElementById('postContent').value = content;
      document.getElementById('postCategory').value = category;
      document.getElementById('postModalTitle').textContent = '编辑帖子';
      openModal('postModal');
    }
    function escapeHtml(str) {
      return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    // ============ Init ============
    (async function init() {
      const token = localStorage.getItem('token');
      if (token) {
        try {
          const [,body] = token.split('.');
          const payload = JSON.parse(atob(body));
          if (payload.exp > Date.now()) {
            currentUser = { id: payload.id, username: payload.username, role: payload.role };
          } else {
            localStorage.removeItem('token');
          }
        } catch { localStorage.removeItem('token'); }
      }
      render();
    })();
  </script>
</body>
</html>`;
}

// ============ 主处理函数 ============
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const secret = env.JWT_SECRET;

    // CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    // 速率限制
    if (!checkRateLimit(ip)) {
      return json({ error: '请求过于频繁，请稍后再试' }, 429);
    }

    // 初始化数据库
    await initDB(env.DB, secret);

    // 获取当前用户
    let user = null;
    const auth = request.headers.get('Authorization');
    if (auth && auth.startsWith('Bearer ')) {
      user = await verifyToken(auth.slice(7), secret);
    }

    // API 路由
    if (path.startsWith('/api/')) {
      return handleAPI(request, env.DB, path, user, secret);
    }

    // 返回 HTML
    return new Response(getHTML(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};
