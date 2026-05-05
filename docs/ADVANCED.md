# Advanced Configuration

Most users should use the interactive `codefly` menu. This document covers host settings for advanced network and provider setups.

## Direct Mode Settings

Use these variables when the default Direct Mode address or port is not enough.

```bash
HOST_CLIENT_BIND=0.0.0.0, ::
HOST_CLIENT_PORT=7788
HOST_CLIENT_DIRECT_PUBLIC_HOST=host.example.com
```

- `HOST_CLIENT_BIND`: comma-separated local listen addresses for the host service. Use `0.0.0.0` for all IPv4 interfaces, `::` for all IPv6 interfaces, or explicit addresses for selected interfaces.
- `HOST_CLIENT_PORT`: Direct Mode port, default `7788`.
- `HOST_CLIENT_DIRECT_PUBLIC_HOST`: host name or IP address shown to the mobile app during Direct pairing.

`HOST_CLIENT_DIRECT_PUBLIC_HOST` should be reachable from the phone. It can be an IPv4 address, IPv6 address, DNS name, local IP address, VPN address, tunnel hostname, private overlay address, or other user-managed network endpoint. Enter only the host, without a protocol, path, or port.

`HOST_CLIENT_BIND` controls where the host listens locally. It accepts IPv4 addresses, IPv6 addresses, and local hostnames that resolve to this computer. Common examples:

```bash
HOST_CLIENT_BIND=0.0.0.0
HOST_CLIENT_BIND=0.0.0.0, ::
HOST_CLIENT_BIND=192.168.1.20, 100.80.12.34
HOST_CLIENT_BIND=my-host.local, 0.0.0.0, ::
```

Wildcard listeners are listen-only values. `0.0.0.0`, `::`, `127.0.0.1`, and `localhost` are skipped as QR addresses because a phone cannot use them to identify the host from another device.

The same settings can be managed from the interactive menu:

```text
1. Manage local direct connection
3. Manage service address and port
```

This is one of the most important Direct Mode settings. The host must listen on the correct local interface, and the QR code must advertise an address the phone can reach. When creating a Direct binding, CodeFly lists usable candidates from the configured public host, configured listen addresses, and detected local network interfaces. Choose the IPv4 address, IPv6 address, or DNS name that is reachable from the phone for that pairing.

## Host Data And Workspace

```bash
HOST_CLIENT_DATA_DIR=/var/lib/codefly/host
HOST_CLIENT_WORKSPACE_DIR=/path/to/workspaces
HOST_CLIENT_NAME=My CodeFly Host
```

- `HOST_CLIENT_DATA_DIR`: local directory for host identity, pairing records, and Relay binding state.
- `HOST_CLIENT_WORKSPACE_DIR`: default workspace root.
- `HOST_CLIENT_NAME`: display name for the host.

Host data remains on the computer running CodeFly Host. Protect this directory like any other local developer credential store.

## Provider Selection

```bash
HOST_CLIENT_ADAPTER=multi
```

Supported values:

- `multi`: use all available supported providers.
- `codex`: use Codex only.
- `claude`: use Claude Code only.

CodeFly expects provider tools to be installed and signed in on the host computer, or configured with a usable API key. Provider accounts, configuration, sandbox behavior, and session history remain provider-native.

## Network Paths Without CodeFly Relay

If you do not want to use CodeFly Relay, keep using Direct Mode over your own reachable network path.

Examples:

- VPN
- private overlay
- SSH TCP tunnel
- reverse tunnel
- user-managed TCP proxy

See [Self-Hosted Relay](SELF_HOSTED_RELAY.md) for the recommended model.

## CodeFly Relay

For public CodeFly builds, CodeFly Relay is the managed remote reachability service.

Relay pairing is handled by the `codefly` menu and the mobile app. It should not require manual network configuration for normal use.

## TLS And Firewalls

CodeFly Host uses a host-side certificate for the secure connection between the mobile app and the host. By default, the host generates and stores this certificate locally in the host data directory. CodeFly does not issue, store, or have access to the host certificate private key.

Certificate-related settings:

```bash
HOST_CLIENT_TLS_CERT_PATH=/path/to/tls.crt
HOST_CLIENT_TLS_KEY_PATH=/path/to/tls.key
```

You can also manage the certificate from the CLI:

```text
What do you want to do?
3. Manage security certificate
```

The CLI shows and manages the certificate path, key path, host public key fingerprint, and certificate fingerprint. If you change the certificate path, restart the host service for the change to take effect.

For Direct Mode, make sure the host firewall allows inbound traffic on `HOST_CLIENT_PORT`.

## Reset And Device Management

### Remove A Direct Binding From The Host

Run:

```bash
codefly
```

Then choose:

```text
1. Manage local direct connection
1. Manage bound direct clients
```

Select the numbered Direct client to remove. Removing it from the host revokes that phone's Direct auth token for this host.

### Remove A Relay Binding From The Host

Run:

```bash
codefly
```

Then choose:

```text
2. Manage local relay connection
1. Manage bound relay accounts
```

Select the numbered Relay binding to remove. Removing it from the host stops this host from using that Relay binding.

When CodeFly Relay is used, removing a binding from either the host side or the mobile side is synchronized through CodeFly when the other side can still reach the service.

### Remove A Host From The Mobile App

In the mobile app, go to the host list, swipe the host card, then choose `Delete`. This removes the mobile-side pairing record from the phone.

### Binding And Relay Seat Rules

CodeFly can bind multiple users and multiple mobile devices to the same host. Direct bindings are local to the host and phone.

Relay subscriptions are counted per end user by bindable host seats. If multiple users bind the same host through Relay, they do not share one user's Relay entitlement. The same signed-in user can use their own devices to access the same bound host without consuming additional host seats.

### Full Local Reset

To fully reset a host, stop CodeFly Host and remove the host data directory configured by `HOST_CLIENT_DATA_DIR`.

If `HOST_CLIENT_DATA_DIR` is not set, the default host data directory is `./data` under the directory where `codefly` is launched. This default is the same on macOS, Linux, and Windows because it is relative to the current working directory.
