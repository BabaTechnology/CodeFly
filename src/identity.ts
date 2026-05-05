import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import selfsigned from "selfsigned";
import { generateKeyPair, publicKeyFingerprint, type KeyPair } from "./shared";
import { HostStore } from "./host-store";

const TLS_CERT_VALID_DAYS = 365;
const TLS_CERT_MAX_VALIDITY_MS = 366 * 24 * 60 * 60 * 1000;
const TLS_SERVER_AUTH_OID = "1.3.6.1.5.5.7.3.1";

export interface HostIdentity {
  hostId: string;
  keyPair: KeyPair;
  publicKeyFingerprint: string;
  tlsKeyPath: string;
  tlsCertPath: string;
  tlsKeyPem: string;
  tlsCertPem: string;
  certificateFingerprint: string;
}

export async function ensureHostIdentity(
  store: HostStore,
  dataDir: string,
  hostName: string,
  paths?: { tlsCertPath?: string; tlsKeyPath?: string; certificateHosts?: string[] }
): Promise<HostIdentity> {
  const persistedIdentity = store.getHostIdentity();
  const hostId = persistedIdentity.hostId ?? randomHostId();
  let publicKey = persistedIdentity.publicKey;
  let secretKey = persistedIdentity.secretKey;

  if (!publicKey || !secretKey) {
    const keyPair = generateKeyPair();
    publicKey = keyPair.publicKey;
    secretKey = keyPair.secretKey;
  }
  store.setHostIdentity(hostId, publicKey, secretKey);

  const tlsCertPath = paths?.tlsCertPath ?? path.join(dataDir, "tls.crt");
  const tlsKeyPath = paths?.tlsKeyPath ?? path.join(dataDir, "tls.key");
  const requiredCertificateHosts = normalizeCertificateHosts(paths?.certificateHosts ?? []);
  const generatedCertificateHosts = normalizeCertificateHosts([
    ...requiredCertificateHosts,
    hostName,
    "localhost",
    "127.0.0.1"
  ]);

  if (
    !existsSync(tlsKeyPath) ||
    !existsSync(tlsCertPath) ||
    !existingCertificateIsUsable(tlsCertPath, requiredCertificateHosts)
  ) {
    const notBeforeDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const generated = await selfsigned.generate(
      [{ name: "commonName", value: generatedCertificateHosts[0] ?? hostName }],
      {
        algorithm: "sha256",
        notBeforeDate,
        notAfterDate: new Date(notBeforeDate.getTime() + TLS_CERT_VALID_DAYS * 24 * 60 * 60 * 1000),
        keySize: 2048,
        extensions: [
          {
            name: "basicConstraints",
            cA: false,
            critical: true
          },
          {
            name: "keyUsage",
            digitalSignature: true,
            keyEncipherment: true,
            critical: true
          },
          {
            name: "extKeyUsage",
            serverAuth: true
          },
          {
            name: "subjectAltName",
            altNames: generatedCertificateHosts.map((host) =>
              isIP(host)
                ? {
                    type: 7,
                    ip: host
                  }
                : {
                    type: 2,
                    value: host
                  }
            )
          }
        ]
      }
    );

    mkdirSync(path.dirname(tlsKeyPath), { recursive: true });
    mkdirSync(path.dirname(tlsCertPath), { recursive: true });
    writeFileSync(tlsKeyPath, generated.private, "utf8");
    writeFileSync(tlsCertPath, generated.cert, "utf8");
  }

  const tlsKeyPem = readFileSync(tlsKeyPath, "utf8");
  const tlsCertPem = readFileSync(tlsCertPath, "utf8");

  const certificate = new X509Certificate(tlsCertPem);

  return {
    hostId,
    keyPair: {
      publicKey,
      secretKey
    },
    publicKeyFingerprint: publicKeyFingerprint(publicKey),
    tlsKeyPath,
    tlsCertPath,
    tlsKeyPem,
    tlsCertPem,
    certificateFingerprint: createHash("sha256").update(certificate.raw).digest("hex")
  };
}

function randomHostId(): string {
  return `host_${Math.random().toString(36).slice(2, 12)}`;
}

function existingCertificateIsUsable(certificatePath: string, hosts: string[]): boolean {
  try {
    const certificate = new X509Certificate(readFileSync(certificatePath, "utf8"));
    const certificateDetails = certificate.toLegacyObject();
    if (certificateDetails.ca !== false) {
      return false;
    }
    if (!certificateDetails.ext_key_usage?.includes(TLS_SERVER_AUTH_OID)) {
      return false;
    }
    if (!certificateValidityIsAcceptable(certificate)) {
      return false;
    }
    const subjectAltName = certificate.subjectAltName ?? "";
    return hosts.every((host) =>
      isIP(host)
        ? subjectAltName.includes(`IP Address:${host}`)
        : subjectAltName.toLowerCase().includes(`dns:${host.toLowerCase()}`)
    );
  } catch {
    return false;
  }
}

function certificateValidityIsAcceptable(certificate: X509Certificate): boolean {
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) {
    return false;
  }
  return validTo > Date.now() && validTo - validFrom <= TLS_CERT_MAX_VALIDITY_MS;
}

function normalizeCertificateHosts(values: string[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    const host = normalizeCertificateHost(value);
    if (host && !output.includes(host)) {
      output.push(host);
    }
  }
  return output;
}

function normalizeCertificateHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  const ipVersion = isIP(unbracketed);
  if (ipVersion) {
    if (isUnspecifiedAddress(unbracketed)) {
      return null;
    }
    return unbracketed;
  }
  const normalized = unbracketed.toLowerCase();
  if (!isDnsName(normalized)) {
    return null;
  }
  return normalized;
}

function isUnspecifiedAddress(value: string): boolean {
  if (value === "0.0.0.0" || value === "::") {
    return true;
  }
  return /^0(?::0){7}$/.test(value);
}

function isDnsName(value: string): boolean {
  if (value.length > 253 || value.includes("..")) {
    return false;
  }
  return value
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
