// src/gmail/gmail-auth.ts
import { google } from "googleapis";

export type GmailCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export type GmailEnvironment = {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
};

export function loadGmailCredentials(
  environment: GmailEnvironment = process.env,
): GmailCredentials {
  const clientId = environment.GOOGLE_CLIENT_ID;
  const clientSecret = environment.GOOGLE_CLIENT_SECRET;
  const refreshToken = environment.GOOGLE_REFRESH_TOKEN;

  if (!clientId) {
    throw new Error("GOOGLE_CLIENT_ID is not set");
  }

  if (!clientSecret) {
    throw new Error("GOOGLE_CLIENT_SECRET is not set");
  }

  if (!refreshToken) {
    throw new Error("GOOGLE_REFRESH_TOKEN is not set");
  }

  return {
    clientId,
    clientSecret,
    refreshToken,
  };
}

export function createGmailOAuthClient(credentials: GmailCredentials) {
  const oauthClient = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
  );

  oauthClient.setCredentials({
    refresh_token: credentials.refreshToken,
  });

  return oauthClient;
}

export function createGmailApi(
  oauthClient: ReturnType<typeof createGmailOAuthClient>,
) {
  return google.gmail({
    version: "v1",
    auth: oauthClient,
  });
}
