using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using System.IO;
using System.Text.Json;
using System.Windows;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 2) throw new ArgumentException("Expected fixture directory and report path");
        var app = new Application();
        var view = new WebView2();
        var window = new Window { Content = view, Width = 800, Height = 600, ShowInTaskbar = false };
        string profile = Path.Combine(Path.GetTempPath(), "Sharkord-runtime-" + Guid.NewGuid());
        window.Loaded += async (_, _) =>
        {
            try
            {
                var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: profile);
                await view.EnsureCoreWebView2Async(environment);
                view.CoreWebView2.PermissionRequested += (_, request) => request.State = CoreWebView2PermissionState.Deny;
                view.CoreWebView2.SetVirtualHostNameToFolderMapping("sharkord.test", Path.GetFullPath(args[0]), CoreWebView2HostResourceAccessKind.DenyCors);
                view.CoreWebView2.Navigate("https://sharkord.test/index.html");
                for (int attempt = 0; attempt < 200; attempt++)
                {
                    await Task.Delay(100);
                    string raw = await view.ExecuteScriptAsync("JSON.stringify(window.__sharkordVoiceResult ?? null)");
                    string? json = JsonSerializer.Deserialize<string>(raw);
                    if (string.IsNullOrEmpty(json) || json == "null") continue;
                    using var report = JsonDocument.Parse(json);
                    File.WriteAllText(args[1], json);
                    bool passed = report.RootElement.GetProperty("passed").GetBoolean();
                    Console.WriteLine(json);
                    app.Shutdown(passed ? 0 : 1);
                    return;
                }
                throw new TimeoutException("WebView2 voice probe timed out");
            }
            catch (Exception error)
            {
                File.WriteAllText(args[1], JsonSerializer.Serialize(new { passed = false, error = error.ToString() }));
                Console.Error.WriteLine(error);
                app.Shutdown(1);
            }
            finally { view.Dispose(); }
        };
        int code = app.Run(window);
        try { Directory.Delete(profile, true); } catch (IOException) { }
        return code;
    }
}
