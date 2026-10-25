import AppKit
import WebKit

// The native layer starts one trusted local service and presents its UI. It has no
// JavaScript message handlers, shell bridge, or arbitrary-file navigation API.
struct DesktopConfiguration: Decodable {
    let projectRoot: String
    let pythonExecutable: String
    let port: Int
    let backendVersion: String

    static func load() throws -> DesktopConfiguration {
        guard let url = Bundle.main.url(forResource: "DesktopConfig", withExtension: "json") else {
            throw NativeError.message("客户端配置缺失，请重新运行项目内的客户端构建脚本。")
        }
        let value = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
        guard value.projectRoot.hasPrefix("/"), value.pythonExecutable.hasPrefix("/"),
              (1024...65535).contains(value.port), !value.backendVersion.isEmpty else {
            throw NativeError.message("客户端配置无效，请重新构建客户端。")
        }
        return value
    }
    var rootURL: URL { URL(fileURLWithPath: projectRoot, isDirectory: true) }
    var dataURL: URL { rootURL.appendingPathComponent("data/runtime", isDirectory: true) }
    var logURL: URL { dataURL.appendingPathComponent("server.log") }
    var homeURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    func isLocal(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "http" &&
        ["127.0.0.1", "localhost"].contains(url.host?.lowercased() ?? "") &&
        url.port == port && url.user == nil && url.password == nil
    }
    func isLocalBlob(_ url: URL) -> Bool {
        guard url.scheme == "blob", let origin = URL(string: String(url.absoluteString.dropFirst(5))) else { return false }
        return isLocal(origin)
    }
}

enum NativeError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(text) = self { return text }; return nil }
}

struct ServiceResult: Decodable {
    let ok: Bool
    let url: String?
    let owned: Bool?
    let reason: String?
    let pid: Int?
}

final class DownloadRecord {
    let download: WKDownload
    let temporaryURL: URL
    let chosenURL: URL
    init(_ download: WKDownload, temporaryURL: URL, chosenURL: URL) {
        self.download = download; self.temporaryURL = temporaryURL; self.chosenURL = chosenURL
    }
}

final class StudioDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var configuration: DesktopConfiguration?
    private var window: NSWindow!
    private var webView: WKWebView!
    private var overlay: NSView!
    private var headline: NSTextField!
    private var detail: NSTextField!
    private var spinner: NSProgressIndicator!
    private var retryButton: NSButton!
    private var logWindow: NSWindow?
    private var logText: NSTextView?
    private var lastStartupError = ""
    private var starting = false
    private var startupAttempt = 0
    private var downloads: [ObjectIdentifier: DownloadRecord] = [:]
    private var activeDownloads: [ObjectIdentifier: WKDownload] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeMenu()
        makeWindow()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startService()
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }
    func applicationWillTerminate(_ notification: Notification) {
        // Deliberately do not terminate the shared service or in-progress AI runs.
        for download in activeDownloads.values { download.cancel { _ in } }
    }

    private func makeMenu() {
        let bar = NSMenu()
        let appItem = NSMenuItem(); bar.addItem(appItem)
        let app = NSMenu(); appItem.submenu = app
        app.addItem(item("关于造梦工作室", #selector(showAbout), ""))
        app.addItem(.separator())
        app.addItem(item("隐藏造梦工作室", #selector(NSApplication.hide(_:)), "h", target: NSApp))
        app.addItem(item("隐藏其他", #selector(NSApplication.hideOtherApplications(_:)), "h", modifiers: [.command, .option], target: NSApp))
        app.addItem(item("全部显示", #selector(NSApplication.unhideAllApplications(_:)), "", target: NSApp))
        app.addItem(.separator())
        app.addItem(item("退出客户端（后台任务继续）", #selector(NSApplication.terminate(_:)), "q", target: NSApp))

        let editItem = NSMenuItem(); bar.addItem(editItem)
        let edit = NSMenu(title: "编辑"); editItem.submenu = edit
        edit.addItem(item("撤销", Selector(("undo:")), "z", target: nil))
        edit.addItem(item("重做", Selector(("redo:")), "z", modifiers: [.command, .shift], target: nil))
        edit.addItem(.separator())
        for (title, action, key) in [("剪切", "cut:", "x"), ("拷贝", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(item(title, Selector(action), key, target: nil))
        }

        let viewItem = NSMenuItem(); bar.addItem(viewItem)
        let view = NSMenu(title: "显示"); viewItem.submenu = view
        view.addItem(item("刷新工作台", #selector(reload), "r"))
        view.addItem(item("重新检查后台连接", #selector(reconnect), "r", modifiers: [.command, .shift]))
        view.addItem(item("后退", #selector(goBack), "["))
        view.addItem(item("前进", #selector(goForward), "]"))
        view.addItem(.separator())
        view.addItem(item("放大", #selector(zoomIn), "="))
        view.addItem(item("缩小", #selector(zoomOut), "-"))
        view.addItem(item("实际大小", #selector(resetZoom), "0"))
        view.addItem(.separator())
        view.addItem(item("在浏览器中打开", #selector(openInBrowser), "b", modifiers: [.command, .shift]))
        view.addItem(item("显示数据文件夹", #selector(revealData), "d", modifiers: [.command, .shift]))
        view.addItem(item("查看启动与运行日志", #selector(showLogs), "l", modifiers: [.command, .shift]))

        let windowItem = NSMenuItem(); bar.addItem(windowItem)
        let windowMenu = NSMenu(title: "窗口"); windowItem.submenu = windowMenu
        windowMenu.addItem(item("最小化", #selector(NSWindow.performMiniaturize(_:)), "m", target: nil))
        windowMenu.addItem(item("缩放窗口", #selector(NSWindow.performZoom(_:)), "", target: nil))
        windowMenu.addItem(item("关闭窗口", #selector(NSWindow.performClose(_:)), "w", target: nil))
        NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = bar
    }

    private func item(_ title: String, _ action: Selector, _ key: String, modifiers: NSEvent.ModifierFlags = [.command], target: AnyObject? = nil) -> NSMenuItem {
        let result = NSMenuItem(title: title, action: action, keyEquivalent: key)
        result.keyEquivalentModifierMask = modifiers
        let responderActions = ["undo:", "redo:", "cut:", "copy:", "paste:", "selectAll:", "performMiniaturize:", "performZoom:", "performClose:"]
        result.target = target ?? (responderActions.contains(NSStringFromSelector(action)) ? nil : self)
        return result
    }

    private func makeWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 940), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "造梦工作室"
        window.subtitle = "影视 · 游戏 · 你的创作团队"
        window.minSize = NSSize(width: 1040, height: 700)
        window.setFrameAutosaveName("DreamStudioMainWindow")
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        let webConfig = WKWebViewConfiguration()
        webConfig.websiteDataStore = .default()
        webConfig.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: webConfig)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.pageZoom = max(0.75, min(1.5, UserDefaults.standard.double(forKey: "pageZoom") == 0 ? 1 : UserDefaults.standard.double(forKey: "pageZoom")))
        webView.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        window.contentView = content
        content.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor), webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor), webView.bottomAnchor.constraint(equalTo: content.bottomAnchor)
        ])
        overlay = NSView(); overlay.translatesAutoresizingMaskIntoConstraints = false
        overlay.wantsLayer = true; overlay.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        content.addSubview(overlay)
        NSLayoutConstraint.activate([
            overlay.leadingAnchor.constraint(equalTo: content.leadingAnchor), overlay.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: content.topAnchor), overlay.bottomAnchor.constraint(equalTo: content.bottomAnchor)
        ])
        let brand = NSTextField(labelWithString: "造梦工作室")
        brand.font = .systemFont(ofSize: 18, weight: .medium)
        brand.textColor = .secondaryLabelColor
        headline = NSTextField(labelWithString: "正在打开你的创作团队")
        headline.font = .systemFont(ofSize: 27, weight: .semibold)
        headline.alignment = .center
        detail = NSTextField(wrappingLabelWithString: "正在检查本机服务和项目数据…")
        detail.font = .systemFont(ofSize: 14)
        detail.textColor = .secondaryLabelColor
        detail.alignment = .center
        detail.maximumNumberOfLines = 8
        spinner = NSProgressIndicator(); spinner.style = .spinning
        spinner.controlSize = .regular; spinner.isDisplayedWhenStopped = false
        retryButton = NSButton(title: "重新连接", target: self, action: #selector(reconnect))
        retryButton.bezelStyle = .rounded
        let logs = NSButton(title: "查看日志", target: self, action: #selector(showLogs)); logs.bezelStyle = .rounded
        let buttons = NSStackView(views: [retryButton, logs]); buttons.orientation = .horizontal; buttons.spacing = 12
        let stack = NSStackView(views: [brand, headline, detail, spinner, buttons])
        stack.orientation = .vertical; stack.spacing = 22; stack.alignment = .centerX
        stack.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: overlay.centerXAnchor), stack.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
            stack.widthAnchor.constraint(equalToConstant: 560), detail.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])
    }

    @objc private func reconnect() { startService() }
    private func startService() {
        guard !starting else { return }
        do { configuration = try DesktopConfiguration.load() }
        catch { showFailure(error.localizedDescription); return }
        guard let config = configuration else { return }
        starting = true; startupAttempt += 1
        let attempt = startupAttempt
        overlay.isHidden = false; retryButton.isEnabled = false
        headline.stringValue = "正在打开你的创作团队"
        detail.stringValue = "正在连接本机执行服务，已有项目和成果会自动恢复。"
        spinner.startAnimation(nil)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: config.pythonExecutable)
            process.arguments = [config.rootURL.appendingPathComponent("desktop/service_manager.py").path, "ensure", "--project-root", config.projectRoot, "--port", String(config.port)]
            process.currentDirectoryURL = config.rootURL
            process.standardInput = FileHandle.nullDevice
            let output = Pipe()
            process.standardOutput = output; process.standardError = output
            var outcome: Result<ServiceResult, Error>
            do {
                try process.run()
                // The manager has its own bounded health checks; this is a final
                // escape hatch for an unresponsive executable, not the AI service.
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 50) {
                    if process.isRunning { process.terminate() }
                }
                let data = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                let text = String(decoding: data.suffix(32768), as: UTF8.self)
                let result = text.split(separator: "\n").reversed().compactMap { line in
                    try? JSONDecoder().decode(ServiceResult.self, from: Data(line.utf8))
                }.first
                if let result { outcome = .success(result) }
                else { outcome = .failure(NativeError.message("本机服务未能返回启动结果。\n" + String(text.suffix(1200)))) }
            } catch { outcome = .failure(error) }
            DispatchQueue.main.async { self?.finishStart(outcome, attempt: attempt) }
        }
    }
    private func finishStart(_ result: Result<ServiceResult, Error>, attempt: Int) {
        guard attempt == startupAttempt else { return }
        starting = false; retryButton.isEnabled = true
        switch result {
        case .success(let service):
            guard service.ok, let address = service.url, let url = URL(string: address), configuration?.isLocal(url) == true else {
                showFailure(service.reason ?? "工作台服务暂不可用，请查看日志后重试。")
                return
            }
            headline.stringValue = "正在恢复工作台"
            detail.stringValue = "加载项目、团队和最近的创作记录。"
            webView.load(URLRequest(url: url))
        case .failure(let error): showFailure(error.localizedDescription)
        }
    }
    private func showFailure(_ message: String) {
        starting = false; lastStartupError = message
        overlay.isHidden = false; spinner.stopAnimation(nil); retryButton.isEnabled = true
        headline.stringValue = "工作台暂时没有连上"
        detail.stringValue = message
    }
    @objc private func reload() {
        if overlay.isHidden { webView.reload() } else { startService() }
    }
    @objc private func goBack() { if webView.canGoBack { webView.goBack() } }
    @objc private func goForward() { if webView.canGoForward { webView.goForward() } }
    @objc private func zoomIn() { setZoom(webView.pageZoom + 0.1) }
    @objc private func zoomOut() { setZoom(webView.pageZoom - 0.1) }
    @objc private func resetZoom() { setZoom(1) }
    private func setZoom(_ value: Double) { webView.pageZoom = min(1.5, max(0.75, value)); UserDefaults.standard.set(webView.pageZoom, forKey: "pageZoom") }
    @objc private func openInBrowser() { if let url = configuration?.homeURL { NSWorkspace.shared.open(url) } }
    @objc private func revealData() {
        guard let config = configuration else { return }
        let url = FileManager.default.fileExists(atPath: config.dataURL.path) ? config.dataURL : config.rootURL
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
    @objc private func showAbout() {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "造梦工作室", .applicationVersion: "0.5", .version: "Mac 本地客户端",
            .credits: NSAttributedString(string: "21 位创作伙伴 · 本机保存项目\n退出客户端后，本机后台中的任务继续执行。\nAI 创作与 RunningHub 生成需要联网。")
        ])
    }
    @objc private func showLogs() {
        if logWindow == nil {
            let logs = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 880, height: 560), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            logs.title = "造梦工作室 · 启动与运行日志"; logs.isReleasedWhenClosed = false
            let scroll = NSScrollView(frame: logs.contentView!.bounds); scroll.autoresizingMask = [.width, .height]; scroll.hasVerticalScroller = true
            let text = NSTextView(frame: scroll.bounds)
            text.isEditable = false; text.isSelectable = true; text.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
            text.autoresizingMask = [.width]; text.textContainerInset = NSSize(width: 18, height: 18)
            text.textContainer?.widthTracksTextView = true
            scroll.documentView = text; logs.contentView?.addSubview(scroll)
            logWindow = logs; logText = text; logs.center()
        }
        var text = "造梦工作室 · 本机诊断\n\n"
        if !lastStartupError.isEmpty { text += "最近启动错误：\n\(lastStartupError)\n\n" }
        if let config = configuration {
            text += "项目：\(config.projectRoot)\n地址：\(config.homeURL.absoluteString)\n数据：\(config.dataURL.path)\n日志：\(config.logURL.path)\n\n"
            if let file = try? FileHandle(forReadingFrom: config.logURL) {
                defer { try? file.close() }
                let size = (try? file.seekToEnd()) ?? 0
                try? file.seek(toOffset: size > 131072 ? size - 131072 : 0)
                text += String(decoding: (try? file.readToEnd()) ?? Data(), as: UTF8.self)
            } else { text += "暂无运行日志。服务首次启动后会在这里显示。" }
        } else { text += "客户端配置暂不可用。" }
        logText?.string = text
        logText?.scrollToEndOfDocument(nil)
        logWindow?.makeKeyAndOrderFront(nil)
    }

    private func isExternalWebsite(_ url: URL) -> Bool {
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? ""), let host = url.host?.lowercased(),
              url.user == nil, url.password == nil else { return false }
        // Local services never escape the exact-origin check, even through links.
        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") || host.contains(":") { return false }
        let numbers = host.split(separator: ".").compactMap { Int($0) }
        if numbers.count == 4 {
            if [0, 10, 127].contains(numbers[0]) || (numbers[0] == 169 && numbers[1] == 254) ||
                (numbers[0] == 192 && numbers[1] == 168) || (numbers[0] == 172 && (16...31).contains(numbers[1])) { return false }
        }
        return !host.isEmpty
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let config = configuration else { decisionHandler(.cancel); return }
        if config.isLocal(url) {
            if navigationAction.shouldPerformDownload { decisionHandler(.download) }
            else if navigationAction.targetFrame == nil { decisionHandler(.cancel); webView.load(navigationAction.request) }
            else { decisionHandler(.allow) }
        } else if config.isLocalBlob(url), navigationAction.shouldPerformDownload {
            decisionHandler(.download)
        } else {
            decisionHandler(.cancel)
            // Do not let scripts and redirects repeatedly launch external apps.
            if navigationAction.navigationType == .linkActivated && isExternalWebsite(url) { NSWorkspace.shared.open(url) }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard let url = navigationResponse.response.url, let config = configuration, config.isLocal(url) || config.isLocalBlob(url) else { decisionHandler(.cancel); return }
        if let response = navigationResponse.response as? HTTPURLResponse, response.statusCode >= 400, navigationResponse.isForMainFrame {
            decisionHandler(.cancel); showFailure("工作台页面返回 HTTP \(response.statusCode)，请重新连接。")
        } else if !navigationResponse.canShowMIMEType { decisionHandler(.download) }
        else { decisionHandler(.allow) }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let url = webView.url, configuration?.isLocal(url) == true else { return }
        overlay.isHidden = true; spinner.stopAnimation(nil); lastStartupError = ""
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { showFailure("无法加载本机工作台：\(error.localizedDescription)") }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { showFailure("页面连接中断：\(error.localizedDescription)") }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { showFailure("页面进程已关闭。点击重新连接即可恢复已保存的数据。") }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard configuration?.isLocal(frame.request.url ?? URL(string: "about:blank")!) == true else { completionHandler(); return }
        let alert = NSAlert(); alert.messageText = "造梦工作室"; alert.informativeText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard configuration?.isLocal(frame.request.url ?? URL(string: "about:blank")!) == true else { completionHandler(false); return }
        let alert = NSAlert(); alert.messageText = "请确认操作"; alert.informativeText = message
        alert.addButton(withTitle: "确认"); alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard configuration?.isLocal(frame.request.url ?? URL(string: "about:blank")!) == true else { completionHandler(nil); return }
        let alert = NSAlert(); alert.messageText = prompt
        let field = NSTextField(string: defaultText ?? ""); field.frame = NSRect(x: 0, y: 0, width: 360, height: 24); alert.accessoryView = field
        alert.addButton(withTitle: "确认"); alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard configuration?.isLocal(frame.request.url ?? URL(string: "about:blank")!) == true else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = parameters.allowsDirectories; panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { register(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { register(download) }
    private func register(_ download: WKDownload) { activeDownloads[ObjectIdentifier(download)] = download; download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let identifier = ObjectIdentifier(download)
        guard let url = response.url, let config = configuration, config.isLocal(url) || config.isLocalBlob(url) else {
            activeDownloads.removeValue(forKey: identifier); completionHandler(nil); return
        }
        let panel = NSSavePanel(); panel.title = "保存工作台成果"; panel.prompt = "保存"
        let cleaned = (suggestedFilename as NSString).lastPathComponent.filter { !$0.isNewline && !$0.isASCIIControl }
        panel.nameFieldStringValue = cleaned.isEmpty ? "工作台成果.txt" : cleaned
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] result in
            guard result == .OK, let destination = panel.url, let self else {
                self?.activeDownloads.removeValue(forKey: identifier); completionHandler(nil); return
            }
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("dream-studio-download-\(UUID().uuidString)", isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let temp = folder.appendingPathComponent("payload")
                self.downloads[identifier] = DownloadRecord(download, temporaryURL: temp, chosenURL: destination)
                completionHandler(temp)
            } catch { self.activeDownloads.removeValue(forKey: identifier); completionHandler(nil); self.showDownloadError(error.localizedDescription) }
        }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        guard let url = request.url, configuration?.isLocal(url) == true else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
    func downloadDidFinish(_ download: WKDownload) {
        let identifier = ObjectIdentifier(download)
        activeDownloads.removeValue(forKey: identifier)
        guard let record = downloads.removeValue(forKey: identifier) else { return }
        defer { try? FileManager.default.removeItem(at: record.temporaryURL.deletingLastPathComponent()) }
        let staging = record.chosenURL.deletingLastPathComponent().appendingPathComponent(".dream-studio-save-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: staging) }
        do {
            try FileManager.default.copyItem(at: record.temporaryURL, to: staging)
            if FileManager.default.fileExists(atPath: record.chosenURL.path) {
                _ = try FileManager.default.replaceItemAt(record.chosenURL, withItemAt: staging)
            } else { try FileManager.default.moveItem(at: staging, to: record.chosenURL) }
            NSWorkspace.shared.activateFileViewerSelecting([record.chosenURL])
        } catch { showDownloadError("文件下载完成，但无法保存到所选位置：\(error.localizedDescription)") }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let identifier = ObjectIdentifier(download)
        activeDownloads.removeValue(forKey: identifier)
        if let record = downloads.removeValue(forKey: identifier) { try? FileManager.default.removeItem(at: record.temporaryURL.deletingLastPathComponent()) }
        if (error as NSError).code != NSURLErrorCancelled { showDownloadError(error.localizedDescription) }
    }
    private func showDownloadError(_ message: String) {
        let alert = NSAlert(); alert.messageText = "成果暂未保存"; alert.informativeText = message
        alert.beginSheetModal(for: window)
    }
}

private extension Character {
    var isASCIIControl: Bool { unicodeScalars.contains { $0.value < 32 || $0.value == 127 } }
}

@main
struct DreamStudioApplication {
    static func main() {
        let app = NSApplication.shared
        let delegate = StudioDelegate()
        app.setActivationPolicy(.regular)
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
