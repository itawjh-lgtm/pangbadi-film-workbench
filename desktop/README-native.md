# 庞巴迪影视工作台 Mac 客户端

原生外壳使用 AppKit + WKWebView，沿用现有工作台页面与本机 Python 执行服务。客户端不下载 Chromium，不需要 Electron。当前构建面向这台 Mac；应用配置中的 Python 和项目目录仍由本机提供，不是可直接分发给其他电脑的安装包。

显示名称已统一为「庞巴迪影视工作台」。为保留 Dock、WebKit 缓存和已有安装路径，应用包与 Bundle ID 仍沿用原名。

## 日常操作

- 双击「造梦工作室.app」打开独立窗口。启动时自动检查后台；后台可用后恢复工作台。
- ⌘R 刷新页面，⇧⌘R 重新连接后台。
- ⌘+ / ⌘− 调整页面大小，⌘0 恢复。
- ⌘[ / ⌘] 后退、前进。
- 「显示 → 显示数据文件夹」打开本机数据所在位置。
- 「显示 → 查看启动与运行日志」显示日志末尾内容；再次使用该菜单会刷新日志。
- 「显示 → 在浏览器中打开」进入同一个本机工作台地址。
- 「显示 → 打开在线试用（浏览器）」进入独立云端工作台。云端按登录账号保存，使用访客自己的模型 API Key；本机项目不会自动上传。
- 关闭窗口后应用保留在 Dock；点击 Dock 图标重新打开窗口。
- ⌘Q 退出客户端。后台执行服务与已有 AI 任务继续运行，不会因关闭窗口而被中断。电脑关机或休眠仍会影响本机执行。

成果下载会出现 macOS 保存对话框，可自行选择目录。文件完整下载后才替换已确认的同名文件。保存成功会在 Finder 中选中该文件；下载内容不会自动执行。RunningHub 等外部链接在系统默认浏览器中打开。

## 启动契约

应用读取 `Contents/Resources/DesktopConfig.json`：

```json
{
  "projectRoot": "/absolute/path/to/workbench",
  "pythonExecutable": "/absolute/path/to/python3",
  "port": 8767,
  "backendVersion": "0.6"
}
```

启动通过 `Process` 参数数组调用：

```text
pythonExecutable projectRoot/desktop/service_manager.py ensure --project-root projectRoot --port 8767
```

服务管理器以 JSON 行返回 `ok`、`url`、`owned`、`reason`、`pid`。客户端仅加载配置端口上的 `http://127.0.0.1` 或 `http://localhost`；不依据网页内容启动进程或选择可执行文件。

数据目录固定为 `projectRoot/data/runtime`；日志固定为其中的 `server.log`。客户端只读这些日志，不通过网页暴露文件读取权限。

## 原生构建

需要本机 Apple Command Line Tools / Swift。当前源码最低部署目标 macOS 12，本机构建面向 Apple Silicon（arm64）。

在项目目录运行 `python3 desktop/build.py`，即可重建 `dist/造梦工作室.app`。构建脚本会生成本机配置、绘制图标、编译原生程序、执行 ad-hoc 本机签名并验证。默认 Python 为 `/Library/Frameworks/Python.framework/Versions/3.14/bin/python3`，可用 `--python` 指定其他已安装的绝对路径。

重建成功前保留旧应用；替换时将旧应用移动到 `dist/backups/`，不会覆盖项目数据。固定 Bundle ID 和 designated requirement 保持客户端身份一致。应用复制到其他位置后仍引用原项目，因此请保留原项目目录。

运行 `python3 desktop/install.py` 可将已构建应用安装至 `~/Applications/造梦工作室.app`。同名旧客户端会保留至 `~/Applications/造梦工作室旧版本/`；不会替换身份不符的应用。安装脚本复制应用内容而不传播 Documents 文件提供器附加的 Finder 元数据，并再次验证本地签名。

以下是构建脚本使用的核心编译命令：

```sh
xcrun swiftc -parse-as-library \
  -target arm64-apple-macosx12.0 \
  -module-cache-path /tmp/dream-studio-module-cache \
  -framework AppKit -framework WebKit \
  desktop/Sources/StudioApp.swift \
  -o '造梦工作室.app/Contents/MacOS/DreamStudio'
```

应用还需要 `desktop/Info.plist`、上述 `DesktopConfig.json` 和可选的 `AppIcon.icns`。Swift 源码不包含模型密钥或 RunningHub 密钥。发布给其他用户前仍需处理依赖安装、身份认证、签名与公证。

## 权限与导航

- 使用稳定 Bundle ID `cn.dreamstudio.workbench` 与 WebKit 持久存储。
- 不注册 JavaScript → shell / 文件系统消息桥。
- 页面只导航到固定本机端口；禁止 `file:`、`javascript:` 和未知本机服务导航。
- 仅用户点击的外部 HTTP/HTTPS 链接交给系统浏览器；脚本重定向不会启动外部应用。
- 下载只接受同源资源或同源 Blob，并由原生保存面板决定目标位置。
- 连接失败时显示原生错误与重试入口；不会把空白页或示例数据当成服务已接通。
