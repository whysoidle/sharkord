using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using Forms = System.Windows.Forms;

namespace Sharkord;

public partial class MainWindow : Window
{
    private readonly Settings settings = Settings.Load();
    private readonly Forms.NotifyIcon tray;
    private WebView2? browser;
    private ServerAddress? server;
    private bool capturing;
    private bool exiting;
    private bool authenticating;
    private DateTime lastNotification = DateTime.MinValue;

    public MainWindow()
    {
        InitializeComponent();
        ServerBox.ItemsSource = settings.Servers;
        ServerBox.Text = settings.LastServer ?? "";
        tray = new Forms.NotifyIcon { Text = "Sharkord", Icon = System.Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? System.Drawing.SystemIcons.Application, Visible = true };
        tray.DoubleClick += (_, _) => RestoreWindow();
        tray.BalloonTipClicked += (_, _) => RestoreWindow();
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Открыть Sharkord", null, (_, _) => RestoreWindow());
        menu.Items.Add("Проверить обновления", null, async (_, _) => await CheckUpdates());
        menu.Items.Add("Сбросить доступ к микрофону и камере", null, async (_, _) => await ResetMediaPermissions());
        menu.Items.Add("Выйти", null, (_, _) => Quit());
        tray.ContextMenuStrip = menu;
        PreviewKeyDown += (_, args) =>
        {
            if (Keyboard.Modifiers != ModifierKeys.Control) return;
            if (args.Key == Key.R) { Reload(); args.Handled = true; }
            if (args.Key == Key.K) { ServerBox.Focus(); args.Handled = true; }
        };
    }

    private async void WindowLoaded(object sender, RoutedEventArgs args)
    {
        if (!string.IsNullOrEmpty(settings.LastServer)) await Connect(settings.LastServer);
    }
    private async void ConnectClick(object sender, RoutedEventArgs args) => await Connect(ServerBox.Text);
    private async Task Connect(string input)
    {
        if (!ConfirmInterruption()) return;
        ConnectButton.IsEnabled = false;
        try
        {
            var address = new ServerAddress(input);
            var candidate = new WebView2
            {
                CreationProperties = new CoreWebView2CreationProperties
                {
                    UserDataFolder = Path.Combine(Settings.DataPath, "WebView2"),
                    ProfileName = address.ProfileName
                }
            };
            browser?.Dispose();
            BrowserHolder.Children.Clear();
            BrowserHolder.Children.Add(candidate);
            browser = candidate;
            server = address;
            capturing = false;
            authenticating = false;
            StatusText.Text = "Подключение к " + address.Id;
            await candidate.EnsureCoreWebView2Async();
            var core = candidate.CoreWebView2;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.PermissionRequested += PermissionRequested;
            core.FrameCreated += (_, frame) => frame.Frame.PermissionRequested += (_, request) =>
            {
                // stored capture permissions apply only to the main document.
                request.State = CoreWebView2PermissionState.Deny;
                request.SavesInProfile = false;
                request.Handled = true;
            };
            core.WebMessageReceived += MessageReceived;
            core.NavigationStarting += (_, args) =>
            {
                if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri)) { args.Cancel = true; return; }
                if (address.Trusts(uri))
                {
                    if (uri.AbsolutePath.EndsWith("/oidc/login")) authenticating = true;
                    return;
                }
                if (authenticating && uri.Scheme == "https") return;
                args.Cancel = true;
                if (args.IsUserInitiated) OpenExternal(uri);
            };
            core.FrameNavigationStarting += (_, args) =>
            {
                if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http" or "about" or "blob")) args.Cancel = true;
            };
            core.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                if (args.IsUserInitiated && Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri)) OpenExternal(uri);
            };
            core.NavigationCompleted += (_, args) =>
            {
                if (!args.IsSuccess) StatusText.Text = "Не удалось открыть сервер: " + args.WebErrorStatus + ". Проверьте URL и нажмите ↻.";
                else
                {
                    StatusText.Text = address.Id;
                    if (Uri.TryCreate(core.Source, UriKind.Absolute, out var uri) && address.Trusts(uri)) authenticating = false;
                }
            };
            core.ProcessFailed += (_, _) => { capturing = false; StatusText.Text = "Процесс интерфейса остановился. Нажмите ↻ для подключения."; };
            core.DownloadStarting += (_, args) =>
            {
                var dialog = new Microsoft.Win32.SaveFileDialog { FileName = Path.GetFileName(args.ResultFilePath) };
                if (dialog.ShowDialog(this) == true) { args.ResultFilePath = dialog.FileName; args.Handled = true; }
                else args.Cancel = true;
            };
            string script = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Assets", "client.js"));
            await core.AddScriptToExecuteOnDocumentCreatedAsync("window.__sharkordServerUrl=" + JsonSerializer.Serialize(address.Id) + ";\n" + script);
            settings.Servers.RemoveAll(item => item == address.Id);
            settings.Servers.Insert(0, address.Id);
            settings.Servers = settings.Servers.Take(10).ToList();
            settings.LastServer = address.Id;
            settings.Save();
            ServerBox.ItemsSource = settings.Servers;
            ServerBox.Text = address.Id;
            core.Navigate(address.Id);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            StatusText.Text = "Установите Microsoft Edge WebView2 Runtime и снова нажмите «Подключиться».";
            if (MessageBox.Show(this, "Для работы нужен Microsoft Edge WebView2 Runtime. Открыть страницу Microsoft?", "Sharkord", MessageBoxButton.YesNo) == MessageBoxResult.Yes)
                OpenExternal(new Uri("https://developer.microsoft.com/microsoft-edge/webview2/"));
        }
        catch (Exception exception) { StatusText.Text = exception.Message; }
        finally { ConnectButton.IsEnabled = true; }
    }

    private void PermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs args)
    {
        args.State = CoreWebView2PermissionState.Deny;
        if (!ReferenceEquals(sender, browser?.CoreWebView2) || server == null || !Uri.TryCreate(args.Uri, UriKind.Absolute, out var origin) || !server.TrustsOrigin(origin) ||
            !Uri.TryCreate(browser?.CoreWebView2.Source, UriKind.Absolute, out var page) || !server.Trusts(page)) return;
        if (args.PermissionKind is not (CoreWebView2PermissionKind.Microphone or CoreWebView2PermissionKind.Camera or CoreWebView2PermissionKind.ClipboardRead)) return;
        bool capture = args.PermissionKind is CoreWebView2PermissionKind.Microphone or CoreWebView2PermissionKind.Camera;
        if (capture)
        {
            args.SavesInProfile = false;
            bool? saved = settings.CapturePermissions.Decision(server, args.PermissionKind.ToString());
            if (saved.HasValue)
            {
                args.State = saved.Value ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
                return;
            }
        }
        string resource = args.PermissionKind switch { CoreWebView2PermissionKind.Microphone => "микрофону", CoreWebView2PermissionKind.Camera => "камере", _ => "буферу обмена" };
        string description = "Разрешить серверу " + server.Id + " доступ к " + resource + "?";
        if (capture) description += "\nРешение будет сохранено. Сброс доступен в меню значка Sharkord в трее.";
        var permissionServer = server;
        bool allowed = MessageBox.Show(this, description, "Sharkord", MessageBoxButton.YesNo) == MessageBoxResult.Yes;
        if (server != permissionServer || !ReferenceEquals(sender, browser?.CoreWebView2)) return;
        args.State = allowed ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
        if (capture)
        {
            settings.CapturePermissions.Remember(server, args.PermissionKind.ToString(), allowed);
            try { settings.Save(); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            { StatusText.Text = "Не удалось сохранить разрешение: " + error.Message; }
        }
    }

    private async Task ResetMediaPermissions()
    {
        if (server == null || !ConfirmInterruption()) return;
        var address = server;
        var core = browser?.CoreWebView2;
        try
        {
            settings.CapturePermissions.Reset(address);
            settings.Save();
            if (core == null) return;
            foreach (var kind in new[] { CoreWebView2PermissionKind.Microphone, CoreWebView2PermissionKind.Camera })
                await core.Profile.SetPermissionStateAsync(kind, address.Url.GetLeftPart(UriPartial.Authority), CoreWebView2PermissionState.Default);
            if (server == address && ReferenceEquals(core, browser?.CoreWebView2)) core.Reload();
        }
        catch (Exception error) { StatusText.Text = "Не удалось сбросить разрешения: " + error.Message; }
    }

    private async void MessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (server == null || !Uri.TryCreate(args.Source, UriKind.Absolute, out var source) || !server.Trusts(source)) return;
        try
        {
            using var json = JsonDocument.Parse(args.WebMessageAsJson);
            var data = json.RootElement;
            string? type = data.GetProperty("type").GetString();
            if (type == "capture")
            {
                capturing = data.GetProperty("active").GetBoolean();
                StatusText.Text = server.Id + (capturing ? " • Микрофон / камера включены" : "");
            }
            if (type is "requestNotifications" or "notificationStatus")
            {
                int id = data.GetProperty("id").GetInt32();
                if (type == "requestNotifications")
                {
                    settings.Notifications[server.Id] = MessageBox.Show(this, "Показывать уведомления от " + server.Url.Host + "?", "Sharkord", MessageBoxButton.YesNo) == MessageBoxResult.Yes;
                    settings.Save();
                }
                string permission = settings.Notifications.TryGetValue(server.Id, out bool allowed) ? (allowed ? "granted" : "denied") : "default";
                if (browser?.CoreWebView2 != null) await browser.CoreWebView2.ExecuteScriptAsync($"window.__sharkordNativeReply?.({id}, '{permission}')");
            }
            if (type == "notify" && settings.Notifications.GetValueOrDefault(server.Id) && DateTime.UtcNow - lastNotification > TimeSpan.FromSeconds(1))
            {
                lastNotification = DateTime.UtcNow;
                string title = data.GetProperty("title").GetString() ?? "Sharkord";
                string body = data.GetProperty("body").GetString() ?? "";
                tray.ShowBalloonTip(5000, title[..Math.Min(63, title.Length)], body[..Math.Min(255, body.Length)], Forms.ToolTipIcon.Info);
            }
        }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException or FormatException or System.Collections.Generic.KeyNotFoundException) { }
    }

    private bool ConfirmInterruption() => !capturing || MessageBox.Show(this, "Прервать текущее голосовое подключение?", "Sharkord", MessageBoxButton.YesNo) == MessageBoxResult.Yes;
    private void Reload() { if (ConfirmInterruption()) browser?.Reload(); }
    private void ReloadClick(object sender, RoutedEventArgs args) => Reload();
    private void BrowserClick(object sender, RoutedEventArgs args) { if (server != null) OpenExternal(server.Url); }
    private static void OpenExternal(Uri uri)
    {
        if (uri.Scheme is "https" or "http" or "mailto") Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }
    private void RestoreWindow() { Show(); WindowState = WindowState.Normal; Activate(); }
    private void WindowClosing(object? sender, CancelEventArgs args) { if (!exiting) { args.Cancel = true; Hide(); } }
    private void ExitClick(object sender, RoutedEventArgs args) => Quit();
    private void Quit()
    {
        if (!ConfirmInterruption()) return;
        exiting = true;
        browser?.Dispose();
        tray.Dispose();
        Application.Current.Shutdown();
    }
    private async void UpdateClick(object sender, RoutedEventArgs args) => await CheckUpdates();
    private async Task CheckUpdates()
    {
        UpdateButton.IsEnabled = false;
        try { await Updater.CheckAndInstall(this, ConfirmInterruption, () => { capturing = false; Quit(); }, text => StatusText.Text = text); }
        catch (Exception exception) { MessageBox.Show(this, exception.Message, "Не удалось обновить Sharkord"); }
        finally { UpdateButton.IsEnabled = true; StatusText.Text = server?.Id ?? "Выберите сервер Sharkord."; }
    }
}
