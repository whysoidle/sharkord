using System;
using System.Security.Cryptography;
using System.Text;

namespace Sharkord;

public sealed record ServerAddress
{
    public Uri Url { get; }
    public string Id => Url.AbsoluteUri;
    public string ProfileName => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Id))).ToLowerInvariant();
    public ServerAddress(string input)
    {
        string value = input.Trim();
        if (!value.Contains("://")) value = "https://" + value;
        if (value.Contains('\\') || !Uri.TryCreate(value, UriKind.Absolute, out var url) ||
            string.IsNullOrEmpty(url.Host) || !string.IsNullOrEmpty(url.UserInfo) ||
            !string.IsNullOrEmpty(url.Query) || !string.IsNullOrEmpty(url.Fragment))
            throw new ArgumentException("Введите адрес сервера без логина, пароля, параметров и #.");
        bool local = url.Host is "localhost" or "127.0.0.1" or "[::1]";
        if (url.Scheme != "https" && !(url.Scheme == "http" && local))
            throw new ArgumentException("Для безопасного входа и микрофона нужен HTTPS. HTTP разрешён только для localhost.");
        var builder = new UriBuilder(url) { Host = url.IdnHost.ToLowerInvariant() };
        if (url.IsDefaultPort) builder.Port = -1;
        if (!builder.Path.EndsWith('/')) builder.Path += "/";
        Url = builder.Uri;
    }
    public bool Trusts(Uri? url) => url != null && TrustsOrigin(url) &&
        url.AbsolutePath.StartsWith(Url.AbsolutePath, StringComparison.Ordinal);
    public bool TrustsOrigin(Uri url) => url.Scheme == Url.Scheme && url.IdnHost == Url.IdnHost &&
        url.Port == Url.Port && string.IsNullOrEmpty(url.UserInfo);
}
