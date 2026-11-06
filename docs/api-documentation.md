# API 接口文档

## 1 文档说明

- 后端基础地址：`http://localhost:3000/api`
- Swagger UI：`http://localhost:3000/api/docs`
- OpenAPI JSON：`http://localhost:3000/api/openapi.json`
- AI 服务基础地址：`http://localhost:8000`
- 数据格式：除 CSV 导出外均为 JSON
- 时间格式：ISO 8601，例如 `2026-11-05T08:00:00.000Z`

本文档用于实验报告和人工联调；运行时接口契约以 OpenAPI 页面为准。

## 2 认证方式

### 2.1 用户 JWT

登录成功后取得 `data.token`，访问受保护接口时携带：

```http
Authorization: Bearer <JWT>
```

JWT 只表示身份，后端每次请求仍会查询账号状态。账号被停用后，已签发 JWT 立即失效。

### 2.2 AI 服务令牌

AI 入库接口不使用用户 JWT，而使用独立请求头：

```http
X-AI-Token: <AI_SERVICE_TOKEN>
```

用户 JWT 与 AI 服务令牌不得设置为相同值。

## 3 统一响应结构

成功示例：

```json
{
  "success": true,
  "data": {
    "message": "操作成功"
  }
}
```

失败示例：

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "注册信息不完整或格式不正确。",
    "details": {}
  }
}
```

常用状态码：

| 状态码 | 含义 |
|---:|---|
| 200 | 查询或更新成功 |
| 201 | 资源创建或记录写入成功 |
| 400 | 参数格式、时间范围或业务规则错误 |
| 401 | 未认证、JWT 无效或 AI 令牌错误 |
| 403 | 角色或数据范围越权、账号停用 |
| 404 | 资源不存在 |
| 409 | 用户名或邮箱冲突 |
| 429 | 登录或注册请求过于频繁 |
| 500 | 服务内部错误 |

### 3.1 接口总览与认证矩阵

| 分组 | 方法与路径 | 调用角色 | 认证方式 |
|---|---|---|---|
| 系统 | `GET /health`、`GET /openapi.json` | 公开 | 无 |
| 认证 | `POST /auth/register`、`POST /auth/login` | 公开 | 无，认证端点限流 |
| 认证 | `PUT /auth/password`、`GET /users/me` | 学生、教师、管理员 | Bearer JWT |
| 课堂 | `GET /sessions` | 学生、教师、管理员 | Bearer JWT，按角色裁剪 |
| Emoji | `POST /emoji` | 学生 | Bearer JWT + 排课关系 |
| Emoji | `GET /emoji/history`、`GET /emoji/statistics` | 学生、教师、管理员 | Bearer JWT + 数据范围校验 |
| 管理 | `/admin/users`、`/admin/courses`、`/admin/sessions/*` | 管理员 | Bearer JWT + ADMIN |
| 看板统计 | `GET /admin/dashboard/realtime`、`GET /admin/statistics` | 教师、管理员 | Bearer JWT + 课堂归属 |
| 导出 | `GET /admin/emoji/export` | 管理员 | Bearer JWT + ADMIN |
| Web AI | `GET /ai/health`、`POST /ai/analyze-frame` | 教师、管理员 | Bearer JWT + 课堂归属 |
| AI 入库 | `POST /ai/emoji-results` | AI 服务 | `X-AI-Token` |

### 3.2 主要错误代码

| 错误代码 | 触发条件 |
|---|---|
| `VALIDATION_ERROR` | 请求体字段、枚举、长度或时间格式无效 |
| `AUTH_REQUIRED` / `INVALID_TOKEN` | 缺少 JWT 或令牌无效、过期 |
| `ACCOUNT_UNAVAILABLE` / `ACCOUNT_DISABLED` | 账号已停用 |
| `FORBIDDEN` / `SESSION_FORBIDDEN` | 角色无权调用或课堂超出数据范围 |
| `USER_EXISTS` | 用户名或邮箱已存在 |
| `ADMIN_CODE_INVALID` | 管理员注册码错误 |
| `SESSION_NOT_FOUND` / `COURSE_NOT_FOUND` | 课堂或课程不存在 |
| `AI_TOKEN_INVALID` | AI 独立令牌错误 |
| `AI_SERVICE_UNAVAILABLE` | 后端无法连接 FastAPI 服务 |
| `AI_ANALYSIS_FAILED` | FastAPI 返回图像解析、依赖或推理错误 |

## 4 系统接口

### 4.1 后端健康检查

- 方法：`GET /health`
- 权限：公开
- 用途：检查 Node 服务和数据库初始化是否正常。

响应示例：

```json
{
  "success": true,
  "data": {
    "status": "UP",
    "timestamp": "2026-11-05T08:30:00.000Z"
  }
}
```

## 5 认证与用户接口

### 5.1 注册

- 方法：`POST /auth/register`
- 权限：公开，受认证限流保护
- 请求字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| username | string | 是 | 3-30 位中英文、数字、下划线或连字符 |
| email | string | 是 | 合法且唯一的邮箱 |
| password | string | 是 | 至少 8 位，包含大小写字母和数字 |
| role | enum | 否 | STUDENT、TEACHER、ADMIN；默认 STUDENT |
| adminCode | string | 管理员必填 | 必须等于服务端管理员注册码 |

```json
{
  "username": "student02",
  "email": "student02@example.edu",
  "password": "Student234!",
  "role": "STUDENT"
}
```

成功返回用户信息和 JWT。重复账号返回 409，管理员注册码错误返回 403。

### 5.2 登录

- 方法：`POST /auth/login`
- 权限：公开，受认证限流保护

```json
{
  "username": "student",
  "password": "Student123!"
}
```

成功返回当前用户和 JWT；密码错误返回 401；停用账号返回 403。

### 5.3 修改密码

- 方法：`PUT /auth/password`
- 权限：登录用户

```json
{
  "currentPassword": "Student123!",
  "newPassword": "Changed123!"
}
```

新密码必须满足复杂度要求。修改成功后应使用新密码重新登录。

### 5.4 当前用户

- 方法：`GET /users/me`
- 权限：登录用户
- 返回：用户编号、用户名、角色、邮箱和状态，不返回密码哈希。

## 6 课堂与学生功能接口

### 6.1 查询可访问课堂

- 方法：`GET /sessions`
- 权限：登录用户
- 数据边界：学生只见已排课课堂；教师只见本人课程；管理员可见全部。

### 6.2 学生提交 emoji

- 方法：`POST /emoji`
- 权限：STUDENT

```json
{
  "sessionId": 1,
  "emojiType": "HAPPY",
  "deviceId": "web-client"
}
```

`emojiType` 可取 `HAPPY`、`CALM`、`CONFUSED`、`SAD`、`ANGRY`、`SURPRISED`。学生未被安排到课堂时返回 403。

### 6.3 查询 emoji 历史

- 方法：`GET /emoji/history`
- 权限：登录用户
- 查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| sessionId | integer | 否 | 限定课堂 |
| limit | integer | 否 | 默认 100，最大 500 |

学生只返回本人记录；教师只返回本人授课课堂；管理员返回全局数据。返回字段包括用户名、课程、班级、类型、时间、来源、置信度和设备标识。

### 6.4 基础统计

- 方法：`GET /emoji/statistics`
- 权限：登录用户
- 查询参数：可选 `sessionId`
- 返回：总样本量、六类情绪数量、百分比和 AI 平均置信度。

```json
{
  "success": true,
  "data": {
    "total": 8,
    "counts": [
      { "emojiType": "HAPPY", "count": 3, "percentage": 37.5, "averageConfidence": 0.91 },
      { "emojiType": "CALM", "count": 2, "percentage": 25.0, "averageConfidence": null }
    ]
  }
}
```

实际响应固定包含六种 `emojiType`，无样本类别的 `count` 与 `percentage` 为 0。

## 7 管理员接口

### 7.1 查询用户

- 方法：`GET /admin/users`
- 权限：ADMIN
- 返回：用户编号、用户名、角色、邮箱、状态和创建时间。

### 7.2 启用或停用用户

- 方法：`PATCH /admin/users/{id}/status`
- 权限：ADMIN

```json
{
  "status": "DISABLED"
}
```

管理员不能停用当前登录账号。状态变更写入审计日志。

### 7.3 查询课程

- 方法：`GET /admin/courses`
- 权限：ADMIN
- 返回课程、教师编号和教师用户名。

### 7.4 创建课程

- 方法：`POST /admin/courses`
- 权限：ADMIN

```json
{
  "name": "软件工程实践",
  "teacherId": 2
}
```

`teacherId` 必须对应状态正常的教师账号。

### 7.5 创建课堂会话

- 方法：`POST /admin/sessions`
- 权限：ADMIN

```json
{
  "courseId": 1,
  "startsAt": "2026-11-05T08:00:00.000Z",
  "endsAt": "2026-11-05T10:00:00.000Z",
  "classroom": "实验楼 301",
  "className": "软件工程 1 班"
}
```

结束时间必须晚于开始时间。

### 7.6 查询课堂名单

- 方法：`GET /admin/sessions/{id}/schedule`
- 权限：ADMIN
- 返回该课堂当前所有学生。

### 7.7 完整替换课堂名单

- 方法：`POST /admin/sessions/{id}/schedule`
- 权限：ADMIN

```json
{
  "userIds": [3, 5, 8]
}
```

数组最大 500 项，只能包含有效学生。空数组表示清空名单。该操作不是增量追加，而是以提交列表完整替换原名单。

## 8 看板与统计接口

### 8.1 实时课堂看板

- 方法：`GET /admin/dashboard/realtime?sessionId=1`
- 权限：TEACHER、ADMIN
- 教师数据边界：课堂必须属于当前教师。
- 返回内容：最近 15 分钟总样本量、主导情绪、需关注反馈、AI 样本、分布、分钟趋势和最新动态。

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | integer | 当前课堂编号 |
| `windowMinutes` | integer | 实时窗口，固定为 15 |
| `stats.total` | integer | 窗口内总记录数 |
| `stats.counts` | array | 六类数量、占比和 AI 平均置信度 |
| `trend` | array | `minute`、`emojiType`、`count` 分钟桶 |
| `latest` | array | 最近 20 条类型、来源、置信度和时间 |
| `generatedAt` | date-time | 服务端生成时间 |

### 8.2 多维统计

- 方法：`GET /admin/statistics`
- 权限：TEACHER、ADMIN
- 查询参数：

| 参数 | 示例 | 说明 |
|---|---|---|
| course | `1` | 课程 ID |
| class | `软件工程 1 班` | 班级名称 |
| from | `2026-11-01T00:00:00.000Z` | 起始时间 |
| to | `2026-11-30T23:59:59.999Z` | 结束时间 |

可以组合使用。`from` 晚于 `to` 时返回 400。教师可选项和结果自动限制在本人课程。

响应包含 `total`、`counts`、`bySession`、`trend`、`filters` 和 `options`。其中 `bySession` 返回课堂、课程、班级、开始时间和样本数，无记录课堂仍显示为 0；`options.courses` 与 `options.classes` 用于生成当前角色可见的筛选选项。

### 8.3 导出 CSV

- 方法：`GET /admin/emoji/export`
- 权限：ADMIN
- 参数：与多维统计相同
- 响应类型：`text/csv; charset=utf-8`
- 安全措施：UTF-8 BOM、CSV 正确转义、公式危险前缀转义、导出审计日志。

## 9 AI 后端入库接口

### 9.1 提交 AI 情绪结果

- 方法：`POST /ai/emoji-results`
- 权限：`X-AI-Token`
- 可选请求头：`X-Confidence-Threshold`

```json
{
  "sessionId": 1,
  "emojiType": "CALM",
  "confidence": 0.91,
  "recordedAt": "2026-11-05T08:20:00.000Z",
  "deviceId": "camera-0",
  "anonymous": true
}
```

低于阈值时返回 200 和 `accepted=false`；通过阈值后返回 201。匿名记录的 `user_id` 为 NULL。

### 9.2 Web AI 健康检查

- 方法：`GET /ai/health`
- 权限：教师、管理员 JWT
- 说明：由后端代理查询 AI 服务状态，供 Web 摄像头页面判断视觉依赖是否可用。

### 9.3 Web 摄像头帧分析

- 方法：`POST /ai/analyze-frame`
- 权限：教师、管理员 JWT，并校验课堂归属
- 说明：浏览器显示实时预览，将当前帧以 Base64 发送到后端；后端代理至 AI 服务，原始画面不落盘。

```json
{
  "sessionId": 1,
  "imageBase64": "data:image/jpeg;base64,...",
  "deviceId": "web-camera-preview"
}
```

返回检测到的人脸数量、连续帧收集状态、融合后的情绪概率、第一与第二候选差值、图像质量、已入库结果和过滤原因。过滤原因包括低置信度、候选接近、连续帧不稳定和图像质量过低。学生调用返回 403，AI 服务不可用时返回 502。

连续帧收集中的典型响应：

```json
{
  "success": true,
  "data": {
    "faces": 1,
    "accepted": [],
    "filtered": [],
    "pending": { "framesCollected": 2, "framesRequired": 3 },
    "quality": { "brightness": 112.4, "sharpness": 94.8, "warnings": [] },
    "threshold": 0.65,
    "temporalWindow": 3
  }
}
```

融合完成后，`accepted` 或 `filtered` 中的对象包含以下判定字段：

| 字段 | 说明 |
|---|---|
| `emojiType` | 映射后的六类 emoji |
| `confidence`、`rawEmotion` | 融合后主类别概率和 DeepFace 原始类别 |
| `runnerUpEmotion`、`runnerUpConfidence` | 第二候选及概率 |
| `margin` | 第一、第二候选概率差 |
| `emotionScores` | DeepFace 七类归一化概率 |
| `detectorBackend` | 实际成功的 `opencv` 或 `mtcnn` 检测器 |
| `temporalFrames`、`agreement` | 融合帧数和帧间主类别一致率 |
| `confidenceThreshold`、`marginThreshold` | 本次判定实际采用的阈值 |
| `backend` | 仅 `accepted` 包含，表示后端入库响应 |
| `reason` | 仅 `filtered` 包含，表示过滤原因 |

`reason` 可取 `LOW_CONFIDENCE`、`AMBIGUOUS`、`UNSTABLE` 或 `LOW_IMAGE_QUALITY`。无人脸时 `faces=0`，结果数组为空，不写入数据库。

## 10 AI 服务接口

### 10.1 AI 健康检查

- 方法：`GET http://localhost:8000/health`
- 返回：服务状态、后端地址、检测器、基础与分类阈值、连续帧窗口、候选差值、摄像头运行状态和视觉依赖可用性。

关键字段为 `status`、`backendUrl`、`visionAvailable`、`cameraRunning`、`detectorBackends`、`faceExpandPercentage`、`threshold`、`temporalWindow`、`minimumEmotionMargin`、`minimumTemporalAgreement` 和 `classThresholds`。

### 10.2 模拟结果

- 方法：`POST http://localhost:8000/simulate`

```json
{
  "sessionId": 1,
  "emojiType": "HAPPY",
  "confidence": 0.92
}
```

用于没有摄像头或 DeepFace 的环境验证 AI 到后端的完整链路。

### 10.3 上传帧分析

- 方法：`POST http://localhost:8000/analyze-frame`
- 内容类型：`application/json`
- 输入：Base64 编码图像、课堂编号和设备编号
- 输出：检测到的人脸数量、图像质量、连续帧融合进度、各表情概率、候选差值、映射结果、过滤原因和提交状态。

```json
{
  "sessionId": 1,
  "imageBase64": "<不含或包含 data URL 前缀的 Base64 图像>",
  "deviceId": "upload-client"
}
```

### 10.4 启动与停止摄像头

- 启动：`POST http://localhost:8000/camera/start`
- 停止：`POST http://localhost:8000/camera/stop`
- 说明：启动操作创建后台采样任务，停止操作释放摄像头。视觉依赖缺失时返回 503。

启动请求：

```json
{
  "sessionId": 1,
  "cameraIndex": 0,
  "deviceId": "classroom-camera"
}
```

摄像头任务已运行时返回 409。停止时若无运行任务，返回 `{"stopped": false, "reason": "NOT_RUNNING"}`；成功停止返回 `{"stopped": true}`。

## 11 Socket.IO 事件

### 11.1 连接认证

客户端在连接时通过 `auth.token` 提交 JWT。服务端拒绝无效或停用账号。

### 11.2 加入课堂房间

- 客户端事件：`dashboard:join`
- 参数：课堂编号
- 房间名：`session:{id}`
- 权限：教师仅能加入本人课堂，管理员可加入全部课堂。

### 11.3 新记录事件

- 服务端事件：`emoji:new`
- 数据：`sessionId`、`emojiType`、`source`、`recordedAt`
- 用途：通知看板重新请求最新统计，不向客户端广播学生身份或人脸信息。

## 12 联调顺序

1. 调用后端 `/health`。
2. 登录获取 JWT。
3. 查询 `/sessions` 获取课堂编号。
4. 使用学生 JWT 提交 `/emoji`。
5. 使用教师 JWT 查询历史、统计和实时看板。
6. 使用管理员 JWT测试课程、课堂、排课、统计和 CSV。
7. 调用 AI `/health` 和 `/simulate`。
8. 最后在具备视觉依赖的设备验证上传帧和摄像头接口。

## 13 接口版本与兼容约定

- 后端使用 OpenAPI 3.0.3，接口文档版本为 1.1.0。
- JSON 字段统一采用 camelCase；FastAPI 通过 Pydantic 别名接受相同格式。
- 时间统一使用带时区的 ISO 8601 字符串，数据库按 UTC 字符串保存。
- 新增响应字段保持向后兼容；删除或重命名字段时同步更新 Web、OpenAPI、测试与本文档。
- 浏览器帧请求同时受 Express 2 MB JSON 上限和 `imageBase64` 2,000,000 字符校验，应发送压缩 JPEG 单帧，不发送原始视频流。
