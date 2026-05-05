# ⚡ Quickstart

This guide shows how to install CodeFly Host and bind it to the CodeFly mobile app.

[PLACEHOLDER: short setup video or GIF showing install, `codefly`, pairing, and the first mobile-controlled session]

## What You Need

- A computer where Codex or Claude Code can run.
- Node.js 20.19 or newer.
- Codex or Claude Code installed and signed in on that computer, or configured with a usable API key.
- The CodeFly mobile app installed on iOS or Android.

<p>
  <a href="https://apps.apple.com/app/id6762831575">
    <img alt="Download on the App Store" src="https://img.shields.io/badge/App%20Store-Download-0D96F6?style=for-the-badge&logo=apple&logoColor=white" />
  </a>
  <a href="https://play.google.com/store/apps/details?id=com.codefly.run">
    <img alt="Get it on Google Play" src="https://img.shields.io/badge/Google%20Play-Get%20it-34A853?style=for-the-badge&logo=googleplay&logoColor=white" />
  </a>
</p>

## Install CodeFly Host

```bash
npm install -g codefly-host
```

Start the host menu:

```bash
codefly
```

Example first run:

```text
Select a language
Enter the number for your language.
1. English
2. 简体中文
3. 繁體中文
4. 日本語
5. 한국어
6. Français
7. Deutsch
8. Русский
9. Español
> 1

What do you want to do?
1. Manage local direct connection
2. Manage local relay connection
3. Manage security certificate
4. Check current environment
5. Check for updates
q. Quit
>
```

Main menu options:

- `1. Manage local direct connection`: bind phones that can reach this host directly.
- `2. Manage local relay connection`: bind this host to CodeFly Relay.
- `3. Manage security certificate`: view or change the host-side certificate used by secure host communication.
- `4. Check current environment`: inspect provider availability, host runtime, and local system state.
- `5. Check for updates`: check the npm package and install the latest `codefly-host` version when available.
- `q. Quit`: close the menu.

## Choose A Connection Mode

Use Direct Mode when your phone can reach your host. Use CodeFly Relay when you want managed remote reachability without configuring your own network path.

If you prefer to bring your own VPN, TCP proxy, tunnel, or private overlay, read [Self-Hosted Relay](SELF_HOSTED_RELAY.md).

## Direct Mode

Direct Mode is best when your phone can reach your computer over local Wi-Fi, VPN, private overlay, tunnel, or a public address.

```text
Manage local direct connection
1. Manage bound direct clients (currently 0)
2. Add a new bound direct client
3. Manage service address and port
b. Back
>
```

Before pairing, check `3. Manage service address and port`. This configuration must be correct or the phone cannot connect.

```text
Current direct service configuration
  Host address: 192.168.1.20
  Listen addresses: 0.0.0.0
  Port: 7788
Host address [192.168.1.20]: 100.80.12.34
Listen addresses [0.0.0.0]: 0.0.0.0
Port [7788]: 7788
Configuration saved.
```

Fields:

- `Host address`: the address written into the Direct QR code by default. Use the LAN IP, VPN IP, tunnel hostname, private overlay address, or public hostname that the phone can actually reach.
- `Listen addresses`: local interfaces where CodeFly Host accepts Direct TCP connections. Use `0.0.0.0` for all IPv4 interfaces, `::` for all IPv6 interfaces, or a comma-separated list such as `0.0.0.0, ::`.
- `Port`: the Direct listener port. The default is `7788`.

When you create a Direct binding, the CLI also lists usable addresses from the configured host, configured listen addresses, and detected local network interfaces. Choose the address the phone can reach; that selected address is encoded into this pairing QR code.

```text
Choose the address to encode in this direct binding QR code.
1. 192.168.1.20 (configured host address)
2. 100.80.12.34 (en0 IPv4)
Address number [1]: 2
QR address: codefly-tcp://100.80.12.34:7788
```

Pairing steps:

1. Run `codefly` on the computer.
2. Choose `1. Manage local direct connection`.
3. Choose `3. Manage service address and port` if the displayed address, listen address, or port is not reachable from the phone.
4. Choose `2. Add a new bound direct client`.
5. In the CodeFly mobile app, tap the `+` button in the top-right corner to add a new host connection.
6. Scan the Direct QR code and wait for the CLI to show the successful pairing message.

[PLACEHOLDER: mobile screenshot showing the top-right `+` button and add-host flow]

Direct Mode does not require OAuth sign-in and is free forever.

## CodeFly Relay

Use CodeFly Relay when Direct networking is inconvenient or unavailable.

CodeFly Relay is useful when:

- the host is behind NAT
- the host does not have a stable public IP address
- port forwarding is not available
- you want the host reachable while traveling
- the network blocks inbound connections to the host

Before Relay binding, make sure the mobile app has an available Relay trial or subscription. CodeFly supports OAuth sign-in with providers such as Apple, Google, GitHub, or WeChat. Without OAuth sign-in, a purchase can only be used on the device that made the purchase. After sign-in, the same Relay entitlement can be shared across the user's own devices.

Steps:

1. Run `codefly` on the computer.
2. Choose `2. Manage local relay connection`.
3. Choose `2. Add a new bound relay account`.
4. Sign in to the CodeFly mobile app with a supported OAuth provider.
5. In the mobile app, tap the `+` button in the top-right corner to add a new host connection.
6. Scan the Relay QR code.
7. The host receives a Relay credential and opens an outbound connection.
8. The mobile app shows the host when the Relay binding is active.

CodeFly Relay requires a subscribed host seat. Multiple users and multiple mobile devices may bind the same host, but Relay entitlement is counted per end user. If two users bind the same host through Relay, each user needs their own available host seat. The same signed-in user can use their own devices to access the same bound host without consuming extra host seats.

## Start A Session

After pairing:

1. Open the CodeFly mobile app.
2. Select the paired host.
3. Choose a workspace.
4. Choose Codex or Claude Code.
5. Existing host sessions appear automatically when available.
6. To start a new session, tap the new-session button in the top-right corner.

From the phone, you can create tasks, send instructions, respond to approval prompts, inspect changed files and diffs, interrupt or continue running work, and switch between available local providers.

Provider tools still run on your computer. CodeFly gives you a mobile control surface for those local sessions.

## Check For Updates

Choose `5. Check for updates` in the host menu. CodeFly checks the latest published npm version and, when an update is available, asks whether to install it automatically with:

```bash
npm install -g codefly-host@latest
```

Restart `codefly` after an upgrade.

## Troubleshooting

### Direct Pairing Fails

Check that:

- the phone and computer are on networks that can reach each other
- `Manage service address and port` uses a host address reachable from the phone
- the listen address accepts traffic on the interface the phone uses
- the Direct port is allowed by the computer firewall
- a VPN, tunnel, or private overlay is connected before pairing

### The Host Is Not Listed With CodeFly Relay

Check that:

- the mobile app has an available Relay trial or subscription
- the mobile app is signed in if you want to share the subscription across your own devices
- the subscribed host seat limit has not been reached
- the host computer can make outbound HTTPS/WebSocket connections

### Codex Or Claude Code Is Missing

CodeFly Host uses the provider tools installed on your computer. Make sure the provider is installed, signed in, or configured with a usable API key from the same user account that runs `codefly`.

## Next Steps

- Read [Security Whitepaper](SECURITY_WHITEPAPER.md) to understand encryption and Relay boundaries.
- Read [Self-Hosted Relay](SELF_HOSTED_RELAY.md) to use Direct Mode over your own VPN, proxy, or tunnel.
- Read [Advanced Configuration](ADVANCED.md) for host settings and binding removal.
- Read [Commercial Model](COMMERCIAL.md) to understand Relay subscriptions.
