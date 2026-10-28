using System;
using System.Linq;

namespace Sharkord;

public static class UpdateProtocol
{
    public sealed record Asset(string name, string sha256, long size);
    public sealed record Manifest(string version, Asset[] assets);
    public static Version ParseVersion(string value)
    {
        string[] parts = value.Split('.');
        if (parts.Length != 3 || parts.Any(part => part.Length == 0 || part.Length >= 7 || part.Any(c => c < '0' || c > '9')))
            throw new FormatException("Некорректная версия клиента.");
        return Version.Parse(value);
    }
    public static Asset Validate(Manifest manifest, string expectedVersion, string filename)
    {
        _ = ParseVersion(manifest.version);
        var asset = manifest.assets.FirstOrDefault(item => item.name == filename);
        if (manifest.version != expectedVersion || asset == null || asset.size <= 0 || asset.size >= 500_000_000 ||
            asset.sha256.Length != 64 || asset.sha256.Any(c => !"0123456789abcdef".Contains(c)))
            throw new FormatException("GitHub вернул некорректные данные обновления.");
        return asset;
    }
}
