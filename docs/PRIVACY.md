# Privacy

Version: draft 0.1

This document explains how CodeFly Host, CodeFly mobile apps, and CodeFly Relay handle user data.

[PLACEHOLDER: replace with final legal privacy policy before public launch]

## Summary

- Direct Mode does not require OAuth sign-in.
- Direct Mode does not route session traffic through CodeFly Relay.
- CodeFly Relay uses Relay entitlements and subscribed host seats. OAuth sign-in lets a user's entitlement work across their own devices; without OAuth sign-in, a purchase may be limited to the device that made the purchase.
- CodeFly cannot access data transmitted between the phone and host, and does not record transmitted content.
- Provider sessions remain on the user's host computer.
- Users should be able to delete OAuth-linked profile, Relay, and device data through documented flows.

## Product Surfaces Covered

This document covers:

- CodeFly Host
- CodeFly mobile apps
- CodeFly Relay
- OAuth-linked user profile and billing systems
- CodeFly support and operational systems

Provider tools such as Codex and Claude Code have their own privacy and data handling practices.

## Data In Direct Mode

Direct Mode connects the mobile app directly to the host.

CodeFly servers do not need to process Direct session traffic. If the user does not sign in with an OAuth provider or use Relay, CodeFly may have no server-side user profile for that Direct-only use.

Data involved in Direct Mode may include:

- host identity stored on the host
- mobile device identity stored on the phone
- paired device public keys
- Direct auth token stored on the phone
- Direct auth token hash stored on the host
- local host configuration
- local app preferences and cached UI state

This data is stored on user-controlled devices unless the user separately uses OAuth sign-in, support, diagnostics, or Relay features.

## Data In CodeFly Relay

CodeFly Relay uses CodeFly infrastructure to route encrypted traffic between phone and host.

Relay-side data may include:

- OAuth-linked user identity
- OAuth provider identifiers
- subscription and host-seat records
- host binding identifiers
- host public keys and fingerprints
- device identifiers and public keys used for routing
- host online/offline presence
- connection timestamps and operational logs
- IP-derived network metadata
- message sizes
- push notification tokens and notification metadata
- billing provider references

Relay-side data is used to provide OAuth sign-in, billing, host routing, notifications, abuse prevention, reliability, and support.

## Data CodeFly Relay Does Not Store

CodeFly Relay does not store plaintext transmitted content, including:

- prompts
- assistant responses
- source code sent through CodeFly frames
- command output
- approval prompt details
- choice question details
- diffs returned inside encrypted app frames
- provider-native session databases
- provider account tokens stored by Codex or Claude Code on the user's computer

Application payloads are encrypted between the phone and host. The Relay forwards encrypted frames and needs routing metadata to deliver them.

## Data Stored On The Host

CodeFly Host may store:

- host identity and host secret key
- paired device identifiers and public keys
- paired device auth token hashes
- Relay binding records and Relay host credentials
- host configuration and runtime configuration

Users control the host computer and can remove local host data by deleting the CodeFly Host data directory.

[PLACEHOLDER: document the default data directory for macOS, Linux, and Windows]

## Data Stored On The Phone

The mobile app may store:

- device identity and device secret key
- paired host public keys and fingerprints
- Direct auth tokens
- OAuth session tokens used for Relay access
- local app preferences
- cached UI state

Users can remove local mobile data by deleting the app or using in-app removal flows where available.

## Billing Data

Relay subscriptions require billing records.

CodeFly may process:

- plan name
- subscribed host count
- trial state
- subscription status
- billing provider customer ID
- billing provider subscription ID
- purchase or renewal metadata

Payment method details are expected to be handled by the billing provider, not stored directly by CodeFly.

[PLACEHOLDER: billing provider name and links]

## Diagnostics And Support

CodeFly may collect operational diagnostics needed to keep the service reliable.

Diagnostics may include:

- app version
- host version
- platform and OS version
- connection status
- error codes
- crash reports
- coarse timing and performance metrics

Diagnostics should not include plaintext coding session content.

[PLACEHOLDER: decide whether diagnostics are opt-in, opt-out, or always-on for Relay operations]

## Data Deletion

Users should be able to delete data at several levels.

### Remove A Paired Device

Removing a paired device should revoke its ability to connect to the host.

[PLACEHOLDER: in-app and CLI steps for removing paired devices]

### Remove A Relay Host Binding

Removing a Relay host binding should stop that host from connecting through CodeFly Relay.

[PLACEHOLDER: in-app and CLI steps for removing Relay bindings]

### Delete An OAuth-Linked Profile

Profile deletion should remove or anonymize OAuth-linked data according to the final retention policy.

Expected deletion scope:

- OAuth-linked user profile
- login identifiers where possible
- subscription records subject to billing/legal retention
- Relay host bindings
- device routing records
- push tokens
- support records subject to support/legal retention

[PLACEHOLDER: profile deletion URL or support email]

### Delete Local Host Data

Local host data remains on the user's computer and can be removed from that computer.

[PLACEHOLDER: exact host data directory paths and reset command]

## Retention

[PLACEHOLDER: define retention windows for OAuth-linked profile records, Relay operational logs, push tokens, deleted profiles, backups, billing records, and support tickets]

Suggested product principle:

- plaintext session content should not be retained by CodeFly Relay because it should never be received in plaintext
- operational metadata should be retained only as long as needed for service reliability, abuse prevention, billing, legal compliance, and support
- deleted profile data should be removed from active systems within a clear published timeframe

## Subprocessors

CodeFly may use service providers for:

- hosting
- authentication
- billing
- app distribution
- push notifications
- crash reporting
- support
- analytics or diagnostics

[PLACEHOLDER: list subprocessors before public launch]

## User Rights And Contact

Users can contact CodeFly for privacy requests.

[PLACEHOLDER: privacy contact email]

[PLACEHOLDER: company legal name and mailing address]

## Changes

CodeFly may update this document as the product, infrastructure, or legal requirements change. Material changes should be reflected with a new version date.
