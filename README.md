# 表情符号课堂情绪检查器系统

这是根据《表情符号课堂情绪检查器系统》实验指导书实现的可运行综合实验项目。系统提供学生、教师、管理员三类 Web 界面，独立 AI 推理服务，REST API、实时看板、关系型数据库、测试和容器部署配置。

## 已完成功能

- 学生：注册、登录、修改密码、选择课堂提交 emoji、查看个人历史。
- 教师：查看本人课堂、历史记录、最近 15 分钟实时看板、六类情绪趋势和多维统计。
- 管理员：用户启停、课程课堂创建、排课名单回显与替换、全局情绪、课程/班级/时间筛选、筛选 CSV 导出。
- 后端：JWT、bcrypt 密码哈希、RBAC、课堂归属校验、统一响应、SQLite 持久化、审计日志、Socket.IO。
- AI：Web 实时摄像头预览、单帧/连续检测、DeepFace 情绪分类、六类 emoji 映射、置信度过滤、匿名入库、失败重试。
- 安全与隐私：AI 独立令牌、参数化 SQL、输入校验、认证限流、CSV 注入防护、不保存原始人脸图像或视频。
- 工程化：Docker Compose 一键部署、GitHub Actions CI、OpenAPI、需求规格、设计、数据库脚本、测试报告、用户手册。

## 快速启动

环境要求：Node.js 22.5 或更高版本（项目使用 Node 内置 SQLite API）。

```powershell
Copy-Item .env.example .env
npm install
npm start
```

打开 `http://localhost:3000`，API 文档位于 `http://localhost:3000/api/docs`。

首次启动会生成演示数据：

| 角色 | 用户名 | 密码 |
|---|---|---|
| 学生 | student | Student123! |
| 教师 | teacher | Teacher123! |
| 管理员 | admin | Admin123! |

演示环境使用默认密钥即可启动；正式部署前必须在 `.env` 中更换 `JWT_SECRET`、`AI_SERVICE_TOKEN` 和 `ADMIN_REGISTRATION_CODE`，并修改演示账号密码。

## AI 服务启动

AI 服务建议使用 Python 3.11。只验证 `/health` 和 `/simulate` 时可安装基础依赖；真实摄像头和 DeepFace 使用完整依赖。

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r ai-service\requirements-base.txt
$env:AI_SERVICE_TOKEN="与后端 .env 相同的令牌"
python -m uvicorn main:app --app-dir ai-service --host 0.0.0.0 --port 8000
```

需要真实摄像头推理时，再安装完整依赖：

```powershell
pip install -r ai-service\requirements.txt
```

打开 `http://localhost:8000/docs`。在没有摄像头或模型环境时，可调用 `/simulate` 验证 AI 结果入库。例如课堂编号为 1：

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:8000/simulate `
  -ContentType application/json `
  -Body '{"sessionId":1,"emojiType":"HAPPY","confidence":0.92}'
```

## Docker Compose

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Web 系统监听 3000 端口，AI 服务监听 8000 端口，SQLite 数据保存在命名卷 `emoji-data` 中。摄像头直通容器依赖宿主系统，课堂现场建议直接在摄像头所在设备运行 AI 服务。

## 测试

```powershell
npm run check
npm test
npm run test:ai
npm audit
```

Node 端 16 项测试覆盖认证改密、管理员注册码、三角色 RBAC、课程课堂排课、教师历史与数据隔离、多维筛选、Socket.IO 实时推送、AI 入库、Web 摄像头受保护代理、筛选导出和账号停用。AI 端 5 项测试覆盖健康检查、阈值过滤、模拟提交、视觉依赖提示和无人脸过滤。

GitHub Actions 会在推送和拉取请求时使用 Node.js 24 与 Python 3.11 自动执行依赖安装、静态检查、Node 集成测试和 AI 单元测试。

## 目录结构

```text
emoji-classroom-checker/
├─ .github/workflows/  GitHub Actions CI
├─ server/             Express 后端、SQLite 数据层、OpenAPI
├─ public/             学生、教师、管理员响应式 Web 客户端
├─ ai-service/         FastAPI + OpenCV + DeepFace 推理服务
├─ tests/              Node 内置测试运行器自动化测试
├─ docs/               实验提交文档与数据库脚本
├─ Dockerfile
└─ docker-compose.yml
```

## 主要接口

| 类别 | 接口 |
|---|---|
| 认证 | `POST /api/auth/register`、`POST /api/auth/login`、`PUT /api/auth/password` |
| 课堂 | `GET /api/sessions`、`POST /api/admin/sessions`、`POST /api/admin/sessions/:id/schedule` |
| 情绪 | `POST /api/emoji`、`GET /api/emoji/history`、`GET /api/emoji/statistics` |
| 看板 | `GET /api/admin/dashboard/realtime`、Socket.IO `emoji:new` |
| 统计 | `GET /api/admin/statistics`、`GET /api/admin/emoji/export` |
| AI | `GET /api/ai/health`、`POST /api/ai/analyze-frame`、`POST /api/ai/emoji-results` |

完整契约以运行后的 `/api/docs` 和 `/api/openapi.json` 为准。

## 实验文档

- [需求规格说明书](docs/requirements.md)
- [系统设计文档](docs/design.md)
- [API 接口文档](docs/api-documentation.md)
- [数据库脚本](docs/database-schema.sql)
- [测试用例说明书](docs/test-cases.md)
- [测试报告](docs/test-report.md)
- [完整人工测试操作手册](docs/manual-test-guide.md)
- [用户手册](docs/user-manual.md)
- [部署说明](docs/deployment.md)
- [最终验收检查表](docs/acceptance-checklist.md)
- [实验要求覆盖矩阵](docs/requirements-coverage.md)
- [5 至 8 分钟演示脚本](docs/demo-script.md)
- [实验报告](docs/experiment-report.md)
- [团队分工与贡献度表](docs/contribution.md)
- [最终提交文档总目录](docs/submission-index.md)
- [版本控制记录说明](docs/version-control-record.md)

## AI 使用边界

面部表情分析只能作为课堂整体趋势的辅助信号，不能准确代表个体真实情绪。光照、遮挡、角度、文化差异和训练数据偏差会造成误判。系统默认匿名、设置置信度阈值且不保存原始视频，但部署前仍应完成告知与授权，并遵守学校制度及适用的个人信息保护要求。
