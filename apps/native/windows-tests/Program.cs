using Sharkord;

static void Check(bool value, string label) { if (!value) throw new Exception(label); }
static void Reject(Action action, string label)
{
    try { action(); } catch (ArgumentException) { return; } catch (FormatException) { return; }
    throw new Exception("Expected rejection: " + label);
}
var address = new ServerAddress(" example.com/voice ");
Check(address.Id == "https://example.com/voice/", "canonical URL");
Check(new ServerAddress("https://example.com:443/voice/").Id == address.Id, "default port");
Check(new ServerAddress("безбаб.рф/voice").Url.IdnHost == "xn--80ababrm.xn--p1ai", "IDN");
foreach (string value in new[] { "", "file:///tmp/file", "http://example.com/", "https://u:p@example.com/", "https://example.com/?token=secret", "https://example.com/#hash", "https://example.com\\@evil.com/" })
    Reject(() => new ServerAddress(value), value);
Check(address.Trusts(new Uri("https://example.com/voice/oidc/login")), "trusted child path");
foreach (string value in new[] { "https://evil.com/voice/", "https://example.com/", "https://example.com/voice-other/", "https://example.com/voice/../admin/", "http://example.com/voice/", "https://example.com:444/voice/" })
    Check(!address.Trusts(new Uri(value)), "untrusted " + value);
Check(address.ProfileName != new ServerAddress("https://example.com/other/").ProfileName, "path profile isolation");
Check(address.ProfileName == new ServerAddress(address.Id).ProfileName, "stable profile identity");
Check(UpdateProtocol.ParseVersion("0.1.10") > UpdateProtocol.ParseVersion("0.1.2"), "numeric version order");
foreach (string value in new[] { "../evil", "1.0", "1.0.0-preview", "1.2.3/evil", "1.a.0" }) Reject(() => UpdateProtocol.ParseVersion(value), value);
var asset = new UpdateProtocol.Asset("Sharkord-windows-x64.zip", new string('a', 64), 123);
var manifest = new UpdateProtocol.Manifest("0.2.0", [asset]);
Check(UpdateProtocol.Validate(manifest, "0.2.0", asset.name).size == 123, "valid update manifest");
Reject(() => UpdateProtocol.Validate(manifest, "0.3.0", asset.name), "wrong release");
Reject(() => UpdateProtocol.Validate(manifest, "0.2.0", "Other.zip"), "wrong platform");
foreach (var invalid in new[] { asset with { sha256 = "invalid" }, asset with { size = -1 }, asset with { size = 500_000_001 } })
    Reject(() => UpdateProtocol.Validate(new UpdateProtocol.Manifest("0.2.0", [invalid]), "0.2.0", asset.name), "invalid update metadata");
Console.WriteLine("Passed: URL normalization, origin and path checks, profile isolation, version ordering and update manifest validation.");

var media = new MediaPermissions();
Check(media.Decision(address, "Microphone") == null, "unknown microphone permission");
media.Remember(address, "Microphone", true);
media.Remember(address, "Camera", false);
var restored = System.Text.Json.JsonSerializer.Deserialize<MediaPermissions>(System.Text.Json.JsonSerializer.Serialize(media))!;
Check(restored.Decision(address, "Microphone") == true, "persistent microphone grant");
Check(restored.Decision(address, "Camera") == false, "persistent camera denial");
foreach (string url in new[] { "https://other.example.com/voice/", "https://example.com/other/", "https://example.com:444/voice/" })
    Check(restored.Decision(new ServerAddress(url), "Microphone") == null, "permission isolation " + url);
var other = new ServerAddress("https://example.com/other/");
restored.Remember(other, "Microphone", false);
restored.Reset(address);
Check(restored.Decision(address, "Microphone") == null, "reset microphone permission");
Check(restored.Decision(address, "Camera") == null, "reset camera permission");
Check(restored.Decision(other, "Microphone") == false, "reset preserves other server");
Console.WriteLine("Passed: persistent media permission grants, denials, server isolation and reset.");
