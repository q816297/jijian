# Crystal-Forum
基于 Cloudflare Workers + D1 数据库构建的现代化轻量级论坛系统，采用玻璃态设计风格，支持移动端适配。

✨ 功能特性

👥 用户系统

· ✅ 用户注册/登录（JWT认证）
· ✅ 修改用户名（需验证密码）
· ✅ 修改密码
· ✅ 用户角色系统（普通用户/管理员/站长）

📝 论坛功能

· ✅ 发帖/回帖/编辑/删除
· ✅ 帖子分类（综合讨论/技术交流/资源分享/问题求助/灌水闲聊）
· ✅ 浏览量统计
· ✅ 分页浏览
· ✅ 实时回复

👑 管理功能

· ✅ 站长后台管理
· ✅ 用户权限管理
· ✅ 帖子管理

📱 移动端优化

· ✅ 响应式设计
· ✅ 触摸友好界面
· ✅ 移动端专属样式优化

🔒 安全特性

· ✅ 密码哈希存储（SHA-256 + Salt）
· ✅ JWT令牌认证
· ✅ 速率限制保护
· ✅ XSS防护（自动HTML转义）

🚀 快速部署

前置要求

· Cloudflare 账户
· Wrangler CLI（Cloudflare Workers命令行工具）
· Node.js 16+

部署步骤

1. 克隆项目

```bash
git clone <项目地址>
cd crystal-forum
```

1. 安装依赖

```bash
npm install -g wrangler
```

1. 配置项目

```bash
# 登录Cloudflare
wrangler login

# 初始化项目
wrangler d1 create crystal-forum-db

# 更新 wrangler.toml 中的数据库绑定
# 创建 .dev.vars 文件用于本地开发
echo "JWT_SECRET=your-secret-key-here" > .dev.vars
```

1. 部署到Cloudflare

```bash
# 部署数据库
wrangler d1 execute crystal-forum-db --file=./schema.sql

# 部署Worker
wrangler deploy
```

⚙️ 环境变量

变量名 说明 示例
JWT_SECRET JWT签名密钥 your-secret-key-here

📊 数据库架构

用户表 (users)

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  avatar TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

帖子表 (posts)

```sql
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  user_id INTEGER,
  category TEXT DEFAULT 'general',
  views INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
)
```

回复表 (replies)

```sql
CREATE TABLE replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  post_id INTEGER,
  user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
)
```

🔧 API接口

公开接口

· POST /api/register - 用户注册
· POST /api/login - 用户登录
· GET /api/posts - 获取帖子列表
· GET /api/post/:id - 获取帖子详情

需要登录的接口

· PUT /api/user/password - 修改密码
· PUT /api/user/username - 修改用户名
· POST /api/posts - 发帖
· POST /api/replies - 回帖
· PUT /api/post/:id - 编辑帖子
· DELETE /api/post/:id - 删除帖子

站长接口

· GET /api/admin/users - 获取用户列表
· PUT /api/admin/user/:id/role - 修改用户角色

📱 默认账户

系统自动创建默认站长账户：

· 用户名: admin
· 密码: admin123

重要: 部署后请立即修改默认密码！

🎨 设计特点

玻璃态设计

· 毛玻璃背景效果
· 现代化渐变色彩
· 优雅的卡片设计
· 流畅的交互动画

移动端优化

· 触摸友好的大按钮
· 自适应布局
· 优化的表单输入
· 流畅的滑动体验

🔄 本地开发

1. 启动本地开发服务器

```bash
wrangler dev
```

1. 访问本地环境

```
http://localhost:8787
```

1. 查看数据库

```bash
wrangler d1 execute crystal-forum-db --local --command="SELECT * FROM users"
```

📦 项目结构

```
crystal-forum/
├── worker.js          # Worker主文件
├── wrangler.toml      # 配置文件
├── .gitignore         # Git忽略文件
├── README.md          # 说明文档
└── schema.sql         # 数据库架构
```

🛠️ 技术栈

· 运行时: Cloudflare Workers
· 数据库: Cloudflare D1 (SQLite)
· 认证: JWT (HMAC SHA-256)
· 前端: 原生HTML/CSS/JavaScript
· 样式: 玻璃态设计，响应式布局

🔐 安全建议

1. JWT密钥: 使用强随机字符串，定期更换
2. 密码策略: 建议至少8位，包含字母数字
3. 速率限制: 默认限制60请求/分钟，可调整
4. HTTPS: Cloudflare Workers默认支持

🐛 故障排除

常见问题

1. 数据库连接失败
   · 检查数据库绑定名称是否匹配
   · 确认数据库已创建并初始化
2. JWT验证失败
   · 检查环境变量JWT_SECRET是否设置
   · 确认客户端和服务端使用相同密钥
3. 静态资源加载问题
   · 检查Worker路由配置
   · 确认HTML中的资源路径正确

日志查看

```bash
wrangler tail
```

📄 许可证

MIT License - 详见LICENSE文件

🤝 贡献指南

1. Fork 项目
2. 创建功能分支 (git checkout -b feature/AmazingFeature)
3. 提交更改 (git commit -m 'Add some AmazingFeature')
4. 推送到分支 (git push origin feature/AmazingFeature)
5. 开启 Pull Request

📞 支持

如有问题，请：

1. 查看文档和常见问题
2. 提交Issue报告bug
3. 提出功能建议
