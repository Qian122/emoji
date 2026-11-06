# 构建与安装

## 1 Android Studio

1. 安装 Android Studio，并在 SDK Manager 中安装 Android SDK Platform 35；
2. 选择 JDK 17；
3. 使用“Open”打开 `emoji-classroom-checker-android`；
4. 等待 Gradle Sync 完成；
5. 运行 `app` 配置到模拟器或 USB 调试真机。

## 2 命令行

```powershell
.\gradlew.bat testDebugUnitTest
.\gradlew.bat lintDebug
.\gradlew.bat assembleDebug
```

安装到已连接设备：

```powershell
adb install -r .\app\build\outputs\apk\debug\app-debug.apk
```

## 3 发布签名

正式 APK/AAB 使用团队自己的 Android Keystore。Keystore、密码和 `keystore.properties` 已被 `.gitignore` 排除，不进入仓库。调试和课程演示可以使用自动生成的 debug 签名 APK。

## 4 GitHub Actions 构建产物

`android-app` 分支每次推送自动执行：

1. 设置 JDK 17；
2. 缓存和配置 Gradle；
3. 执行 JVM 单元测试；
4. 执行 Android Lint；
5. 构建 debug APK；
6. 上传 APK Artifact。

在 GitHub 仓库的 Actions 页面打开对应运行记录，可在 Artifacts 区域下载 APK。
