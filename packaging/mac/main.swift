// Kiki's native window shell.
// Two modes (chosen on first launch, changeable anytime via the "Connect to…" menu, front end and back end separated just like Hermes's remote gateway):
//   Local: run Kiki on this computer—register the launchd background service, wait for it to come up, then show the UI in the window
//   Remote: act as the UI only, connecting to Kiki on another computer (e.g. https://mac-mini.xxx.ts.net over Tailscale); nothing runs in the background locally
// Closing the window doesn't stop the service; click the Dock icon to reopen. External links open in the default browser.
import Cocoa
import WebKit

// Same background color as the web page, so there's no color mismatch between the title bar and the page
let pageBackground = NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        ? NSColor(srgbRed: 0.098, green: 0.098, blue: 0.106, alpha: 1)
        : NSColor.white
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var base = URL(string: "http://localhost:4567")!  // the Kiki currently connected to
    var loaded = false
    var generation = 0  // invalidates stale waits/retries when switching connections
    var lastConnectError = ""  // reason for the most recent connection failure, shown in the "can't connect" dialog
    // Splash page (public/splash.html): only enter the main UI after the intro animation finishes and the backend is ready
    var splashOn = false      // whether the window currently shows the splash page
    var splashReady = false   // splash page finished loading; its kikiSplash.* can be called
    var splashStatus = ""     // text to show, recorded while the splash page is still loading
    var splashPlayed = false  // the intro animation has already played this launch (don't replay on reconnect)
    var leaveGen = -1         // which connection's splash page is currently waiting to finish

    // Intro animation (can be turned off via the "View → Intro Animation" menu)
    var introOn: Bool {
        get { UserDefaults.standard.object(forKey: "intro") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "intro") }
    }
    var introItem: NSMenuItem?
    // Whether it was full screen when last closed: if so, reopen full screen
    var wasFullScreen: Bool {
        get { UserDefaults.standard.bool(forKey: "fullscreen") }
        set { UserDefaults.standard.set(newValue, forKey: "fullscreen") }
    }

    // Saved choice: "local" or a remote address; nil means nothing chosen yet
    var server: String? {
        get { UserDefaults.standard.string(forKey: "server") }
        set { UserDefaults.standard.set(newValue, forKey: "server") }
    }
    var isRemote: Bool { server != nil && server != "local" }

    // Appearance: "system" / "light" / "dark". The web page (Settings → Appearance) sends a message when it changes, and the title bar follows
    var theme: String {
        get { UserDefaults.standard.string(forKey: "theme") ?? "system" }
        set { UserDefaults.standard.set(newValue, forKey: "theme") }
    }
    var themeItems: [NSMenuItem] = []

    func applyTheme() {
        switch theme {
        case "light": window?.appearance = NSAppearance(named: .aqua)
        case "dark": window?.appearance = NSAppearance(named: .darkAqua)
        default: window?.appearance = nil
        }
        for item in themeItems { item.state = (item.representedObject as? String) == theme ? .on : .off }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "kikiWindow", let v = message.body as? String { windowAction(v); return }
        if message.name == "kikiConnect", let v = message.body as? String { pickFromWelcome(v); return }
        if message.name == "kikiSave", let v = message.body as? [String: Any] { saveFile(v); return }
        guard message.name == "kikiTheme", let v = message.body as? String, ["system", "light", "dark"].contains(v) else { return }
        theme = v
        applyTheme()
    }

    // The title bar is transparent and the web page fills the whole window, so dragging and double-clicking the blank area at the top is reported here by the page
    func windowAction(_ v: String) {
        switch v {
        case "drag":
            if let e = NSApp.currentEvent, e.type == .leftMouseDown || e.type == .leftMouseDragged { window.performDrag(with: e) }
        case "zoom":
            // Follow the "System Settings → Desktop & Dock → Double-click a window's title bar to" choice
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window.performMiniaturize(nil)
            case "None": break
            default: window.zoom(nil)
            }
        case "fullscreen":
            window.toggleFullScreen(nil)
        case "splash-done":
            // The splash page's closing animation has finished; swap in the real UI
            if leaveGen == generation { leaveGen = -1; webView.load(URLRequest(url: base)) }
        default: break
        }
    }

    // Menu "View → Appearance": let the web page make the change (the page remembers the choice and sends a message back)
    @objc func pickTheme(_ sender: NSMenuItem) {
        guard let v = sender.representedObject as? String else { return }
        theme = v
        applyTheme()
        webView.evaluateJavaScript("window.kikiTheme && kikiTheme.set('\(v)')", completionHandler: nil)
    }

    // Menu "Settings…" (⌘,): open the settings dialog in the web page
    @objc func openSettings(_ sender: Any?) {
        webView.evaluateJavaScript("window.kikiOpenSettings && kikiOpenSettings()", completionHandler: nil)
    }

    // When double-clicked directly inside the .dmg, or opened from Downloads, macOS runs the app from a temporary read-only location (App Translocation).
    // In that case the registered background service points to a path that disappears when the disk is ejected or the machine restarts, and auto-update can't replace the app either, so first ask the user to drag it into Applications.
    func runningFromTemporaryPlace() -> Bool {
        let path = Bundle.main.bundlePath
        return path.hasPrefix("/Volumes/") || path.contains("/AppTranslocation/")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if runningFromTemporaryPlace() {
            NSApp.activate(ignoringOtherApps: true)
            let a = NSAlert()
            a.messageText = "Please drag Kiki into Applications first"
            a.informativeText = """
            Kiki needs to keep running in the background and update itself, so it can't be opened directly from the install disk or the Downloads folder. \
            Drag Kiki into the Applications folder and open it from there.
            """
            a.addButton(withTitle: "Open the Applications Folder")
            a.addButton(withTitle: "Quit")
            if a.runModal() == .alertFirstButtonReturn {
                NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications"))
            }
            NSApp.terminate(nil)
            return
        }
        buildMenu()
        buildWindow()
        if wasFullScreen { window.toggleFullScreen(nil) }
        if server == nil {
            if !loadSplash(mode: "welcome", status: "") { showSplash(""); chooseServer(firstTime: true) }
        } else {
            connect()
        }
        // When connected remotely, the backend's auto-update can't reach here: check once after launch, then every 6 hours
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { if self.isRemote { self.checkClientUpdate(manual: false) } }
        Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { _ in
            if self.isRemote { self.checkClientUpdate(manual: false) }
        }
    }

    func connect() {
        lastConnectError = ""
        generation += 1
        loaded = false
        if isRemote, let url = normalizedRemote(server!) ?? URL(string: server!) {
            base = url
            showSplash("Connecting to \(url.host ?? "")…")
            waitForServer(tries: 0, gen: generation)
        } else {
            showSplash("Starting Kiki…")
            startBackend(gen: generation)
        }
    }

    // MARK: Choosing which Kiki to connect to

    @objc func changeServer(_ sender: Any?) { chooseServer(firstTime: false) }

    func chooseServer(firstTime: Bool, error: String? = nil) {
        let a = NSAlert()
        a.messageText = firstTime ? "Welcome to Kiki" : "Which Kiki do you want to connect to?"
        a.informativeText = (error.map { $0 + "\n\n" } ?? "") + """
        If this is your first time, just choose "Run on this computer." \
        If Kiki is already running on another computer (say, a Mac mini at home), you can also use this as just the UI: enter that computer's address, then click "Connect to Remote Address." \
        When connecting remotely, both computers need Tailscale running, and the address looks like https://mac-mini.xxx.ts.net
        """
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 340, height: 24))
        field.placeholderString = "Remote address (optional), e.g. https://mac-mini.xxx.ts.net"
        if isRemote { field.stringValue = server! }
        a.accessoryView = field
        // The first button is the default button (pressing Return triggers it): new users press Return to run locally; those already connected remotely press Return to stay remote
        let remoteFirst = isRemote
        a.addButton(withTitle: remoteFirst ? "Connect to Remote Address" : "Run on This Computer")
        a.addButton(withTitle: remoteFirst ? "Run on This Computer" : "Connect to Remote Address")
        if !firstTime { a.addButton(withTitle: "Cancel") }
        if remoteFirst { a.window.initialFirstResponder = field }
        a.beginSheetModal(for: window) { r in
            let local: NSApplication.ModalResponse = remoteFirst ? .alertSecondButtonReturn : .alertFirstButtonReturn
            let remote: NSApplication.ModalResponse = remoteFirst ? .alertFirstButtonReturn : .alertSecondButtonReturn
            switch r {
            case local:
                self.server = "local"
                self.connect()
            case remote:
                guard let url = self.normalizedRemote(field.stringValue) else {
                    DispatchQueue.main.async { self.chooseServer(firstTime: firstTime, error: "That address doesn't look right.") }
                    return
                }
                self.server = url.absoluteString
                self.connect()
            default:
                break
            }
        }
    }

    // The welcome page on the splash screen made a choice: "local" or "remote:<address>"
    func pickFromWelcome(_ v: String) {
        if v == "local" { server = "local"; connect(); return }
        guard v.hasPrefix("remote:") else { return }
        guard let url = normalizedRemote(String(v.dropFirst(7))) else {
            webView.evaluateJavaScript("kikiSplash.error('That address doesn't look right; it should look like https://mac-mini.xxx.ts.net')", completionHandler: nil)
            return
        }
        server = url.absoluteString
        connect()
    }

    func normalizedRemote(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespaces)
        // If only an IP was entered (e.g. Tailscale's 100.x.x.x:4567), use http: HTTPS certificates only work for .ts.net names, not IPs; Tailscale itself is already encrypted
        if !text.isEmpty && !text.contains("://") {
            let host = text.split(separator: "/").first.map(String.init) ?? text
            let isIp = host.first == "[" || host.split(separator: ":").first.map { $0.allSatisfy { $0.isNumber || $0 == "." } } == true
            text = (isIp ? "http://" : "https://") + text
        }
        while text.hasSuffix("/") { text.removeLast() }
        guard var c = URLComponents(string: text), let host = c.host, ["http", "https"].contains(c.scheme ?? "") else { return nil }
        // IP with no port: Kiki listens directly on 4567 on Tailscale IPs, so fill it in (there's no Kiki on 80/443)
        if c.port == nil && c.scheme == "http" && (host.contains(":") || host.allSatisfy { $0.isNumber || $0 == "." }) { c.port = 4567 }
        return c.url
    }

    // Bring the window back when the Dock icon is clicked
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // MARK: Window

    func buildWindow() {
        let config = WKWebViewConfiguration()
        // Tell the web page it's inside the app (the page can fine-tune styles based on this)
        let script = WKUserScript(
            source: "document.documentElement.classList.add('kiki-app', 'kiki-fullsize')",
            injectionTime: .atDocumentStart, forMainFrameOnly: true)
        config.userContentController.addUserScript(script)
        config.userContentController.add(self, name: "kikiTheme")
        config.userContentController.add(self, name: "kikiWindow")
        config.userContentController.add(self, name: "kikiConnect")
        config.userContentController.add(self, name: "kikiSave")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsBackForwardNavigationGestures = false

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Kiki"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        // The web page extends all the way to the top of the window, with the traffic lights sitting on the left column—no separate title bar strip
        if #available(macOS 11.0, *) { window.titlebarSeparatorStyle = .none }
        window.backgroundColor = pageBackground
        window.minSize = NSSize(width: 720, height: 480)
        window.isReleasedWhenClosed = false
        window.collectionBehavior.insert(.fullScreenPrimary)  // green button / ⌃⌘F enters native macOS full screen
        window.delegate = self
        window.contentView = webView
        applyTheme()
        window.center()
        window.setFrameAutosaveName("KikiMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: Splash screen

    // Show a line of status on the splash screen. If the splash screen is already up, just swap the text without reloading (so the animation doesn't break)
    func showSplash(_ text: String) {
        if splashOn {
            splashStatus = text
            if splashReady { webView.evaluateJavaScript("kikiSplash.status(\(jsString(text)))", completionHandler: nil) }
            return
        }
        if loadSplash(mode: "wait", status: text) { return }
        showPlainSplash(text)
    }

    // Turn a string into a JS literal (escape via a JSON array, then strip the brackets)
    func jsString(_ s: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [s])
        let arr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(arr.dropFirst().dropLast())
    }

    // Read public/splash.html straight from the app bundle (the backend may not be up yet). Returns false if not found, falling back to a simple spinner
    @discardableResult
    func loadSplash(mode: String, status: String) -> Bool {
        let pub = Bundle.main.resourceURL!.appendingPathComponent("app/public")
        let file = pub.appendingPathComponent("splash.html")
        guard var html = try? String(contentsOf: file, encoding: .utf8) else { return false }
        var q: [String: String] = ["mode": mode, "s": status]
        if splashPlayed || !introOn { q["quick"] = "1" }
        if window.styleMask.contains(.fullScreen) || wasFullScreen { q["fs"] = "1" }
        if isRemote { q["remote"] = server }
        // Write the parameters directly into the page instead of appending them to the file:// URL: loadFileURL with a query string fails outright on some machines, leaving the window stuck on a blank page
        var c = URLComponents()
        c.queryItems = q.map { URLQueryItem(name: $0.key, value: $0.value) }
        let inject = "<script>window.KIKI_Q=\(jsString(c.percentEncodedQuery ?? ""))</script>"
        if let r = html.range(of: "<head>") { html.replaceSubrange(r, with: "<head>" + inject) } else { html = inject + html }
        splashPlayed = true
        splashOn = true
        splashReady = false
        splashStatus = status
        webView.loadHTMLString(html, baseURL: file)
        return true
    }

    // Backend is ready: let the splash screen play its outro (self-check ticks, "Welcome back"), then it sends splash-done and we switch views
    func enterApp() {
        loaded = true
        // Splash screen isn't up, or never finished loading: go straight to the main UI, don't leave the window waiting
        guard splashOn, splashReady else { splashOn = false; webView.load(URLRequest(url: base)); return }
        leaveGen = generation
        if splashReady { webView.evaluateJavaScript("kikiSplash.leave()", completionHandler: nil) }
        // In case the splash screen never responds, wait at most 8 seconds
        let gen = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            if self.leaveGen == gen && gen == self.generation { self.windowAction("splash-done") }
        }
    }

    func showPlainSplash(_ text: String) {
        let html = """
        <html><head><meta charset="utf-8"><style>
        html,body{height:100%;margin:0;background:transparent;font:15px -apple-system,"PingFang SC",sans-serif;color:#8a8984}
        body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}
        .s{width:22px;height:22px;border:2.5px solid #5b6cf0;border-top-color:transparent;border-radius:50%;animation:r .8s linear infinite}
        @keyframes r{to{transform:rotate(360deg)}}
        </style></head><body><div class="s"></div><div>\(text)</div>
        <script>document.onmousedown=function(e){if(e.button===0)try{webkit.messageHandlers.kikiWindow.postMessage(e.detail===2?"zoom":"drag")}catch(x){}}</script>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // Splash screen finished loading: apply any status that arrived while loading; if the backend is already ready, let it play the outro. Main UI finished loading: tell it whether we're full screen
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView.url?.isFileURL == true {
            guard splashOn else { return }
            splashReady = true
            webView.evaluateJavaScript("kikiSplash.status(\(jsString(splashStatus)))", completionHandler: nil)
            if leaveGen == generation { webView.evaluateJavaScript("kikiSplash.leave()", completionHandler: nil) }
        } else {
            tellFullScreen()
        }
    }

    // MARK: Full screen

    func windowDidEnterFullScreen(_ notification: Notification) { wasFullScreen = true; tellFullScreen() }
    func windowDidExitFullScreen(_ notification: Notification) { wasFullScreen = false; tellFullScreen() }
    func tellFullScreen() {
        let on = window.styleMask.contains(.fullScreen)
        webView.evaluateJavaScript("document.documentElement.classList.toggle('kiki-fullscreen', \(on)); window.kikiSplash && kikiSplash.fs(\(on))", completionHandler: nil)
    }

    // MARK: Backend service

    func startBackend(gen: Int) {
        let setup = Bundle.main.resourceURL!.appendingPathComponent("kiki-setup")
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = setup
            let out = Pipe()
            p.standardOutput = out
            p.standardError = FileHandle.nullDevice
            try? p.run()
            p.waitUntilExit()
            let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let port = text.split(separator: "\n").last.flatMap { Int($0) } ?? 4567
            DispatchQueue.main.async {
                guard gen == self.generation else { return }
                self.base = URL(string: "http://localhost:\(port)")!
                self.waitForServer(tries: 0, gen: gen)
            }
        }
    }

    func waitForServer(tries: Int, gen: Int) {
        var req = URLRequest(url: base.appendingPathComponent("api/health"))
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { data, resp, err in
            DispatchQueue.main.async {
                guard gen == self.generation else { return }
                if let err = err { self.lastConnectError = err.localizedDescription; NSLog("Kiki connection failed: %@", err.localizedDescription) }
                else if let code = (resp as? HTTPURLResponse)?.statusCode, code != 200 { self.lastConnectError = "Server returned \(code)" }
                let ok = (resp as? HTTPURLResponse)?.statusCode == 200
                    && String(data: data ?? Data(), encoding: .utf8)?.contains("\"ok\":true") == true
                if ok {
                    self.enterApp()
                } else if tries < 60 {
                    if tries == 8 {
                        self.showSplash(self.isRemote
                            ? "Can't reach \(self.base.host ?? "") yet — make sure Tailscale is running on both computers…"
                            : "Kiki is taking a little while to start, hang tight…")
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.waitForServer(tries: tries + 1, gen: gen) }
                } else if self.isRemote {
                    self.showSplash("Can't connect to \(self.base.absoluteString)")
                    self.chooseServer(firstTime: false, error: "Can't connect to \(self.base.absoluteString)." + (self.lastConnectError.isEmpty ? "" : "\nReason: \(self.lastConnectError)\nIf Local Network access is being blocked, go to System Settings → Privacy & Security → Local Network and turn on Kiki."))
                } else {
                    self.showSplash("Kiki failed to start. Logs are in ~/Library/Logs/Kiki/server.log")
                }
            }
        }.resume()
    }

    // When the server restarts (e.g. auto-update) the page drops its connection; reconnect automatically after a moment
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navFailed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navFailed(error) }
    func navFailed(_ error: Error) {
        NSLog("Kiki page failed to load: %@", error.localizedDescription)
        if (error as NSError).code == NSURLErrorCancelled { return }  // superseded by a new load, not a failure
        // The splash screen itself failed to load: switch to a simple spinner page; if the backend is already ready, go straight to the main UI
        if splashOn && !splashReady {
            splashOn = false
            if server == nil { showPlainSplash(""); chooseServer(firstTime: true) }  // first-run welcome page didn't appear: fall back to the system dialog
            else if leaveGen == generation || loaded { leaveGen = -1; webView.load(URLRequest(url: base)) }
            else { showPlainSplash(splashStatus) }
            return
        }
        retryLater()
    }
    func retryLater() {
        guard loaded else { return }
        loaded = false
        showSplash("Reconnecting to Kiki…")
        let gen = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.waitForServer(tries: 0, gen: gen) }
    }

    // MARK: Links

    // Is this one of Kiki's own pages? (if not, hand it to the browser)
    func isKiki(_ url: URL?) -> Bool {
        guard let url = url else { return true }
        if url.scheme == "about" || url.scheme == "data" || url.isFileURL { return true }
        return url.host == base.host && url.port == base.port
    }

    // External links go to the default browser
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, !isKiki(url) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else {
            if navigationAction.targetFrame?.isMainFrame != false, let url = navigationAction.request.url, !url.isFileURL {
                splashOn = false; splashReady = false  // leaving the splash screen
            }
            decisionHandler(.allow)
        }
    }

    // target="_blank" links
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // alert / confirm from the page
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    // The page wants to save a file (e.g. an exported .bao): show a Save panel, then tell the page whether it saved
    func saveFile(_ v: [String: Any]) {
        guard let text = v["text"] as? String else { return }
        let name = (v["name"] as? String).map { $0.replacingOccurrences(of: "/", with: "-") } ?? "Kiki"
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: window) { [weak self] r in
            var ok = false
            if r == .OK, let url = panel.url {
                ok = (try? text.write(to: url, atomically: true, encoding: .utf8)) != nil
            }
            self?.webView.evaluateJavaScript("window.kikiSaved && kikiSaved(\(ok))", completionHandler: nil)
        }
    }

    // <input type=file> from the page: show an Open panel
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
    }

    // MARK: Menu

    @objc func reload(_ sender: Any?) {
        if loaded { webView.reload() } else { connect() }
    }

    @objc func openInBrowser(_ sender: Any?) {
        NSWorkspace.shared.open(base)
    }

    // MARK: Client self-update
    // When connected to a remote server, no background process runs locally, so the background's auto-update can't reach this window app; the same applies when the local background won't start.
    // So the window app checks GitHub for the latest version itself, asks when there's a new one, and swaps in the new App before reopening.

    var clientVersion: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0" }
    var askedClientUpdate = false  // already asked this launch, so don't prompt again automatically

    func newer(_ a: String, than b: String) -> Bool {
        let x = a.split(separator: ".").map { Int($0) ?? 0 }, y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let p = i < x.count ? x[i] : 0, q = i < y.count ? y[i] : 0
            if p != q { return p > q }
        }
        return false
    }

    @objc func checkClientUpdateMenu(_ sender: Any?) { checkClientUpdate(manual: true) }

    func checkClientUpdate(manual: Bool) {
        var req = URLRequest(url: URL(string: "https://api.github.com/repos/lkyxuan/kiki-agent/releases/latest")!)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 20
        URLSession.shared.dataTask(with: req) { data, _, error in
            let tag = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["tag_name"] as? String
            DispatchQueue.main.async {
                guard let tag = tag else {
                    if manual { self.info("Couldn't check for a new version", "Can't reach GitHub: \(error?.localizedDescription ?? "the response wasn't what we expected")") }
                    return
                }
                let latest = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
                if !self.newer(latest, than: self.clientVersion) {
                    if manual { self.info("You're up to date", "This Kiki window app is \(self.clientVersion).") }
                    return
                }
                if !manual && self.askedClientUpdate { return }
                self.askedClientUpdate = true
                NSApp.activate(ignoringOtherApps: true)
                let a = NSAlert()
                a.messageText = "A new version of Kiki is available: \(latest)"
                a.informativeText = "The Kiki on this Mac is \(self.clientVersion). Updating now will close the window, download the new version, and reopen automatically once it's swapped in — about a minute or two." +
                    (self.isRemote ? "\n\nThis only updates the app on this Mac; the remote Kiki updates from its own settings." : "")
                a.addButton(withTitle: "Update now")
                a.addButton(withTitle: "Later")
                if a.runModal() == .alertFirstButtonReturn { self.runClientUpdate() }
            }
        }.resume()
    }

    func runClientUpdate() {
        // If the local background is alive, hand the update to it: it waits for in-flight conversations and background tasks to finish before swapping, and shows progress in the UI
        if !isRemote && loaded {
            post("api/update/check") { _ in self.post("api/update/apply") { ok in
                if !ok { DispatchQueue.main.async { self.info("The background couldn't start the update", "See Settings → Updates for details and logs.") } }
            } }
            return
        }
        runStandaloneUpdate()
    }

    func post(_ path: String, done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.timeoutInterval = 30
        URLSession.shared.dataTask(with: req) { _, res, _ in
            done((res as? HTTPURLResponse).map { $0.statusCode < 400 } ?? false)
        }.resume()
    }

    // No background (connected to remote, or the local background won't start): download the new App and swap it in ourselves
    func runStandaloneUpdate() {
        guard let src = Bundle.main.resourceURL?.appendingPathComponent("client-update.sh"),
              FileManager.default.fileExists(atPath: src.path) else {
            info("Can't update automatically", "The update script is missing from this version. Please download and install it again.")
            return
        }
        // Copy the script out first: the whole App gets replaced during the update
        let script = FileManager.default.temporaryDirectory.appendingPathComponent("kiki-client-update.sh")
        try? FileManager.default.removeItem(at: script)
        do { try FileManager.default.copyItem(at: src, to: script) } catch {
            info("Can't update automatically", error.localizedDescription)
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [script.path, Bundle.main.bundlePath, String(ProcessInfo.processInfo.processIdentifier), isRemote ? "remote" : "local"]
        do { try p.run() } catch {
            info("Can't update automatically", error.localizedDescription)
            return
        }
        NSApp.terminate(nil)
    }

    func info(_ title: String, _ text: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.runModal()
    }

    @objc func showLogs(_ sender: Any?) {
        let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Kiki")
        NSWorkspace.shared.open(logs)
    }

    @objc func showData(_ sender: Any?) {
        let data = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Kiki")
        NSWorkspace.shared.open(data)
    }

    @objc func toggleIntro(_ sender: Any?) {
        introOn.toggle()
        introItem?.state = introOn ? .on : .off
    }

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let app = NSMenu()
        app.addItem(withTitle: "About Kiki", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(withTitle: "Check for App Updates…", action: #selector(checkClientUpdateMenu(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Settings…", action: #selector(openSettings(_:)), keyEquivalent: ",")
        let conn = app.addItem(withTitle: "Connect to…", action: #selector(changeServer(_:)), keyEquivalent: "k")
        conn.keyEquivalentModifierMask = [.command, .shift]
        app.addItem(.separator())
        app.addItem(withTitle: "Open Data Folder", action: #selector(showData(_:)), keyEquivalent: "")
        app.addItem(withTitle: "Open Logs Folder", action: #selector(showLogs(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Kiki", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(.separator())
        app.addItem(withTitle: "Quit Kiki Window (background keeps running)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload(_:)), keyEquivalent: "r")
        view.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser(_:)), keyEquivalent: "")
        view.addItem(.separator())
        let lookItem = NSMenuItem(title: "Appearance", action: nil, keyEquivalent: "")
        let look = NSMenu(title: "Appearance")
        for (title, value) in [("Follow System", "system"), ("Light", "light"), ("Dark", "dark")] {
            let item = look.addItem(withTitle: title, action: #selector(pickTheme(_:)), keyEquivalent: "")
            item.representedObject = value
            themeItems.append(item)
        }
        lookItem.submenu = look
        view.addItem(lookItem)
        let intro = view.addItem(withTitle: "Intro Animation", action: #selector(toggleIntro(_:)), keyEquivalent: "")
        intro.state = introOn ? .on : .off
        introItem = intro
        view.addItem(.separator())
        let full = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view
        main.addItem(viewItem)

        let winItem = NSMenuItem()
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = win
        main.addItem(winItem)
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
