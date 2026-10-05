// scripts/authorize-gmail.ts

import "dotenv/config";
import { google } from "googleapis";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId) {
  throw new Error("GOOGLE_CLIENT_ID is not set");
}

if (!clientSecret) {
  throw new Error("GOOGLE_CLIENT_SECRET is not set");
}

const redirectUri = "http://127.0.0.1:3000";

const oauth2Client = new google.auth.OAuth2(
  clientId,
  clientSecret,
  redirectUri,
);

const state = randomBytes(32).toString("hex");

const authorizationUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/gmail.compose"],
  state,
});

const server = createServer(async (request, response) => {
  try {
    if (!request.url) {
      throw new Error("OAuth callback URL is missing");
    }

    const callbackUrl = new URL(request.url, redirectUri);

    const code = callbackUrl.searchParams.get("code");
    const returnedState = callbackUrl.searchParams.get("state");
    const oauthError = callbackUrl.searchParams.get("error");

    if (!code && !returnedState && !oauthError) {
      response.writeHead(204);
      response.end();
      return;
    }

    if (oauthError) {
      throw new Error(`Google OAuth error: ${oauthError}`);
    }

    if (returnedState !== state) {
      throw new Error("OAuth state did not match");
    }

    if (!code) {
      throw new Error("OAuth authorization code is missing");
    }

    const { tokens } = await oauth2Client.getToken(code);

    response.writeHead(200, {
      "Content-Type": "text/plain",
    });

    response.end("Relay Gmail authorization complete. You can close this tab.");

    console.log("\nAuthorization complete.");

    if (!tokens.refresh_token) {
      console.log("Google did not return a refresh token.");
    } else {
      console.log("\nAdd this to your .env:\n");
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    }
    server.close();
  } catch (error) {
    response.writeHead(500, {
      "Content-Type": "text/plain",
    });

    response.end("Relay Gmail authorization failed.");

    console.error(error);

    server.close();
  }
});

server.listen(3000, "127.0.0.1", () => {
  console.log("\nGoogle authorization URL:\n");
  console.log(authorizationUrl);
  console.log("\nOpen the URL in your browser.");
});
