# CodeFly Host Security Whitepaper

Version: draft 0.1

CodeFly is designed around a simple rule: coding session content should be readable only by the user's phone and the user's own host computer.

This document explains the security model for CodeFly Host, including Direct connections, Relay connections, pairing, encryption, what CodeFly servers can see, and what they cannot see.

[PLACEHOLDER: high-level architecture diagram showing Mobile App, CodeFly Host, CodeFly Relay, Codex, and Claude Code]

## Summary

- CodeFly Host runs on the user's computer, next to Codex and Claude Code.
- The CodeFly mobile app connects to the host through Direct Mode or CodeFly Relay.
- Direct Mode is free forever and does not require OAuth sign-in.
- CodeFly Relay is optional and is billed by subscribed host seats.
- Communication between the mobile app and host is encrypted with a host-side certificate and host-controlled security material.
- CodeFly cannot access data transmitted between the phone and host, and does not record transmitted content.

## Security Goals

CodeFly Host is built to protect:

- prompts and follow-up instructions
- assistant responses
- approval and choice prompts
- command and tool output
- file contents sent through CodeFly
- diffs and Git information returned through CodeFly
- provider runtime details that travel inside encrypted app frames

The Relay service is designed so that a server-side data exposure does not reveal plaintext coding session content.

## System Components

```text
Mobile App <-> CodeFly Host <-> Codex / Claude Code
```

CodeFly has four security-relevant components:

- Mobile app: stores the mobile device identity and talks to the host.
- CodeFly Host: runs locally on the user's computer and controls local provider sessions.
- CodeFly Relay: optional routing service for networks where Direct access is not practical.
- Provider tools: Codex and Claude Code, installed and authenticated on the user's computer.

CodeFly is not a remote IDE. Provider tools continue to run locally, with their own accounts, configuration, sandbox behavior, and session history.

## Connection Modes

### Direct Mode

Direct Mode connects the mobile app directly to CodeFly Host.

```text
Phone <==== encrypted CodeFly frames ====> Host
```

Direct Mode properties:

- OAuth sign-in is not required.
- No Relay server is used for session traffic.
- The same secure host communication model is used as CodeFly Relay.
- The host listens on the configured Direct port, default `7788`.

Direct Mode works when the phone can reach the computer on the network, such as local Wi-Fi, VPN, private network overlay, or a user-managed TCP tunnel.

### CodeFly Relay

CodeFly Relay connects both endpoints to CodeFly Relay.

```text
Phone <==== encrypted CodeFly frames ====> Relay <==== encrypted CodeFly frames ====> Host
```

CodeFly Relay properties:

- The phone and host both make outbound connections.
- No port forwarding is required.
- Relay access is tied to OAuth sign-in and subscribed host seats.
- The Relay routes encrypted frames by host seat and device identity.
- The Relay forwards encrypted traffic and cannot access transmitted content.

CodeFly Relay exists to solve practical networking problems: NAT, firewalls, changing IP addresses, and computers that need to be reachable while the user is away.

## Cryptographic Design

CodeFly uses host-controlled transport security and public-key authenticated encryption for application frames.

### Host Certificate

The secure connection between the mobile app and CodeFly Host uses a host-side certificate. By default, CodeFly Host generates and stores this certificate locally on the host computer. CodeFly does not issue, store, or have access to the host certificate private key.

The host certificate is independent from CodeFly Relay. When CodeFly Relay is used, the Relay forwards traffic between endpoints, but it does not receive the host certificate private key and cannot use it to decrypt host-phone communication.

The CLI can show the certificate path, key path, certificate fingerprint, and host public key fingerprint under `Manage security certificate`.

### Application Frames

CodeFly also uses public-key authenticated encryption for application frames.

Current implementation:

- Library: `tweetnacl`
- Primitive: `nacl.box`
- Key pairs: generated for host and device identities
- Nonce: random nonce per encrypted frame
- Payload format: JSON application message encrypted as ciphertext

Each encrypted frame contains routing metadata and ciphertext:

```text
{
  kind: "encrypted",
  routeMode,
  seatId,
  senderId,
  recipientId,
  senderPublicKey,
  nonce,
  ciphertext,
  timestamp
}
```

The Relay needs routing metadata to deliver frames. The Relay does not have the host certificate private key or endpoint secret keys required to decrypt transmitted content.

[PLACEHOLDER: frame anatomy diagram showing visible routing metadata vs encrypted payload]

## Pairing Model

Pairing is QR-based so users do not need to copy tokens or configure complex network settings during first setup.

### Direct Pairing

Direct pairing flow:

1. The user runs `codefly` on the host computer.
2. The host issues a short-lived pairing code.
3. The host displays a QR code containing the Direct address, pairing code, and host public key.
4. The mobile app scans the QR code.
5. The mobile app sends an encrypted `pair_request` to the host.
6. The host validates the pairing code.
7. The host stores the paired device public key and an auth token hash.
8. The mobile app receives the auth token inside an encrypted `pair_confirm` response.

After pairing, future Direct requests require the paired device identity and auth token. The host stores only a hash of the auth token.

### Relay Pairing

Relay pairing flow:

1. The user runs `codefly` on the host computer.
2. The host asks CodeFly Relay for a short-lived Relay pairing token.
3. The host displays a QR code containing the Relay node and pairing token.
4. The mobile app scans the QR code and claims the pairing under the signed-in OAuth-linked user profile.
5. The Relay creates or updates a host binding for the subscribed host seat.
6. The host receives a Relay credential through the pairing status channel.
7. The host opens a long-lived outbound Relay connection.

The Relay credential lets the host connect to the Relay for that binding. It does not let the Relay decrypt application frames.

## What CodeFly Servers Can See

CodeFly Relay needs a small amount of metadata to operate the service.

When CodeFly Relay is used, CodeFly servers may process:

- OAuth-linked user identity needed for sign-in and subscription checks
- subscription and subscribed host count
- host binding identifiers
- host public key and fingerprint
- device identifiers and public keys used for routing
- host online/offline presence
- Relay connection metadata such as timestamps, IP-derived network metadata, and message sizes
- push notification metadata needed to notify the user's devices

This metadata is operational data, not plaintext coding session content.

## What CodeFly Servers Cannot See

CodeFly servers cannot access or record the data transmitted between the phone and host. This includes:

- prompts
- assistant responses
- source code sent through CodeFly frames
- file contents returned through CodeFly file APIs
- command output
- approval prompt details
- choice question details
- diffs returned inside encrypted app frames
- provider account tokens stored by Codex or Claude Code on the user's machine
- provider-native session databases on the host

The Relay forwards encrypted transport frames. Without the host certificate private key and endpoint secret keys, the Relay cannot decrypt the transmitted content.

## Data Stored On The Host

CodeFly Host stores local runtime state so paired devices and Relay bindings continue to work after restart.

Host-side state may include:

- host identity and host secret key
- paired device identifiers and public keys
- paired device auth token hashes
- Relay binding records and Relay host credentials
- host configuration and runtime configuration

Host-side state is local to the computer running CodeFly Host. Protecting that computer account and filesystem remains important.

## Data Stored On The Phone

The mobile app stores the device identity and pairing material needed to talk to the host.

Phone-side state may include:

- device identity and device secret key
- paired host public keys and fingerprints
- Direct auth tokens
- OAuth session tokens used for Relay access
- local app preferences and cached UI state

The exact storage mechanism depends on the mobile platform.

## Data Stored By The Relay

Relay-side data supports OAuth sign-in, billing, host routing, and notifications.

Relay-side data may include:

- OAuth-linked user profile records
- external login identifiers
- subscription and host-seat records
- Relay host bindings
- Relay credentials or credential validation material
- host public keys and fingerprints
- installation and push token records
- notification outbox entries
- connection events and operational logs

Relay-side data is not intended to include plaintext session transcripts, source files, command output, or provider-owned session databases.

## Transport Limits And Large Frames

CodeFly uses bounded transport frames to reduce abuse and memory risk.

Current limits:

- Maximum transport packet: 256 KiB
- Encrypted chunk payload: 180 KiB
- Maximum reassembled encrypted frame: 64 MiB
- Reassembly TTL: 60 seconds

Large encrypted frames are split into encrypted chunks. Chunks keep routing metadata so the transport can deliver them, but only endpoints reassemble and decrypt the final application frame.

## Threat Model

### Server-Side Data Exposure

If a CodeFly Relay database or Relay process is exposed, the attacker should not obtain plaintext coding session content from encrypted application frames.

The attacker may obtain operational metadata such as OAuth-linked profile records, host bindings, presence, push notification metadata, and routing metadata. This is still sensitive and is protected as service data, but it is not the same as source code or session transcripts.

### Network Observer

Network observers see TLS-protected traffic to Relay endpoints or Direct traffic containing encrypted CodeFly frames. The application payload remains encrypted between phone and host.

### Malicious Relay

A malicious or compromised Relay can drop, delay, or refuse to route frames. It can observe routing metadata and message sizes. It should not be able to decrypt application payloads without endpoint secret keys.

### Compromised Host

If the host computer is compromised, the attacker may access local provider tools, workspaces, provider accounts, CodeFly Host state, and live session content. CodeFly cannot protect a session from a compromised endpoint.

### Compromised Phone

If the paired phone is compromised, the attacker may access the mobile device identity, host pairings, Relay tokens, and visible session content. Users should remove unknown or lost devices from the host and the mobile app.

## Security Boundaries And Limitations

CodeFly's end-to-end encryption protects application payloads between phone and host. It does not mean:

- the host computer can be compromised safely
- the phone can be compromised safely
- provider tools cannot read their own sessions
- metadata is invisible to the Relay
- push notifications contain no metadata
- CodeFly Relay works without OAuth sign-in or a subscribed host seat

The strongest security boundary is between encrypted session content and the Relay service.

## Commercial Model And Privacy Alignment

CodeFly's pricing model follows the architecture:

- Direct Mode is free forever because it does not consume CodeFly Relay infrastructure.
- CodeFly Relay is paid because CodeFly operates the always-available routing service.
- Relay plans are based on subscribed host seats.

Users who can connect directly do not need to pay. Users who need reliable remote routing pay only for the hosts they connect through the Relay.

## Future Hardening

Planned or recommended hardening areas:

- Independent security review of the pairing and Relay protocol.
- Public protocol diagrams and test vectors.
- Clearer device removal and lost-device recovery documentation.
- Optional enterprise controls for Relay host governance.
- More visible in-app warnings for trust changes such as host key rotation.
