**Small VPS deployment alongside Foundry VTT**

This fork supports running under `/голос/`. Build the browser client with the same base path that the server receives in `SHARKORD_BASE_PATH`. The reverse proxy strips the prefix before forwarding HTTP and WebSocket requests to Sharkord. Other paths keep going to Foundry on port 30000.

```sh
bun install --frozen-lockfile
cd apps/server
SHARKORD_BASE_PATH=/%D0%B3%D0%BE%D0%BB%D0%BE%D1%81 bun run build --target bun-linux-x64
```

Build outside the VPS. Install the resulting executable as `/opt/sharkord/releases/<commit>/sharkord`, owned by root, and point `/opt/sharkord/current` at that release. Create a system user named `sharkord` with `/var/lib/sharkord` as its home and no login shell. Install `sharkord.service` under `/etc/systemd/system/` and copy `sharkord.env.example` to `/etc/sharkord.env` with permissions 0600. Review the domain, address, limits and existing Caddy configuration before applying the example.

Use `caddy validate` before reloading Caddy. The HTTP listener is bound to loopback. Voice requires clients to reach TCP and UDP port 40000 on the VPS directly, including through any hosting firewall. The service has a 512 MiB soft memory limit and a 768 MiB hard limit including its child process. These are starting values to validate during a real session.

Configure the persistent server settings after claiming ownership: 20 MiB maximum attachment, 5 GiB total file quota, 512 MiB per user, 3 attachments per message, and prevention of new uploads at quota. Start with image optimization, plugins and simulcast disabled. The microphone retains its existing Opus profile. External link previews are disabled in the example; if enabled, requests, response size, cache size and queued work are bounded.

The built-in updater reads releases from `whysoidle/sharkord`. With this root-owned deployment, update by installing a verified release and changing the `current` symlink rather than allowing the application to replace its executable. Back up the complete state directory consistently before updates; preserve pre-migration database snapshots.

Store account credentials and the initial ownership token outside the repository, readable only by the administrator. No VPS credentials belong in configuration examples or build artifacts.
