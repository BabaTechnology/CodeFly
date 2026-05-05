# CodeFly Host

Seamlessly continue your Codex and Claude Code workflow on your phone.

[Website](#placeholder-website-url) · [Quickstart](docs/QUICKSTART.md) · [Security](docs/SECURITY_WHITEPAPER.md) · [Commercial](docs/COMMERCIAL.md) · [Privacy](docs/PRIVACY.md) · [Support](#placeholder-support-url)

CodeFly Host is the small daemon that runs on your computer next to your existing AI coding tools. Pair it with the CodeFly mobile app for a smooth, near-native mobile experience: create tasks, start sessions, steer complete vibe coding workflows, approve actions, inspect changed files, check Git diffs, and continue long-running work from iOS or Android.

CodeFly supports Direct Mode, self-hosted reachability through your own network path, and CodeFly Relay for managed remote access.

[PLACEHOLDER: hero screenshot showing the mobile app controlling a running Codex or Claude Code session]

## Install

Download the CodeFly mobile app:

[App Store](#placeholder-app-store-url) · [Google Play](#placeholder-google-play-url)

Install the host package on the computer where Codex or Claude Code is already installed and signed in.

```bash
npm install -g codefly-host
```

Start the host menu:

```bash
codefly
```

CodeFly Host requires Node.js 20.19 or newer.

Continue with the [Quickstart](docs/QUICKSTART.md) to connect your phone using Direct Mode or CodeFly Relay.

## Connection Modes

| Mode | Best for | Sign-in | Cost |
| --- | --- | --- | --- |
| [Direct](docs/QUICKSTART.md#direct-mode) | Local Wi-Fi, private networks, VPNs, or any reachable host address | Not required | Free forever |
| [Self-Hosted Relay](docs/SELF_HOSTED_RELAY.md) | Your own TCP proxy, tunnel, VPN, or private overlay | Not required | Free forever |
| [CodeFly Relay](docs/QUICKSTART.md#codefly-relay) | NAT, changing IP addresses, restrictive networks, travel, no port forwarding | OAuth sign-in required | Subscription by host seat |

We want CodeFly to be usable by everyone who needs mobile access, so Direct Mode is not intentionally limited just because it is free. CodeFly Relay provides convenient, maintenance-free, high-availability remote reachability while keeping the same end-to-end encrypted security model as Direct Mode.

CodeFly cannot access or record your session content. See [Commercial](docs/COMMERCIAL.md) and [Privacy](docs/PRIVACY.md) for details.

## Why CodeFly

- Mobile workflow continuity: start and continue Codex or Claude Code sessions from your phone.
- Native-feeling control: approvals, changed files, diffs, status, and session actions are designed for mobile use.
- Local-first by default: use Direct Mode whenever your phone can reach your host.
- Managed remote access when needed: use CodeFly Relay when you want reliable reachability without maintaining network infrastructure.
- End-to-end encrypted: CodeFly cannot access data transmitted between your phone and host, and does not record transmitted content.
- Provider-native: Codex and Claude Code keep running on your machine with their own accounts, config, tools, and session history.

## Documentation

- [Quickstart](docs/QUICKSTART.md): install CodeFly Host and pair the mobile app with Direct or Relay.
- [Security Whitepaper](docs/SECURITY_WHITEPAPER.md): end-to-end encryption, pairing, Relay forwarding, and security boundaries.
- [Self-Hosted Relay](docs/SELF_HOSTED_RELAY.md): use Direct Mode over your own VPN, TCP proxy, tunnel, or private network instead of CodeFly Relay.
- [Advanced Configuration](docs/ADVANCED.md): host settings and environment variables for advanced setups.
- [Commercial Model](docs/COMMERCIAL.md): Direct free forever, Relay subscription tiers, trials, and availability.
- [Privacy](docs/PRIVACY.md): what data is processed, what is not stored, and how data deletion should work.

## How CodeFly Works

```text
CodeFly Mobile App <-> CodeFly Host <-> Codex / Claude Code
```

CodeFly Host runs on your computer and talks to Codex or Claude Code locally. The mobile app connects to CodeFly Host, so you can create and continue coding sessions from your phone while the provider tools remain on your machine.

There are three ways to make the phone reach the host:

- Direct: the phone reaches the host on a local or private network.
- Self-hosted reachability: you provide a VPN, TCP proxy, tunnel, or private overlay, and CodeFly still uses Direct Mode.
- CodeFly Relay: the phone and host both connect outward to CodeFly Relay for managed remote reachability.

In every mode, CodeFly's session traffic is protected between the mobile app and host. CodeFly Relay is a forwarding service, not a place where session content is decrypted or recorded.

[PLACEHOLDER: simple architecture diagram for Direct, self-hosted reachability, and CodeFly Relay]

## Supported Agents

CodeFly Host currently supports:

- Codex
- Claude Code

Both providers run locally on your computer. CodeFly does not replace their official desktop, terminal, or IDE experiences. It gives you a phone-native control surface for the moments when you are away from your keyboard.

## License

CodeFly Host is licensed under the Apache License 2.0.
