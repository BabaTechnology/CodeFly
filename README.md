# CodeFly Host

Control Codex and Claude Code from your phone.

CodeFly Host is the small daemon that runs on your computer next to your existing AI coding tools. Pair it with the CodeFly mobile app, scan one QR code, and you can watch progress, send follow-up instructions, approve actions, inspect files, and check Git changes from iOS or Android.

[PLACEHOLDER: product screenshot showing the mobile app connected to a running host]

## Install

Install the host package on the computer where Codex or Claude Code is already installed and signed in.

```bash
npm install -g codefly-host
```

Start the host menu:

```bash
codefly
```

CodeFly Host requires Node.js 20.19 or newer.

## Quick Start

1. Install the CodeFly mobile app for iOS or Android.
2. Run `codefly` on your computer.
3. Choose direct pairing for a local/free connection, or relay pairing for remote access.
4. Scan the QR code from the mobile app.
5. Open a workspace, choose Codex or Claude Code, and start controlling the session from your phone.

Direct pairing does not require a CodeFly account. Relay pairing requires an account because relay access is tied to a host subscription.

## Links

- iOS app: [PLACEHOLDER: App Store URL]
- Android app: [PLACEHOLDER: Google Play URL]
- Website: [PLACEHOLDER: https://codefly.run]
- Documentation: [PLACEHOLDER: public docs URL]
- Security whitepaper: [docs/security-whitepaper.md](docs/security-whitepaper.md)
- Support: [PLACEHOLDER: support email, issue tracker, or community URL]

## Why CodeFly

- Mobile first: built for checking and controlling coding sessions from a phone, not for replacing your editor.
- Simple setup: install the host package, run `codefly`, scan a QR code.
- Direct mode is free forever: connect your phone to your computer directly when the host is reachable.
- Relay mode is optional: use CodeFly Relay when direct access is blocked by NAT, changing IP addresses, firewalls, or travel.
- End-to-end encrypted: session traffic is encrypted between your phone and your host. The relay cannot read prompts, code, command output, diffs, or approval details.
- Provider-native: Codex and Claude Code keep running on your machine with their own accounts, config, tools, and session history.

## How It Works

```text
CodeFly Mobile App <-> CodeFly Host <-> Codex / Claude Code
```

With direct mode, the mobile app connects to the host over the network and uses CodeFly's encrypted frame protocol.

```text
Phone <==== end-to-end encrypted direct connection ====> Host
```

With relay mode, the phone and host both connect out to CodeFly Relay. The relay forwards encrypted frames but does not decrypt session content.

```text
Phone <==== encrypted app frames ====> CodeFly Relay <==== encrypted app frames ====> Host
```

[PLACEHOLDER: simple architecture diagram for direct and relay modes]

## Direct Mode

Direct mode is the simplest path when your phone can reach your computer on the network.

- Free forever.
- No CodeFly account required.
- Uses the same end-to-end encrypted application frames as relay mode.
- Best for local Wi-Fi, VPN, private network overlays, or any setup where your phone can reach the host address.

Default direct port:

```text
7788
```

If your direct address changes, run `codefly` again and create a new QR code.

## Relay Mode

Relay mode is for the cases where direct networking is annoying or impossible.

- Your phone and host both connect out to CodeFly Relay.
- No port forwarding is required.
- The relay routes encrypted frames and host presence.
- The relay cannot decrypt session content.
- Relay access is billed by the number of subscribed hosts.

Relay is useful when your computer is behind NAT, has no stable public IP address, is on a restrictive network, or needs to be reachable while you are away.

## Pricing Model

CodeFly's business model is intentionally simple:

- Direct connections are free forever.
- Relay connections are paid because CodeFly runs the always-available routing service.
- Relay subscriptions are based on the number of host computers you want to keep connected.

[PLACEHOLDER: pricing page URL]

## Supported Agents

CodeFly Host currently supports:

- Codex
- Claude Code

Both providers run locally on your computer. CodeFly does not replace their official desktop, terminal, or IDE experiences. It gives you a phone control surface for the moments when you are away from your keyboard.

## Advanced Configuration

For most users, the interactive `codefly` menu is enough.

Advanced users can configure the host with environment variables:

- `HOST_CLIENT_PORT`: direct mode port, default `7788`.
- `HOST_CLIENT_DIRECT_PUBLIC_HOST`: host name or IP address shown in direct pairing QR codes.
- `HOST_CLIENT_WORKSPACE_DIR`: default workspace root.
- `HOST_CLIENT_ADAPTER`: `multi`, `codex`, or `claude`.
- `RELAY_URL`: custom relay URL for relay pairing.

## License

CodeFly Host is licensed under the Apache License 2.0.
