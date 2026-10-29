using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace Sharkord;

public sealed class Settings
{
    public static string DataPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SharkordNative");
    public List<string> Servers { get; set; } = [];
    public string? LastServer { get; set; }
    public Dictionary<string, bool> Notifications { get; set; } = [];
    public MediaPermissions CapturePermissions { get; set; } = new();
    public static Settings Load()
    {
        try { return JsonSerializer.Deserialize<Settings>(File.ReadAllText(Path.Combine(DataPath, "settings.json"))) ?? new(); }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException) { return new(); }
    }
    public void Save()
    {
        Directory.CreateDirectory(DataPath);
        string path = Path.Combine(DataPath, "settings.json");
        File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(this));
        File.Move(path + ".tmp", path, true);
    }
}
