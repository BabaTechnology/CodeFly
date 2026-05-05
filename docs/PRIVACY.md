# Privacy Policy

Version: 1.0

Last updated: May 5, 2026

This Privacy Policy explains how Shenzhen Baba Technology Co., Ltd. ("CodeFly", "we", "us", or "our") handles data for CodeFly Host, CodeFly mobile apps, CodeFly Relay, the CodeFly website, documentation, support, and related services.

## Summary

- Direct Mode does not require OAuth sign-in.
- Direct Mode does not route session traffic through CodeFly Relay.
- CodeFly Relay uses Relay entitlements and subscribed host seats. OAuth sign-in lets a user's entitlement work across their own devices; without OAuth sign-in, a purchase may be limited to the device that made the purchase.
- CodeFly cannot access data transmitted between the phone and host, and does not record transmitted content.
- Provider sessions remain on the user's host computer.
- Users can delete OAuth-linked profile, Relay, and device data from inside the app, or contact support if they cannot access the app.

## Product Surfaces Covered

This policy covers:

- CodeFly Host
- CodeFly mobile apps
- CodeFly Relay
- OAuth-linked user profile and billing systems
- CodeFly website, support, feedback, and operational systems

Provider tools such as Codex and Claude Code have their own privacy and data handling practices.

## Data In Direct Mode

Direct Mode connects the mobile app directly to the host.

CodeFly servers do not need to process Direct session traffic. If the user does not sign in with an OAuth provider, use Relay, submit feedback, or contact support, CodeFly may have no server-side user profile for that Direct-only use.

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
- host-side certificate and key files

By default, CodeFly Host stores this data in `./data` under the directory where `codefly` is launched. Users can change the location with `HOST_CLIENT_DATA_DIR`. This applies across macOS, Linux, and Windows because the default is relative to the current working directory.

Users control the host computer and can remove local host data by stopping CodeFly Host and deleting the host data directory. Deleting local host data removes local pairing records and local Relay binding state from that computer, but it does not cancel store subscriptions or delete server-side account records.

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

Payment method details are handled by the applicable payment platform, not stored directly by CodeFly.

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

Diagnostics should not include plaintext coding session content. Relay operational diagnostics are used as needed for routing, abuse prevention, reliability, billing integrity, support, and security. Feedback submitted through the app or website may include contact information if the user chooses to provide it.

## Data Deletion

Users can delete data at several levels.

### Remove A Paired Device

Removing a paired device revokes its ability to connect to the host.

From the host, run `codefly`, choose `Manage local direct connection`, then choose `Manage bound direct clients` and remove the selected client.

From the mobile app, remove the host from the host list. Host cards support swipe actions, including delete. Removing a host from the phone deletes the mobile-side pairing record for that device.

### Remove A Relay Host Binding

Removing a Relay host binding stops that host from connecting through CodeFly Relay for the selected user.

From the host, run `codefly`, choose `Manage local relay connection`, then choose `Manage bound relay accounts` and remove the selected binding.

From the mobile app, delete the Relay host from the host list. If the other side can still reach CodeFly Relay, the removal is synchronized through CodeFly so the corresponding binding is also revoked.

### Delete An OAuth-Linked Profile

Open CodeFly, go to Settings, then choose `Delete My Data` at the bottom of the Settings page. The app shows a timed warning and a final confirmation before deleting account data. Automated deletion requires a linked OAuth identity so CodeFly can verify which account owns the data.

The deletion flow removes or revokes:

- OAuth-linked account links
- Relay host bindings and occupied host seats
- signed-in device links
- active CodeFly API tokens
- installation push-token/user linkage
- active subscription entitlement links

OAuth identity rows are anonymized so the original provider identity can no longer map back to the deleted CodeFly account. CodeFly keeps non-identifying subscription and order history where needed for audit, billing integrity, service integrity, and abuse prevention.

Deleting CodeFly data does not cancel App Store, Google Play, or other payment-platform auto-renewal. Cancel any active subscription in the relevant payment platform before deleting data if you do not want future renewals.

If you cannot access the app, visit [https://codefly.run/delete_my_data](https://codefly.run/delete_my_data) for instructions, submit a request through [https://codefly.run/feedback](https://codefly.run/feedback), or contact `codefly@babatech.cn`.

### Delete Local Host Data

Local host data remains on the user's computer and can be removed from that computer.

To fully reset a host:

1. Stop CodeFly Host.
2. Find the host data directory. By default it is `./data` under the directory where `codefly` was launched, unless `HOST_CLIENT_DATA_DIR` is set.
3. Delete that directory.
4. Start `codefly` again and pair the host as a new host if needed.

## Retention

CodeFly retains data only as long as reasonably needed for service operation, security, abuse prevention, billing integrity, legal compliance, support, and backup integrity.

Retention model:

- plaintext session content should not be retained by CodeFly Relay because it should never be received in plaintext
- OAuth-linked account records are removed or anonymized when the in-app deletion flow succeeds
- active Relay bindings, signed-in devices, push token links, and entitlement links are removed when the account deletion flow succeeds
- operational logs and routing metadata are retained for a limited operational period needed for reliability, security, and abuse prevention
- billing and subscription records may be retained in non-identifying or payment-platform-linked form where needed for audit, dispute handling, fraud prevention, tax, store compliance, and service integrity
- support and feedback records are retained as long as needed to respond to the request and maintain support history
- deleted data may remain in encrypted backups for a limited backup lifecycle before automatic expiration

## Subprocessors

CodeFly may use third-party service providers for hosting, authentication, billing, app distribution, push notifications, crash reporting, support, analytics, diagnostics, and infrastructure operations.

These providers process data only as needed to provide their services to CodeFly. Payment method details are handled by the applicable payment platform. OAuth providers process sign-in according to their own terms and privacy policies.

## User Rights And Contact

Users can contact CodeFly for privacy requests at `codefly@babatech.cn`.

## Changes

CodeFly may update this policy as the product, infrastructure, or legal requirements change. Material changes will be reflected with a new version or last-updated date.
