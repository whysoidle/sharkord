using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;

namespace Sharkord;

public static class Updater
{
    private const string Repository = "whysoidle/sharkord";
    private const string Filename = "Sharkord-windows-x64.zip";
    private static readonly HttpClient client = CreateClient();
    private static HttpClient CreateClient()
    {
        var http = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("Sharkord-Native/0.1");
        return http;
    }
    public static async Task CheckAndInstall(Window window, Func<bool> confirmInterruption, Action quit, Action<string> status)
    {
        status("Проверка обновлений…");
        using var releases = JsonDocument.Parse(await client.GetStringAsync($"https://api.github.com/repos/{Repository}/releases?per_page=100"));
        var candidates = releases.RootElement.EnumerateArray()
            .Where(item => !item.GetProperty("draft").GetBoolean() && !item.GetProperty("prerelease").GetBoolean())
            .Select(item => item.GetProperty("tag_name").GetString() ?? "")
            .Where(tag => tag.StartsWith("client-v", StringComparison.Ordinal))
            .Select(tag => tag[8..])
            .Where(text => { try { _ = UpdateProtocol.ParseVersion(text); return true; } catch (FormatException) { return false; } })
            .Select(text => (Text: text, Version: UpdateProtocol.ParseVersion(text))).OrderByDescending(item => item.Version).ToList();
        var current = Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 1, 0);
        if (candidates.Count == 0 || candidates[0].Version <= new Version(current.Major, current.Minor, current.Build))
        {
            MessageBox.Show(window, $"Установлена актуальная версия Sharkord {current.Major}.{current.Minor}.{current.Build}.", "Sharkord");
            return;
        }
        var newest = candidates[0];
        string root = $"https://github.com/{Repository}/releases/download/client-v{newest.Text}/";
        string manifestJson = await client.GetStringAsync(root + "client-update.json");
        var manifest = JsonSerializer.Deserialize<UpdateProtocol.Manifest>(manifestJson) ?? throw new FormatException("Не удалось прочитать данные обновления.");
        var asset = UpdateProtocol.Validate(manifest, newest.Text, Filename);
        if (MessageBox.Show(window, $"Скачать Sharkord {newest.Text} с GitHub и перезапустить приложение? Активное голосовое подключение будет прервано.", "Обновление Sharkord", MessageBoxButton.YesNo) != MessageBoxResult.Yes || !confirmInterruption()) return;
        string target = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        string probe = Path.Combine(target, ".sharkord-update-" + Guid.NewGuid().ToString("N"));
        try { await File.WriteAllTextAsync(probe, ""); File.Delete(probe); }
        catch (UnauthorizedAccessException) { throw new IOException("Переместите приложение в доступную для записи папку и запустите оттуда."); }
        string directory = Path.Combine(Path.GetTempPath(), "Sharkord-update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        string archive = Path.Combine(directory, "update.zip");
        status("Загрузка обновления…");
        using (var response = await client.GetAsync(root + Filename, HttpCompletionOption.ResponseHeadersRead))
        {
            response.EnsureSuccessStatusCode();
            await using var destination = File.Create(archive);
            await response.Content.CopyToAsync(destination);
        }
        using (var stream = File.OpenRead(archive))
        {
            string checksum = Convert.ToHexString(await SHA256.HashDataAsync(stream)).ToLowerInvariant();
            if (stream.Length != asset.size || checksum != asset.sha256) throw new IOException("Контрольная сумма не совпала. Обновление не будет установлено.");
        }
        string staged = Path.Combine(directory, "app");
        status("Подготовка установки…");
        ZipFile.ExtractToDirectory(archive, staged);
        string executable = Path.Combine(staged, "Sharkord.exe");
        if (!File.Exists(executable)) throw new IOException("В обновлении отсутствует Sharkord.exe.");
        var info = FileVersionInfo.GetVersionInfo(executable);
        if (info.FileMajorPart != newest.Version.Major || info.FileMinorPart != newest.Version.Minor || info.FileBuildPart != newest.Version.Build)
            throw new IOException("Версия приложения в архиве не совпала с релизом.");
        string helper = Path.Combine(directory, "update.ps1");
        File.Copy(Path.Combine(AppContext.BaseDirectory, "Assets", "update-windows.ps1"), helper);
        var start = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true };
        foreach (string argument in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-ProcessId", Environment.ProcessId.ToString(), "-Source", staged, "-Target", target })
            start.ArgumentList.Add(argument);
        Process.Start(start);
        quit();
    }
}
