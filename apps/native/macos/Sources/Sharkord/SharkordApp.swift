import AppKit
import SwiftUI
import UserNotifications
import WebKit

@main
struct SharkordApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var browser = BrowserModel()
    @StateObject private var updater = Updater()

    var body: some Scene {
        WindowGroup(id: "main") {
            ContentView(browser: browser, updater: updater)
                .onAppear { delegate.browser = browser }
                .frame(minWidth: 780, minHeight: 580)
        }
        .defaultSize(width: 1180, height: 800)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandMenu("Сервер") {
                Button("Подключиться к серверу…") { browser.showServers = true }
                    .keyboardShortcut("k", modifiers: [.command])
                Button("Перезагрузить") { browser.reload() }
                    .keyboardShortcut("r", modifiers: [.command])
                Button("Открыть в браузере") { browser.openInBrowser() }
                Button("Сбросить доступ к микрофону и камере") { browser.resetMediaPermissions() }
                    .disabled(browser.server == nil)
            }
            CommandGroup(after: .appInfo) {
                Button("Проверить обновления…") { Task { await updater.check(browser: browser) } }.disabled(updater.busy)
            }
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    weak var browser: BrowserModel?
    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        if ProcessInfo.processInfo.arguments.contains("--smoke-test") {
            Task { await runSmokeTest() }
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        browser?.confirmInterruption() == false ? .terminateCancel : .terminateNow
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { sender.windows.first(where: { $0.canBecomeMain })?.makeKeyAndOrderFront(nil) }
        return true
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            NSApp.activate(ignoringOtherApps: true)
            NSApp.windows.first(where: { $0.canBecomeMain })?.makeKeyAndOrderFront(nil)
        }
        completionHandler()
    }
}

struct ContentView: View {
    @ObservedObject var browser: BrowserModel
    @ObservedObject var updater: Updater

    var body: some View {
        ZStack {
            if browser.server != nil {
                BrowserView(browser: browser)
                    .id(ObjectIdentifier(browser.webView))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 20) {
                    Image(systemName: "bubble.left.and.bubble.right.fill").font(.system(size: 56)).foregroundStyle(.blue.gradient)
                    Text("Sharkord").font(.largeTitle.bold())
                    Text("Голос, чат и картинки на вашем сервере").foregroundStyle(.secondary)
                    Button("Выбрать сервер") { browser.showServers = true }.controlSize(.large)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.background)
            }
            if let error = browser.error {
                VStack(spacing: 16) {
                    Image(systemName: "wifi.exclamationmark").font(.largeTitle)
                    Text("Не удалось открыть сервер").font(.headline)
                    Text(error).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    HStack {
                        Button("Повторить") { browser.reload() }
                        Button("Другой сервер") { browser.showServers = true }
                    }
                }
                .padding(32).frame(maxWidth: 460).background(.regularMaterial, in: .rect(cornerRadius: 20))
            }
        }
        .toolbar {
            ToolbarItem(placement: .navigation) {
                Button { browser.showServers = true } label: { serverBadge }
                    .buttonStyle(.plain).help("Выбрать сервер (⌘K)")
            }
            ToolbarItemGroup(placement: .primaryAction) {
                if updater.busy {
                    ProgressView().controlSize(.small)
                    Text(updater.status ?? "Обновление…").font(.caption).lineLimit(1)
                }
                if browser.capturing {
                    Label("Микрофон / камера", systemImage: "mic.fill").foregroundStyle(.orange)
                }
                if browser.isLoading { ProgressView().controlSize(.small) }
                Button { browser.reload() } label: { Image(systemName: "arrow.clockwise") }.help("Перезагрузить (⌘R)")
                Button { browser.openInBrowser() } label: { Image(systemName: "arrow.up.forward.app") }.help("Открыть в браузере")
                Button { Task { await updater.check(browser: browser) } } label: { Image(systemName: "arrow.down.circle") }
                    .disabled(updater.busy).help(updater.status ?? "Проверить обновления с GitHub")
            }
        }
        .sheet(isPresented: $browser.showServers) { ServerPicker(browser: browser) }
    }

    @ViewBuilder private var serverBadge: some View {
        let label = Label(browser.server?.label ?? "Выбрать сервер", systemImage: "network")
            .font(.system(size: 12, weight: .medium)).lineLimit(1).padding(.horizontal, 12).padding(.vertical, 8)
        if #available(macOS 26.0, *) {
            label.glassEffect(.regular.tint(.blue.opacity(0.08)), in: .capsule)
        } else {
            label.background(.regularMaterial, in: .capsule)
        }
    }
}

struct ServerPicker: View {
    @ObservedObject var browser: BrowserModel
    @State private var address = ""
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("Подключиться к Sharkord", systemImage: "network").font(.title2.bold())
            Text("Введите адрес своего сервера. Подпуть, например /voice/, сохраняется.")
                .foregroundStyle(.secondary)
            TextField("https://chat.example.com/", text: $address)
                .textFieldStyle(.roundedBorder).onSubmit(connect)
                .accessibilityLabel("Адрес сервера")
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
            if !browser.recent.isEmpty {
                Text("Недавние серверы").font(.headline)
                ForEach(browser.recent) { server in
                    Button(server.label) { address = server.id; connect() }
                        .buttonStyle(.link).lineLimit(1)
                }
            }
            HStack {
                Spacer()
                Button("Отмена") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Подключиться", action: connect).keyboardShortcut(.defaultAction)
                    .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(28).frame(width: 480)
        .onAppear { address = browser.server?.id ?? "" }
    }

    private func connect() {
        do {
            let server = try ServerAddress(address)
            browser.connect(server)
            if browser.server == server { dismiss() }
        } catch { self.error = error.localizedDescription }
    }
}

struct BrowserView: NSViewRepresentable {
    let browser: BrowserModel
    func makeNSView(context: Context) -> NSView {
        // let SwiftUI resize a plain container instead of negotiating WebKit's content size.
        let container = NSView()
        let view = browser.webView
        view.frame = container.bounds
        view.translatesAutoresizingMaskIntoConstraints = true
        view.autoresizingMask = [.width, .height]
        container.addSubview(view)
        DispatchQueue.main.async {
            view.window?.delegate = browser
            view.window?.isReleasedWhenClosed = false
        }
        return container
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
