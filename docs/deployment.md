# 部署说明

## 1 本机部署

### 1.1 后端和网页

环境要求：Node.js 22.5 或更高版本。

```powershell
Set-Location D:\Program\software\emoji-classroom-checker
Copy-Item .env.example .env
npm install
npm start
```

验证：

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

浏览器访问 `http://localhost:3000`，Swagger 位于 `http://localhost:3000/api/docs`。

### 1.2 AI 服务

建议使用 Python 3.11：

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r .\ai-service\requirements.txt
$env:AI_BACKEND_URL="http://localhost:3000"
$env:AI_SERVICE_TOKEN="与后端 .env 完全一致"
python -m uvicorn main:app --app-dir ai-service --host 0.0.0.0 --port 8000
```

验证：

```powershell
Invoke-RestMethod http://localhost:8000/health
Invoke-RestMethod -Method Post -Uri http://localhost:8000/simulate `
  -ContentType application/json `
  -Body '{"sessionId":1,"emojiType":"HAPPY","confidence":0.92}'
```

## 2 Docker Compose 部署

安装并启动 Docker Desktop 后执行：

```powershell
Set-Location D:\Program\software\emoji-classroom-checker
Copy-Item .env.example .env
docker compose config
docker compose up --build -d
docker compose ps
docker compose logs -f
```

停止服务：

```powershell
docker compose down
```

如需同时删除数据库卷，才使用 `docker compose down -v`。该命令会删除持久化数据，执行前必须备份。

## 3 环境变量

| 变量 | 说明 | 正式部署要求 |
|---|---|---|
| PORT | Web 监听端口 | 按环境设置 |
| DB_PATH | SQLite 文件位置 | 指向持久化目录 |
| JWT_SECRET | JWT 签名密钥 | 使用长随机值 |
| JWT_EXPIRES_IN | JWT 有效期 | 建议 8h 或更短 |
| AI_SERVICE_TOKEN | AI 独立令牌 | 与 JWT 密钥不同 |
| ADMIN_REGISTRATION_CODE | 管理员注册码 | 使用长随机值 |
| SEED_DEMO_DATA | 是否生成演示数据 | 正式环境设为 false |
| AI_BACKEND_URL | AI 调用的后端地址 | 容器内为 backend:3000 |
| AI_CONFIDENCE_THRESHOLD | 置信度阈值 | 默认 0.65 |
| AI_SAMPLE_INTERVAL_SECONDS | 采样间隔 | 默认 3 秒 |
| AI_CAMERA_INDEX | 摄像头编号 | 默认 0 |

可用 PowerShell 生成随机密钥：

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

## 4 数据备份与恢复

本机部署备份：停止后端后复制 `data/emoji-checker.db`。WAL 模式运行时不要只复制主文件，应先正常停止服务，或同时处理 `-wal` 和 `-shm` 文件。

容器部署可使用临时容器将 `emoji-data` 卷导出到宿主机。恢复前必须停止应用，避免同时写入。

## 5 上线安全检查

- 更换所有默认密钥和演示密码。
- 设置 `SEED_DEMO_DATA=false`。
- 通过 HTTPS 反向代理提供服务。
- 限制 8000 端口只允许后端或可信内网访问。
- 完成摄像头告知与授权，不保存原始人脸数据。
- 定期备份数据库和检查审计日志。
- 多实例部署时使用共享数据库和 Socket.IO Redis Adapter。

## 6 验证命令

```powershell
npm run check
npm test
npm run test:ai
npm audit
```

所有命令通过后，再按 [验收检查表](acceptance-checklist.md) 完成人工三角色和 AI 全链路测试。

## 7 CI 流水线

项目包含 `.github/workflows/ci.yml`。代码推送到 GitHub 或创建拉取请求后，流水线会自动使用 Node.js 24 和 Python 3.11 执行：

1. `npm ci`；
2. 安装 AI 基础依赖；
3. `npm run check`；
4. `npm test`；
5. `npm run test:ai`。

CI 使用 AI 基础依赖执行接口和阈值测试；视频推理部署使用 `ai-service/requirements.txt` 中的完整 OpenCV/DeepFace 依赖。

## 8 从零部署完整流程

1. 安装 Node.js 24、Python 3.11 和 Git。
2. 获取项目源码，确认 `.env` 未从他人环境直接复制。
3. 从 `.env.example` 创建 `.env` 并更换三个安全字段：JWT 密钥、AI 令牌、管理员注册码。
4. 执行 `npm ci`，确保依赖版本与锁文件一致。
5. 创建 Python 虚拟环境，安装基础或完整 AI 依赖。
6. 先启动 Node 后端，确认 `/api/health`。
7. 再启动 AI 服务，确认 `/health` 中后端地址和阈值正确。
8. 运行静态检查和测试。
9. 使用三种角色进行人工流程测试。
10. 有摄像头时执行真实推理；无摄像头时至少执行 `/simulate`。

## 9 升级与回滚

### 9.1 升级前

- 停止应用写入。
- 备份 SQLite 数据库以及 `.env`。
- 记录当前版本号、Node/Python 版本和依赖锁文件。
- 执行当前版本测试，确认升级前系统正常。

### 9.2 升级

```powershell
npm ci
python -m pip install -r ai-service\requirements.txt
npm run check
npm test
npm run test:ai
```

数据库迁移必须是向后兼容或提供明确恢复脚本。当前项目使用启动时幂等建表，新增破坏性字段变更前应先制作数据库副本。

### 9.3 回滚

1. 停止后端和 AI 服务。
2. 恢复上一版本源码和依赖锁文件。
3. 恢复升级前数据库备份。
4. 重新运行健康检查和核心业务测试。

## 10 常见故障排查

| 现象 | 可能原因 | 处理方法 |
|---|---|---|
| 3000 端口无法启动 | 端口被占用 | 停止旧进程或修改 `PORT` |
| 数据库无法打开 | `DB_PATH` 目录不可写 | 检查路径和权限，避免指向只读目录 |
| 登录一直失败 | 演示密码已修改或账号停用 | 管理员启用账号并使用正确密码 |
| AI 返回 401 | 两端 AI 令牌不一致 | 对照 `.env` 和 AI 进程环境变量 |
| AI 返回 502 | 后端未启动或地址错误 | 检查 `AI_BACKEND_URL` 和后端健康接口 |
| AI 摄像头返回 503 | 缺少 OpenCV/DeepFace | 安装完整依赖并使用 Python 3.11 |
| 摄像头被占用 | 其他程序正在使用设备 | 关闭相机、会议软件后重试 |
| Docker 数据丢失 | 使用了 `down -v` | 从备份恢复命名卷数据 |
| CSV 中文乱码 | 打开方式忽略 BOM | 使用 Excel 导入 UTF-8 或检查导出文件 |

## 11 部署验收项目

| 项目 | 验收标准 |
|---|---|
| 密钥配置 | JWT、AI 令牌和管理员注册码使用独立配置 |
| 配置隔离 | `.env` 不进入源码仓库和提交包 |
| 服务健康 | Node 和 AI 健康接口返回 UP |
| 自动化测试 | Node 14 项、AI 5 项测试全部通过 |
| 角色流程 | 学生、教师、管理员流程均可完成 |
| 视频推理 | 摄像头采样、情绪映射、阈值过滤和入库正常 |
| 容器部署 | Compose 服务、网络和数据卷运行正常 |
| 数据保护 | 数据库可备份与恢复，原始视频不落盘 |
| 访问控制 | AI 端口、管理功能和导出数据受权限保护 |
