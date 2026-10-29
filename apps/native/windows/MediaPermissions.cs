using System.Collections.Generic;

namespace Sharkord;

public sealed class MediaPermissions
{
    public Dictionary<string, Dictionary<string, bool>> Servers { get; set; } = [];
    public bool? Decision(ServerAddress server, string resource) =>
        Servers.TryGetValue(server.Id, out var grants) && grants.TryGetValue(resource, out bool allowed) ? allowed : null;
    public void Remember(ServerAddress server, string resource, bool allowed)
    {
        if (!Servers.TryGetValue(server.Id, out var grants)) Servers[server.Id] = grants = [];
        grants[resource] = allowed;
    }
    public void Reset(ServerAddress server) => Servers.Remove(server.Id);
}
