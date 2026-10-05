// scripts/verify-gmail-auth.ts

import "dotenv/config";
import { google } from "googleapis";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

if (!clientId) {
  throw new Error("GOOGLE_CLIENT_ID is not set");
}

if (!clientSecret) {
  throw new Error("GOOGLE_CLIENT_SECRET is not set");
}

if (!refreshToken) {
  throw new Error("GOOGLE_REFRESH_TOKEN is not set");
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);

oauth2Client.setCredentials({
  refresh_token: refreshToken,
});

async function main() {
  const accessToken = await oauth2Client.getAccessToken();

  if (!accessToken.token) {
    throw new Error("Google did not return an access token");
  }

  console.log("Gmail OAuth authentication succeeded.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
