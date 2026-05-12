<p align="center">
  <img src="docs/assets/codefly-github-header.png" alt="CodeFly" />
</p>

<h2 align="center">Seamless mobile client for Codex and Claude Code workflows.</h2>

<p align="center">
  <a href="https://codefly.run">🌐 Website</a> ·
  <a href="docs/QUICKSTART.md">⚡ Quickstart</a> ·
  <a href="docs/SECURITY_WHITEPAPER.md">🔐 Security</a> ·
  <a href="docs/COMMERCIAL.md">💳 Commercial</a> ·
  <a href="docs/PRIVACY.md">🛡️ Privacy</a> ·
  <a href="docs/TERMS.md">📜 Terms</a> ·
  <a href="https://codefly.run/support">💬 Support</a>
</p>

<p align="center">
  <a href="https://apps.apple.com/app/id6762831575">
    <img alt="Download on the App Store" src="https://img.shields.io/badge/App%20Store-Download-0D96F6?style=for-the-badge&logo=apple&logoColor=white" />
  </a>
  <a href="https://play.google.com/store/apps/details?id=com.codefly.run">
    <img alt="Get it on Google Play" src="https://img.shields.io/badge/Google%20Play-Get%20it-34A853?style=for-the-badge&logo=googleplay&logoColor=white" />
  </a>
</p>

CodeFly lets you start new tasks, resume existing sessions, approve actions, inspect changed files, review diffs, and keep a complete vibe coding flow moving from iOS or Android while Codex and Claude Code keep running on your own computer.

It is not a cloud IDE. Provider tools, accounts, workspaces, and native session history remain on your host machine.

## 📲 Install

Install the mobile app first:

<p>
  <a href="https://apps.apple.com/app/id6762831575">
    <img alt="Download on the App Store" src="https://img.shields.io/badge/App%20Store-Download-0D96F6?style=for-the-badge&logo=apple&logoColor=white" />
  </a>
  <a href="https://play.google.com/store/apps/details?id=com.codefly.run">
    <img alt="Get it on Google Play" src="https://img.shields.io/badge/Google%20Play-Get%20it-34A853?style=for-the-badge&logo=googleplay&logoColor=white" />
  </a>
</p>

Then install the host package on the computer where Codex or Claude Code is already installed and signed in, or configured with a usable API key.

```bash
npm install -g codefly-host
```

Start the host menu:

```bash
codefly
```

CodeFly requires Node.js 20.19 or newer. Continue with the [Quickstart](docs/QUICKSTART.md) to bind the mobile app.

## 🔌 Connection Modes

| Mode | Best for | Sign-in | Cost |
| --- | --- | --- | --- |
| [Direct](docs/QUICKSTART.md#direct-mode) | Local Wi-Fi or a directly reachable public address | Not required | Free forever |
| [Self-Hosted Relay](docs/SELF_HOSTED_RELAY.md) | Your own TCP proxy, tunnel, VPN, or network path | Not required | Free forever |
| [CodeFly Relay](docs/QUICKSTART.md#codefly-relay) | NAT, changing IP addresses, restrictive networks, travel, no port forwarding | OAuth sign-in recommended for multi-device use | Subscription by host seat |

Direct and self-hosted paths stay free because they do not consume CodeFly Relay infrastructure. CodeFly Relay adds managed reachability while keeping the same encrypted phone-host payload boundary. See [Commercial](docs/COMMERCIAL.md), [Privacy](docs/PRIVACY.md), and the [Security Whitepaper](docs/SECURITY_WHITEPAPER.md) for details.

## ✨ Highlights

- Start new Codex or Claude Code sessions from your phone.
- Resume existing host sessions that are already available on the computer.
- Use a complete mobile vibe coding workflow: prompts, approvals, files, diffs, status, and interruptions.
- Choose Direct, self-hosted reachability, or CodeFly Relay based on your network.
- Configure Direct with a reachable host address, plus one or more local listener addresses.

## 📚 Documentation

- [Quickstart](docs/QUICKSTART.md): install CodeFly and bind the mobile app with Direct or Relay.
- [Security Whitepaper](docs/SECURITY_WHITEPAPER.md): encryption, pairing, Relay forwarding, and security boundaries.
- [Self-Hosted Relay](docs/SELF_HOSTED_RELAY.md): use Direct Mode over your own VPN, TCP proxy, tunnel, or private network.
- [Advanced Configuration](docs/ADVANCED.md): host settings, listener addresses, certificate management, and binding removal.
- [Commercial Model](docs/COMMERCIAL.md): Relay subscription model, trials, and availability.
- [Privacy](docs/PRIVACY.md): data processing, deletion, and retention model.
- [Terms of Service](docs/TERMS.md): product terms for Direct Mode, self-hosted reachability, CodeFly Relay, billing, and acceptable use.

## 🧭 How CodeFly Works

```text
CodeFly Mobile App <-> CodeFly Host <-> Codex / Claude Code
```

CodeFly Host runs on your computer and talks to Codex or Claude Code locally. The mobile app connects to the host, so the provider tools remain on your machine while your phone becomes a mobile control surface.

```mermaid
flowchart LR
  Phone["CodeFly Mobile App"]
  Host["CodeFly Host<br/>your computer"]
  Providers["Codex / Claude Code<br/>local provider tools"]
  Relay["CodeFly Relay<br/>managed reachability"]
  UserNetwork["Self-hosted path<br/>VPN / tunnel / proxy"]

  Phone -->|"Direct<br/>local Wi-Fi or public address"| Host
  Phone -->|"Self-hosted reachability"| UserNetwork --> Host
  Phone -->|"CodeFly Relay"| Relay --> Host
  Host --> Providers
```

## 🤖 Supported Agents

- Codex
- Claude Code

## 📄 License

CodeFly is licensed under the [Apache License 2.0](LICENSE).
