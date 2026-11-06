# 项目文档目录

## 1 项目信息

| 项目 | 内容 |
|---|---|
| 项目名称 | 表情符号课堂情绪检查器系统 |
| 课程 | 软件工程实践 |
| 团队成员 | 张豪（PB23111590）、李贺（PB23111614）、张显（PB23111617） |
| 文档版本 | 1.0 |
| 文档日期 | 2026 年 11 月 6 日 |

## 2 文档清单

| 编号 | 文档 | 文件 | 主要内容 |
|---:|---|---|---|
| 01 | 需求规格说明书 | [requirements.md](requirements.md) | 角色、用例、功能需求、非功能需求、数据需求和追踪矩阵 |
| 02 | 系统设计文档 | [design.md](design.md) | 架构图、修改版 MVC、ER 图、时序图、模块与安全设计 |
| 03 | API 接口文档 | [api-documentation.md](api-documentation.md) | REST、AI、Socket.IO、认证、请求和响应结构 |
| 04 | 数据库脚本 | [database-schema.sql](database-schema.sql) | 数据表、约束、外键和索引 |
| 05 | 测试用例说明书 | [test-cases.md](test-cases.md) | 功能、安全、AI、兼容性和部署测试用例 |
| 06 | 测试报告 | [test-report.md](test-report.md) | 测试环境、结果、覆盖范围、缺陷与结论 |
| 07 | 部署说明 | [deployment.md](deployment.md) | 本机、Docker、环境变量、备份、回滚和 CI |
| 08 | 用户手册 | [user-manual.md](user-manual.md) | 学生、教师、管理员和 AI 操作流程 |
| 09 | 实验报告 | [experiment-report.md](experiment-report.md) | 目的、需求、设计、实现、测试、AI 局限性和总结 |
| 10 | 团队分工与贡献度 | [contribution.md](contribution.md) | 成员分工、协作方式、主要产出和贡献度 |
| 11 | 验收检查表 | [acceptance-checklist.md](acceptance-checklist.md) | 功能、安全、数据、文档和工程验收 |
| 12 | 要求覆盖矩阵 | [requirements-coverage.md](requirements-coverage.md) | 指导书要求与实现、测试证据对应关系 |
| 13 | 版本控制记录 | [version-control-record.md](version-control-record.md) | 仓库、分支、提交规范和版本标签 |
| 14 | 演示脚本 | [demo-script.md](demo-script.md) | 系统答辩演示流程 |
| 15 | 完整人工测试操作手册 | [manual-test-guide.md](manual-test-guide.md) | 三角色、AI、摄像头、安全、部署和提交验收步骤 |

## 3 源码与工程材料

| 材料 | 位置 | 说明 |
|---|---|---|
| Node 后端 | `server/` | Express、SQLite、JWT、RBAC、统计、CSV、Socket.IO |
| Web 客户端 | `public/` | 学生、教师、管理员页面和 SVG 图表 |
| AI 服务 | `ai-service/` | FastAPI、OpenCV、DeepFace、阈值和匿名入库 |
| 自动化测试 | `tests/`、`ai-service/test_main.py` | Node 集成测试和 AI 单元测试 |
| CI | `.github/workflows/ci.yml` | GitHub Actions 静态检查与测试 |
| 容器化 | `Dockerfile`、`docker-compose.yml` | 后端和 AI 服务容器部署 |
| 在线接口文档 | `/api/docs` | Swagger UI |

## 4 验证结果

| 项目 | 结果 |
|---|---|
| JavaScript/Python 静态检查 | 通过 |
| Node 集成测试 | 16/16 通过 |
| AI 单元测试 | 6/6 通过 |
| 后端健康检查 | 通过 |
| AI 健康检查 | 通过 |
| 模拟 AI 入库链路 | 通过 |

## 5 项目结构

```text
emoji-classroom-checker/
├─ .github/workflows/      CI 流水线
├─ ai-service/             AI 推理服务
├─ docs/                   实验文档
├─ public/                 Web 客户端
├─ server/                 后端与数据库
├─ tests/                  Node 自动化测试
├─ docker-compose.yml
├─ Dockerfile
├─ package.json
└─ README.md
```
