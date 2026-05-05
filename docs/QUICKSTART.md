# Quickstart

This guide shows how to install CodeFly Host and connect it to the CodeFly mobile app.

[PLACEHOLDER: short setup video or GIF showing install, `codefly`, pairing, and first mobile-controlled session]

## What You Need

- A computer where you want to run Codex or Claude Code.
- Node.js 20.19 or newer.
- Codex or Claude Code installed and signed in on that computer.
- The CodeFly mobile app installed on iOS or Android.

Download the mobile app:

[App Store](#placeholder-app-store-url) · [Google Play](#placeholder-google-play-url)

## Install CodeFly Host

Install the host package globally:

```bash
npm install -g codefly-host
```

Start the host menu:

```bash
codefly
```

The menu will show pairing options and connection management.

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

- `1. Manage local direct connection`: configure and bind phones that can reach this host directly.
- `2. Manage local relay connection`: bind this host to CodeFly Relay for managed remote reachability.
- `3. Manage security certificate`: view or change the host-side certificate used by the secure host connection.
- `4. Check current environment`: inspect host runtime, provider availability, and local environment state.
- `5. Check for updates`: check the installed host package version.
- `q. Quit`: close the menu.

## Choose A Connection Mode

Use Direct Mode when your phone can reach your host. Use CodeFly Relay when you want managed remote reachability without configuring your own network path.

If you prefer to bring your own VPN, TCP proxy, tunnel, or private overlay, read [Self-Hosted Relay](SELF_HOSTED_RELAY.md).

## Direct Mode

Use Direct Mode when your phone can reach your computer on the network.

Common examples:

- phone and computer are on the same local Wi-Fi
- phone is connected through a VPN to the computer's network
- phone can reach the host through a private network overlay or tunnel

Direct menu example:

```text
Manage local direct connection
1. Manage bound direct clients (currently 0)
2. Add a new bound direct client
3. Manage service address and port
b. Back
> 
```

Direct menu options:

- `1. Manage bound direct clients`: list paired Direct clients and remove a binding from this host.
- `2. Add a new bound direct client`: create a new Direct pairing for the mobile app.
- `3. Manage service address and port`: set the host address and Direct port that the mobile app should use.
- `b. Back`: return to the main menu.

Before adding a Direct client, make sure the host address is reachable from the phone. Use option `3. Manage service address and port` when the default address is not correct.

Example:

```text
Current direct service configuration
  Host address: 192.168.1.20
  Port: 7788
Host address [192.168.1.20]: 100.80.12.34
Port [7788]: 7788
Configuration saved.
```

The Host address should be the address your phone can reach. This can be a LAN IP address, VPN address, tunnel hostname, private overlay address, or public hostname. The port is the Direct listener port. The default is `7788`.

Pairing steps:

1. Run `codefly` on the computer.
2. Choose `1. Manage local direct connection`.
3. Choose `3. Manage service address and port` if the displayed address or port is not reachable from the phone.
4. Choose `2. Add a new bound direct client`.
5. Pair from the CodeFly mobile app.
6. Wait for the CLI to show the successful pairing message.

Direct Mode does not require OAuth sign-in and is free forever.

Default Direct port:

```text
7788
```

If your phone cannot reach the host, check that the computer firewall allows inbound traffic on the configured port and that the displayed host address is reachable from the phone.

## CodeFly Relay

Use CodeFly Relay when Direct networking is inconvenient or unavailable.

CodeFly Relay is useful when:

- the host is behind NAT
- the host does not have a stable public IP address
- port forwarding is not available
- you want the host reachable while traveling
- the network blocks inbound connections to the host

Steps:

1. Run `codefly` on the computer.
2. Choose `2. Manage local relay connection`.
3. Choose `2. Add a new bound relay account`.
4. Sign in to the CodeFly mobile app with one supported OAuth provider, such as Apple, Google, GitHub, or WeChat.
5. Pair from the CodeFly mobile app.
6. The host will receive a Relay credential and open an outbound connection.
7. The mobile app will show the host when the Relay binding is active.

CodeFly Relay requires OAuth sign-in because Relay access is tied to subscribed host seats. Direct Mode continues to work even if you do not use Relay.

## Start Your First Session

After pairing:

1. Open the CodeFly mobile app.
2. Select the paired host.
3. Choose a workspace.
4. Choose Codex or Claude Code.
5. Start a new session or resume an existing one.

From the phone, you can:

- create tasks and start sessions
- send follow-up instructions
- view session status
- respond to approval prompts
- inspect changed files and diffs
- interrupt or continue a running session
- switch between available local providers

Provider tools still run on your computer. CodeFly gives you a mobile control surface for those local sessions.

## Troubleshooting

### Direct Pairing Fails

Check that:

- the phone and computer are on networks that can reach each other
- the Direct port is allowed by the computer firewall
- the displayed host address is reachable from the phone
- a VPN or tunnel is connected before pairing

### The Host Is Not Listed With CodeFly Relay

Check that:

- the mobile app is signed in
- the signed-in user has an active Relay trial or subscription
- the subscribed host seat limit has not been reached
- the host computer can make outbound HTTPS/WebSocket connections

### Codex Or Claude Code Is Missing

CodeFly Host uses the provider tools installed on your computer. Make sure the provider is installed, signed in, and usable from the same user account that runs `codefly`.

## Next Steps

- Read [Security Whitepaper](SECURITY_WHITEPAPER.md) to understand encryption and Relay boundaries.
- Read [Self-Hosted Relay](SELF_HOSTED_RELAY.md) to use Direct Mode over your own VPN, proxy, or tunnel.
- Read [Advanced Configuration](ADVANCED.md) for host settings and environment variables.
- Read [Commercial Model](COMMERCIAL.md) to understand Direct and Relay pricing.
