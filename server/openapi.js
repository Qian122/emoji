const emojiTypes = ['HAPPY', 'CALM', 'CONFUSED', 'SAD', 'ANGRY', 'SURPRISED'];
const bearer = [{ bearerAuth: [] }];
const jsonContent = (schema) => ({ 'application/json': { schema } });
const response = (description, schema = { $ref: '#/components/schemas/ApiResponse' }) => ({ description, content: jsonContent(schema) });

const openapi = {
  openapi: '3.0.3',
  info: {
    title: '表情符号课堂情绪检查器 API',
    version: '1.1.0',
    description: '学生、教师、管理员和 AI 推理服务共用的 REST API。除 AI 接口外，受保护接口使用 Bearer JWT。'
  },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      aiToken: { type: 'apiKey', in: 'header', name: 'X-AI-Token' }
    },
    schemas: {
      ApiResponse: {
        type: 'object', required: ['success'],
        properties: { success: { type: 'boolean' }, data: {}, error: { $ref: '#/components/schemas/ApiError' } }
      },
      ApiError: {
        type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} }
      },
      LoginInput: {
        type: 'object', required: ['username', 'password'], properties: { username: { type: 'string' }, password: { type: 'string', format: 'password' } }
      },
      RegisterInput: {
        type: 'object', required: ['username', 'email', 'password'],
        properties: {
          username: { type: 'string', minLength: 3, maxLength: 30 }, email: { type: 'string', format: 'email' },
          password: { type: 'string', format: 'password', minLength: 8 }, role: { type: 'string', enum: ['STUDENT', 'TEACHER', 'ADMIN'], default: 'STUDENT' },
          adminCode: { type: 'string', format: 'password' }
        }
      },
      EmojiRecordInput: {
        type: 'object', required: ['sessionId', 'emojiType'],
        properties: { sessionId: { type: 'integer', minimum: 1 }, emojiType: { type: 'string', enum: emojiTypes }, deviceId: { type: 'string', maxLength: 100 } }
      },
      AiEmojiInput: {
        type: 'object', required: ['sessionId', 'emojiType', 'confidence'],
        properties: {
          sessionId: { type: 'integer', minimum: 1 }, emojiType: { type: 'string', enum: emojiTypes }, confidence: { type: 'number', minimum: 0, maximum: 1 },
          recordedAt: { type: 'string', format: 'date-time' }, deviceId: { type: 'string' }, anonymous: { type: 'boolean', default: true }, userId: { type: 'integer' }
        }
      },
      AiFrameInput: {
        type: 'object', required: ['sessionId', 'imageBase64'],
        properties: {
          sessionId: { type: 'integer', minimum: 1 },
          imageBase64: { type: 'string', description: 'JPEG/PNG Data URL 或纯 Base64 字符串，最大约 2 MB' },
          deviceId: { type: 'string', maxLength: 100 }
        }
      },
      CourseInput: { type: 'object', required: ['name', 'teacherId'], properties: { name: { type: 'string' }, teacherId: { type: 'integer' } } },
      SessionInput: {
        type: 'object', required: ['courseId', 'startsAt', 'endsAt', 'classroom', 'className'],
        properties: {
          courseId: { type: 'integer' }, startsAt: { type: 'string', format: 'date-time' }, endsAt: { type: 'string', format: 'date-time' },
          classroom: { type: 'string' }, className: { type: 'string' }
        }
      },
      ScheduleInput: { type: 'object', required: ['userIds'], properties: { userIds: { type: 'array', maxItems: 500, items: { type: 'integer' } } } }
    },
    parameters: {
      SessionId: { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
      CourseFilter: { name: 'course', in: 'query', schema: { type: 'integer', minimum: 1 }, description: '课程 ID' },
      ClassFilter: { name: 'class', in: 'query', schema: { type: 'string' }, description: '班级名称' },
      FromFilter: { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
      ToFilter: { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } }
    }
  },
  paths: {
    '/health': { get: { tags: ['系统'], summary: '健康检查', responses: { 200: response('服务正常') } } },
    '/auth/register': { post: { tags: ['认证'], summary: '注册用户', requestBody: { required: true, content: jsonContent({ $ref: '#/components/schemas/RegisterInput' }) }, responses: { 201: response('注册成功'), 400: response('输入校验失败'), 403: response('管理员注册码错误'), 409: response('用户已存在') } } },
    '/auth/login': { post: { tags: ['认证'], summary: '登录并获取 JWT', requestBody: { required: true, content: jsonContent({ $ref: '#/components/schemas/LoginInput' }) }, responses: { 200: response('登录成功'), 401: response('账号或密码错误'), 403: response('账号已停用') } } },
    '/auth/password': { put: { tags: ['认证'], summary: '修改当前用户密码', security: bearer, requestBody: { required: true, content: jsonContent({ type: 'object', required: ['currentPassword', 'newPassword'], properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string', minLength: 8 } } }) }, responses: { 200: response('修改成功'), 400: response('密码格式或当前密码错误'), 401: response('未认证') } } },
    '/users/me': { get: { tags: ['用户'], summary: '获取当前用户', security: bearer, responses: { 200: response('用户信息'), 401: response('未认证') } } },
    '/sessions': { get: { tags: ['课堂'], summary: '获取当前角色有权访问的课堂', security: bearer, responses: { 200: response('课堂列表') } } },
    '/emoji': { post: { tags: ['情绪'], summary: '学生提交课堂情绪', security: bearer, requestBody: { required: true, content: jsonContent({ $ref: '#/components/schemas/EmojiRecordInput' }) }, responses: { 201: response('记录成功'), 403: response('未排课或角色不符') } } },
    '/emoji/history': { get: { tags: ['情绪'], summary: '按角色权限查询历史', security: bearer, parameters: [{ name: 'sessionId', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500 } }], responses: { 200: response('历史记录'), 403: response('课堂越权') } } },
    '/emoji/statistics': { get: { tags: ['统计'], summary: '查询个人或课堂基础统计', security: bearer, parameters: [{ name: 'sessionId', in: 'query', schema: { type: 'integer' } }], responses: { 200: response('统计结果') } } },
    '/admin/users': { get: { tags: ['管理'], summary: '管理员查询用户', security: bearer, responses: { 200: response('用户列表'), 403: response('非管理员') } } },
    '/admin/users/{id}/status': { patch: { tags: ['管理'], summary: '启用或停用用户', security: bearer, parameters: [{ $ref: '#/components/parameters/SessionId' }], requestBody: { required: true, content: jsonContent({ type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] } } }) }, responses: { 200: response('状态已更新'), 400: response('不能停用自己或参数错误') } } },
    '/admin/courses': {
      get: { tags: ['管理'], summary: '查询课程', security: bearer, responses: { 200: response('课程列表') } },
      post: { tags: ['管理'], summary: '创建课程并指定教师', security: bearer, requestBody: { required: true, content: jsonContent({ $ref: '#/components/schemas/CourseInput' }) }, responses: { 201: response('课程已创建'), 400: response('教师或课程无效') } }
    },
    '/admin/sessions': { post: { tags: ['管理'], summary: '创建课堂会话', security: bearer, requestBody: { required: true, content: jsonContent({ $ref: '#/components/schemas/SessionInput' }) }, responses: { 201: response('课堂已创建'), 400: response('时间或字段无效') } } },
    '/admin/sessions/{id}/schedule': {
      get: { tags: ['管理'], summary: '查询课堂排课名单', security: bearer, parameters: [{ $ref: '#/components/parameters/SessionId' }], responses: { 200: response('排课名单') } },
      post: { tags: ['管理'], summary: '完整替换课堂排课名单', security: bearer, parameters: [{ $ref: '#/components/parameters/SessionId' }], requestBody: { required: true, content: jsonContent({ $ref: '#/components/schemas/ScheduleInput' }) }, responses: { 200: response('名单已保存'), 400: response('名单包含无效学生') } }
    },
    '/admin/dashboard/realtime': { get: { tags: ['看板'], summary: '最近 15 分钟实时统计与趋势', security: bearer, parameters: [{ name: 'sessionId', in: 'query', required: true, schema: { type: 'integer' } }], responses: { 200: response('看板数据'), 403: response('课堂越权') } } },
    '/admin/statistics': { get: { tags: ['统计'], summary: '按课程、班级、时间段查询分布、课堂样本和趋势', security: bearer, parameters: [{ $ref: '#/components/parameters/CourseFilter' }, { $ref: '#/components/parameters/ClassFilter' }, { $ref: '#/components/parameters/FromFilter' }, { $ref: '#/components/parameters/ToFilter' }], responses: { 200: response('多维统计'), 400: response('筛选条件无效') } } },
    '/admin/emoji/export': { get: { tags: ['统计'], summary: '按当前筛选条件导出安全 CSV', security: bearer, parameters: [{ $ref: '#/components/parameters/CourseFilter' }, { $ref: '#/components/parameters/ClassFilter' }, { $ref: '#/components/parameters/FromFilter' }, { $ref: '#/components/parameters/ToFilter' }], responses: { 200: { description: 'UTF-8 CSV', content: { 'text/csv': { schema: { type: 'string' } } } } } } },
    '/ai/health': { get: { tags: ['AI'], summary: '教师或管理员检查 AI 服务状态', security: bearer, responses: { 200: response('AI 服务状态'), 403: response('角色无权访问'), 502: response('AI 服务不可用') } } },
    '/ai/analyze-frame': { post: { tags: ['AI'], summary: '教师或管理员提交浏览器摄像头帧进行分析', security: bearer, requestBody: { required: true, content: jsonContent({ $ref: '#/components/schemas/AiFrameInput' }) }, responses: { 200: response('画面分析完成'), 403: response('角色或课堂权限不足'), 502: response('AI 服务不可用') } } },
    '/ai/emoji-results': { post: { tags: ['AI'], summary: 'AI 服务提交匿名推理结果', security: [{ aiToken: [] }], parameters: [{ name: 'X-Confidence-Threshold', in: 'header', schema: { type: 'number', minimum: 0, maximum: 1 } }], requestBody: { required: true, content: jsonContent({ $ref: '#/components/schemas/AiEmojiInput' }) }, responses: { 201: response('结果已入库'), 200: response('低置信度结果被过滤'), 401: response('AI 令牌错误') } } }
  }
};

module.exports = openapi;
