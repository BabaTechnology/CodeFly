# Terms of Service

Version: draft 0.1

Effective date: [PLACEHOLDER: effective date]

[PLACEHOLDER: replace this draft with final legal terms before public launch. This document is product-facing text and should be reviewed by legal counsel.]

These Terms govern access to and use of CodeFly Host, CodeFly mobile apps, CodeFly Relay, documentation, support, and related services provided by [PLACEHOLDER: company legal name] ("CodeFly", "we", "us", or "our").

By using CodeFly, you agree to these Terms. If you use CodeFly on behalf of an organization, you represent that you have authority to accept these Terms for that organization.

## Product Overview

CodeFly lets you connect a mobile device to your own computer so you can start, resume, and steer Codex and Claude Code workflows from iOS or Android.

CodeFly has three main connection paths:

- Direct Mode: the mobile app connects directly to CodeFly Host through a reachable network address.
- Self-hosted reachability: you use your own VPN, TCP proxy, tunnel, private overlay, or similar network path with Direct Mode.
- CodeFly Relay: CodeFly operates a relay service that keeps hosts reachable when direct networking is not practical.

Provider tools such as Codex and Claude Code are third-party tools. Their own accounts, API keys, subscriptions, terms, privacy practices, sandbox behavior, and usage limits continue to apply.

## Accounts And Sign-In

Direct Mode does not require a CodeFly account or OAuth sign-in.

CodeFly Relay may require sign-in with a supported OAuth provider, such as Apple, Google, GitHub, WeChat, or another provider shown in the app. OAuth sign-in is used to associate Relay entitlements with the same user across that user's own devices.

If you purchase Relay access without OAuth sign-in, the purchase may be available only on the device that made the purchase, depending on the payment platform and app behavior.

You are responsible for maintaining the security of your devices, OAuth accounts, provider accounts, API keys, host computer, and local networks.

## Direct Mode

Direct Mode is free to use.

Direct Mode does not route session traffic through CodeFly Relay. You are responsible for making the host reachable to your phone, including network configuration, firewall rules, VPNs, tunnels, DNS, and any related security choices.

CodeFly may provide documentation and product settings that help you configure Direct Mode, but your network environment remains under your control.

## Self-Hosted Reachability

You may use Direct Mode through your own VPN, TCP proxy, SSH tunnel, private overlay, reverse proxy, or similar network setup.

Self-hosted reachability is your own infrastructure and responsibility. CodeFly does not operate, monitor, secure, or troubleshoot third-party or user-managed network infrastructure, although the Direct Mode setup itself is intended to remain simple.

## CodeFly Relay

CodeFly Relay is an optional managed service. It exists to solve practical reachability problems such as NAT, changing IP addresses, restrictive networks, travel, and hosts that cannot receive inbound connections.

Relay access is tied to Relay entitlements and subscribed host seats. A Relay host seat represents one computer that can stay reachable through CodeFly Relay.

Relay traffic remains encrypted between the phone and host. CodeFly cannot access any data transmitted between the host and phone, and does not record transmitted content. The Relay may process operational metadata needed for routing, subscription checks, abuse prevention, reliability, billing, notifications, and support. See the [Security Whitepaper](SECURITY_WHITEPAPER.md) and [Privacy](PRIVACY.md) for details.

We will do our best to keep CodeFly Relay reliable and available, but we do not guarantee uninterrupted access unless a separate written agreement says otherwise. Relay server locations, routing, capacity, and configuration may change over time.

## Subscriptions, Trials, And Billing

CodeFly Relay may be offered through paid subscriptions, trials, promotional access, or special free access.

Prices, taxes, renewal timing, cancellation rules, refund eligibility, trial availability, and billing notices are shown by the applicable payment platform, such as the App Store or Google Play, according to your platform, region, currency, and store rules. We do not list fixed prices in this documentation.

CodeFly is intended to provide a 7-day free Pro trial by default where supported by the payment platform. Exact trial behavior is determined by the payment platform shown in the app.

Students, educators, and project contributors may contact us for special free Relay access. We may grant, modify, or revoke special access at our discretion.

If a Relay trial or subscription ends, Direct Mode can continue to work when your phone can reach the host through your own network path. Ending Relay access does not remove local provider sessions or host data from your computer.

## Acceptable Use

You agree not to use CodeFly to:

- violate applicable laws or regulations
- violate the rights of others
- attack, disrupt, overload, scan, or interfere with CodeFly systems or other users
- bypass subscription limits, host-seat limits, authentication, or access controls
- share Relay entitlements outside your own devices unless CodeFly explicitly allows it
- reverse engineer CodeFly services except where applicable law permits it
- transmit malware or intentionally harmful code through CodeFly services
- use CodeFly in a way that would cause CodeFly to violate third-party service terms

You are responsible for the prompts, code, commands, approvals, files, and provider actions that you initiate through CodeFly.

## Security Responsibilities

CodeFly is designed so that application payloads are encrypted between the phone and host. That design does not remove your responsibility to secure endpoints.

You are responsible for:

- protecting your host computer and mobile devices
- removing lost, stolen, or unknown paired devices
- protecting provider accounts and API keys
- keeping CodeFly Host and the mobile app reasonably up to date
- configuring Direct Mode and self-hosted network paths safely
- reviewing provider tool behavior before approving actions

If either endpoint is compromised, CodeFly cannot protect session content from that compromised endpoint.

## Updates

CodeFly Host and the mobile apps may receive updates, including security fixes, compatibility fixes, and service changes.

CodeFly Host may check for available updates and offer automatic upgrade flows. You are responsible for applying updates where required for security, compatibility, or continued service access.

We may change, suspend, or discontinue features when needed for security, reliability, legal compliance, provider compatibility, or product direction.

## Privacy And Data

CodeFly's data practices are described in the [Privacy](PRIVACY.md) document.

You may request deletion of OAuth-linked profile, Relay, and device data through documented product flows or support channels, subject to retention needed for billing, legal compliance, abuse prevention, backups, support records, and operational integrity.

Local host data and provider sessions remain on your computer and are controlled by you.

## Support

Support is available at [https://codefly.run/support](https://codefly.run/support).

We may provide documentation, troubleshooting guidance, and product support, but we do not guarantee support for user-managed VPNs, tunnels, proxies, firewalls, DNS, routers, third-party providers, or unsupported operating environments.

## Third-Party Services

CodeFly may depend on third-party services for authentication, billing, app distribution, push notifications, hosting, support, diagnostics, or analytics.

Your use of third-party services may be governed by separate terms and privacy policies. CodeFly is not responsible for third-party services that it does not control.

## Intellectual Property

CodeFly software, services, documentation, branding, and related materials are owned by CodeFly or its licensors, except for open source components and third-party materials.

Open source licensing for this repository is described in the [License](../LICENSE). The license for the public CodeFly Host code does not grant rights to CodeFly's hosted Relay service, mobile app distribution, trademarks, or commercial infrastructure.

You retain ownership of your code, prompts, session content, and files. CodeFly does not claim ownership of the content you transmit between your phone and host.

## Disclaimers

CodeFly is provided "as is" and "as available" to the maximum extent permitted by law.

We do not warrant that CodeFly will be uninterrupted, error-free, secure against every possible threat, compatible with every provider version, or suitable for every environment. You are responsible for evaluating CodeFly for your own use case before relying on it.

Provider tools may generate incorrect, unsafe, or unwanted outputs. You are responsible for reviewing and approving actions taken through Codex, Claude Code, or any other provider tool.

## Limitation Of Liability

To the maximum extent permitted by law, CodeFly and its affiliates, officers, employees, contractors, and suppliers will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost profits, lost revenue, lost data, business interruption, security incidents caused by compromised endpoints, or third-party service failures.

To the maximum extent permitted by law, CodeFly's total liability for any claim related to the service will not exceed the amount you paid to CodeFly for Relay access during the twelve months before the claim, or [PLACEHOLDER: minimum statutory amount], whichever is greater.

Some jurisdictions do not allow certain limitations, so some of these limitations may not apply to you.

## Indemnity

You agree to defend, indemnify, and hold harmless CodeFly from claims, damages, liabilities, costs, and expenses arising from your misuse of CodeFly, violation of these Terms, violation of law, violation of third-party rights, or use of provider tools through CodeFly.

## Suspension And Termination

You may stop using CodeFly at any time.

We may suspend or terminate access to CodeFly Relay if we reasonably believe that you violated these Terms, created security or reliability risk, abused the service, bypassed subscription limits, or used the service unlawfully.

Termination of Relay access does not remove local host data or provider sessions from your computer.

## Changes To These Terms

We may update these Terms as the product, infrastructure, legal requirements, or business model changes.

If changes are material, we will take reasonable steps to notify users through the app, website, documentation, or another appropriate channel. Continued use after updated Terms become effective means you accept the updated Terms.

## Governing Law

[PLACEHOLDER: governing law and venue]

## Contact

For questions about these Terms, contact:

[PLACEHOLDER: legal contact email]

[PLACEHOLDER: company legal name and mailing address]
