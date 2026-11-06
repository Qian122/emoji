# 课堂情绪检查器 Android 客户端

这是 `emoji-classroom-checker` 的独立 Android 客户端工程。它不复制、不修改原 Node.js、SQLite 和 FastAPI 项目，而是通过 Android WebView 连接已经运行的课堂情绪检查器后端。

## 1 功能

- 保留学生、教师、管理员的全部 Web 功能；
- 支持注册、登录、改密、emoji 提交、历史、看板、统计和排课；
- 支持 Socket.IO 实时看板；
- 支持教师和管理员使用手机前置摄像头进行 AI 检测；
- 支持配置服务器地址，适配模拟器、局域网真机和 HTTPS 服务器；
- 支持将管理员导出的 CSV 保存到 Android 下载目录；
- 外部链接交给系统浏览器处理，WebView 只保留所配置服务器的同源页面；
- 不在安卓工程中保存原始人脸图像或视频。

## 2 项目关系

```text
emoji-classroom-checker/            原始 Web、后端和 AI 项目，不做修改
emoji-classroom-checker-android/    独立 Android Studio 项目
```

运行时结构：

```text
Android App --HTTP/HTTPS + Socket.IO--> Node.js :3000
                                         |
                                         +--> SQLite
                                         |
                                         +--> FastAPI AI :8000
```

手机只需要访问 Node.js 的 3000 端口。AI 画面通过后端受保护代理发送，不需要向手机直接开放 8000 端口。

## 3 开发环境

- Android Studio；
- JDK 17；
- Android SDK 35；
- Gradle 8.10，由 Wrapper 管理；
- Android Gradle Plugin 8.7.3；
- 最低 Android 7.0（API 24）。

## 4 构建

Android Studio 打开本目录，完成 Gradle Sync 后选择：

```text
Build > Build App Bundles or APKs > Build APKs
```

命令行构建：

```powershell
.\gradlew.bat testDebugUnitTest lintDebug assembleDebug
```

调试 APK 输出：

```text
app/build/outputs/apk/debug/app-debug.apk
```

GitHub Actions 会在 `android-app` 分支提交时自动运行单元测试、Lint 和 APK 构建，并上传 `emoji-classroom-debug-apk` 构建产物。构建成功后还会将最新 APK 发布到：

```text
dist/emoji-classroom-checker-debug.apk
```

## 5 连接后端

### 5.1 Android 模拟器

先在电脑启动原项目：

```powershell
Set-Location D:\Program\software\emoji-classroom-checker
npm start
```

模拟器在应用的“服务器设置”中填写：

```text
http://10.0.2.2:3000
```

### 5.2 安卓真机

1. 手机和电脑连接同一个 Wi-Fi；
2. 运行 `scripts/find-server-address.ps1` 获取电脑局域网 IPv4；
3. 启动原项目后端；
4. Windows 防火墙允许 Node.js 或 TCP 3000 端口；
5. 在应用“服务器设置”填写 `http://电脑IPv4:3000`。

示例：

```text
http://192.168.1.10:3000
```

手机浏览器能打开该地址时，Android App 通常也可以连接。

## 6 摄像头与 AI

1. 原项目的 Node 后端和 FastAPI AI 服务均需运行；
2. 使用教师或管理员账号登录；
3. 进入“AI 摄像头”，选择有权限的课堂；
4. 点击打开预览，允许 Android 摄像头权限；
5. 使用单帧或连续检测；
6. 离开页面或点击停止后，网页会停止摄像头轨道。

App 仅向配置服务器的同源页面授予视频采集权限，不授予麦克风权限。原始视频仍由原系统在内存中处理，不写入安卓工程。

## 7 网络安全

为了连接课堂局域网中的 `http://IP:3000`，调试版本允许明文 HTTP。公开网络或正式部署应配置 HTTPS，并把服务器地址改为 HTTPS 域名。不要在不可信 Wi-Fi 中使用明文 HTTP 传输账号和 JWT。

## 8 文档

- [架构设计](docs/architecture.md)
- [构建与安装](docs/build-and-install.md)
- [测试指南](docs/test-guide.md)
