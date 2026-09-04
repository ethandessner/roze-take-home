import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import open from "open";
import { CREDENTIALS_PATH, ensureRozeDir } from "./paths.js";

const REDIRECT_PORT = 4321;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

function getClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Copy .env.example to .env and fill in your Google Cloud OAuth client credentials."
    );
  }
  return { clientId, clientSecret };
}

function buildOAuthClient(): OAuth2Client {
  const { clientId, clientSecret } = getClientCredentials();
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

/**
 * Runs the interactive `roze auth` flow: opens a browser to the Google
 * consent screen, captures the OAuth code via a temporary local server,
 * exchanges it for tokens, and persists them to ~/.roze/credentials.json.
 */
export async function runAuth(): Promise<void> {
  ensureRozeDir();
  const oauth2Client = buildOAuthClient();

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  console.log("Opening your browser to sign in with Google...");
  console.log(`If it doesn't open automatically, visit:\n${authUrl}\n`);

  const code = await waitForOAuthCode(authUrl);

  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    console.warn(
      "Warning: no refresh_token was returned. If this happens again, revoke prior access at https://myaccount.google.com/permissions and re-run `roze auth`."
    );
  }

  writeFileSync(CREDENTIALS_PATH, JSON.stringify(tokens, null, 2), {
    mode: 0o600,
  });

  console.log(`Authenticated successfully. Tokens saved to ${CREDENTIALS_PATH}`);
  console.log("You can now run `roze generate`.");
}

function waitForOAuthCode(authUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404).end();
        return;
      }

      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html" });
      if (error) {
        res.end(
          `<html><body><h2>Authentication failed: ${error}</h2>You can close this tab.</body></html>`
        );
      } else {
        res.end(
          "<html><body><h2>Authentication successful.</h2>You can close this tab and return to the terminal.</body></html>"
        );
      }

      server.close();

      if (error || !code) {
        reject(new Error(`OAuth error: ${error ?? "no code returned"}`));
      } else {
        resolve(code);
      }
    });

    server.listen(REDIRECT_PORT, async () => {
      try {
        await open(authUrl);
      } catch {
        // Non-fatal: user can click the printed URL manually.
      }
    });

    server.on("error", (err) => reject(err));
  });
}

/**
 * Loads stored credentials and returns an authenticated OAuth2Client that
 * auto-refreshes its access token as needed. Throws a friendly error if
 * `roze auth` has not been run yet.
 */
export function getAuthedClient(): OAuth2Client {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error("Not authenticated yet. Run `roze auth` first.");
  }

  const oauth2Client = buildOAuthClient();
  const tokens = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  oauth2Client.setCredentials(tokens);

  // Persist refreshed tokens (e.g. new access_token) back to disk whenever
  // the client refreshes them, so subsequent runs reuse the latest ones.
  oauth2Client.on("tokens", (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    writeFileSync(CREDENTIALS_PATH, JSON.stringify(merged, null, 2), {
      mode: 0o600,
    });
  });

  return oauth2Client;
}
