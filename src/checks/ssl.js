// Opens a TLS connection to read the certificate and report days to expiry.
// fetch() does not expose the peer certificate, so we use the tls module directly.

import tls from "node:tls";

const TIMEOUT_MS = 15000;

export function checkSsl(rawUrl, warnDays = 14) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : "https://" + rawUrl);
    } catch {
      return resolve({ status: "warn", label: "Bad URL", detail: "Could not parse URL" });
    }

    if (url.protocol !== "https:") {
      return resolve({ status: "warn", label: "No TLS", detail: "Site is not HTTPS" });
    }

    const port = url.port || 443;
    // rejectUnauthorized: false so the handshake completes even when the cert is
    // untrusted — otherwise an *expired* cert aborts the connection and we report
    // a generic "TLS error", which is exactly the case this check exists to catch.
    // Trust is then evaluated explicitly via socket.authorized below.
    const socket = tls.connect(
      { host: url.hostname, port, servername: url.hostname, timeout: TIMEOUT_MS, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        const authorized = socket.authorized;
        const authError = socket.authorizationError;
        socket.end();

        if (!cert || !cert.valid_to) {
          return resolve({ status: "warn", label: "No cert", detail: "No certificate returned" });
        }

        const expiry = new Date(cert.valid_to);
        const daysRemaining = Math.floor((expiry - Date.now()) / 86400000);
        const issuer = cert.issuer && cert.issuer.O ? cert.issuer.O : "Unknown CA";
        const detail = `Expires ${expiry.toISOString().slice(0, 10)} · ${issuer}`;

        if (daysRemaining < 0) {
          resolve({ status: "fail", label: "Expired", detail, daysRemaining });
        } else if (!authorized) {
          // Valid dates but the chain or hostname doesn't check out — a browser
          // would still show a full-page warning, so this is a failure.
          const reason = String(authError || "certificate not trusted");
          resolve({ status: "fail", label: "Untrusted cert", detail: `${detail} · ${reason}`, daysRemaining });
        } else if (daysRemaining < warnDays) {
          resolve({ status: "warn", label: `${daysRemaining}d left`, detail, daysRemaining });
        } else {
          resolve({ status: "ok", label: `${daysRemaining}d left`, detail, daysRemaining });
        }
      }
    );

    socket.on("error", (err) => {
      resolve({ status: "fail", label: "TLS error", detail: err.message });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ status: "fail", label: "TLS timeout", detail: "Handshake timed out" });
    });
  });
}
