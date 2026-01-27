# ⚡ edge-forum-worker

一个基于 **Cloudflare Worker** + **D1 数据库** 构建的轻量级论坛系统。零服务器成本，快速部署，支持自定义域名。

> 🚀 无需购买服务器，利用 Cloudflare 免费配额即可运行完整的论坛功能

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Cloudflare](https://img.shields.io/badge/platform-Cloudflare-orange.svg)
![Vanilla JS](https://img.shields.io/badge/frontend-Vanilla%20JS-yellow.svg)

## ✨ 功能特性

- 🔐 **用户系统** - 注册/登录/JWT 认证，支持修改用户名和密码
- 📝 **帖子管理** - 发布、编辑、删除、分类浏览
- 💬 **评论回复** - 支持对帖子进行回复讨论
- 🏷️ **分类系统** - 综合讨论、技术交流、资源分享、问题求助、灌水闲聊
- 👑 **权限管理** - 普通用户/管理员/站长三级权限体系
- 📱 **响应式设计** - 完美适配移动端和桌面端
- 🎨 **玻璃拟态 UI** - 现代化的视觉体验
- 🛡️ **安全防护** - 内置速率限制（Rate Limiting）防止滥用
- 🗄️ **D1 数据库** - 使用 Cloudflare 原生 SQLite 数据库

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| **运行平台** | Cloudflare Worker (Edge Computing) |
| **数据库** | Cloudflare D1 (SQLite) |
| **前端** | 原生 HTML5 + CSS3 + Vanilla JavaScript |
| **认证** | JWT (HMAC SHA-256) |
| **UI 风格** | Glassmorphism (玻璃拟态) |

## 🚀 快速开始

### 前置要求

- [Cloudflare](https://dash.cloudflare.com) 账号（免费版即可）
- 安装 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)：`npm install -g wrangler`
- 登录 Wrangler：`wrangler login`

### 1. 创建 D1 数据库

```bash
# 创建数据库
wrangler d1 create edge-forum-db

# 记录返回的 database_id，后续配置需要用到
```

2. 配置 wrangler.toml

在项目根目录创建 `wrangler.toml`：

```toml
name = "edge-forum-worker"
main = "worker.js"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"  # 代码中通过 env.DB 访问
database_name = "edge-forum-db"
database_id = "你的-database-id-这里"
```

3. 设置环境变量

设置 JWT 密钥（用于 Token 签名）：

```bash
# 生成随机密钥（可选，也可以自定义）
openssl rand -base64 32

# 设置密钥到 Cloudflare
wrangler secret put JWT_SECRET
# 然后输入你的密钥
```

4. 部署

```bash
# 本地预览（可选）
wrangler dev

# 部署到 Cloudflare
wrangler deploy
```

5. 初始化数据库（首次运行）

部署完成后，首次访问会自动创建数据库表结构和默认站长账号。

🔑 默认账号

部署完成后，可以使用以下默认账号登录：

- 用户名: `admin`
- 密码: `admin123`
- 身份: 站长（Webmaster）

⚠️ 强烈建议：首次登录后立即修改默认密码！

📝 项目结构

```
edge-forum-worker/
├── worker.js          # 主入口（Worker 脚本，包含前后端完整代码）
├── README.md          # 项目说明
└── LICENSE            # 开源协议
```

> 注：本项目采用单文件架构，所有后端 API 和前端 HTML/CSS/JS 都集成在 `worker.js` 中，便于部署和维护。

🔧 环境变量说明

变量名	必填	说明	
`JWT_SECRET`	✅	JWT 签名密钥，建议 32 位以上随机字符串	
`DB`	✅	D1 数据库绑定（在 wrangler.toml 中配置）	

📸 界面预览

待添加截图

主要界面

1. 首页 - 帖子列表、分类筛选、分页
2. 帖子详情 - 内容展示、回复列表、快速回复
3. 用户菜单 - 修改用户名/密码、管理后台入口
4. 管理后台 - 用户权限管理（仅站长可见）

⚡ 性能与限制

由于使用 Cloudflare 免费套餐，需要注意以下限制：

- Worker: 每天 100,000 次请求
- D1: 每天 50,000 次查询（读取），5,000 次写入
- CPU 时间: 每次请求最多 50ms（免费版）

对于中小规模论坛完全够用。如需更高配额，可考虑升级到付费套餐。

🛣️ 路线图

- 支持 Markdown 编辑器
- 图片上传功能（R2 存储）
- 邮件通知系统
- 暗黑/亮色主题切换
- 搜索功能
- 插件系统

🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打开 Pull Request

📄 开源协议

本项目基于 [MIT](LICENSE) 协议开源。

---

Made with 💜 & ☕ by Qwara-Chan.
