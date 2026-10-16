import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { createGmailOAuthClient, loadGmailCredentials } from '../gmail/gmail-auth.js';

export type DriveArtifact = { id: string; mimeType: string; parents: string[];
  appProperties: Record<string, string>; trashed?: boolean; webViewLink?: string };
export type ResearchDrive = {
  createFolder: (requestId: string, parentId: string, name: string) => Promise<DriveArtifact>;
  createBrief: (requestId: string, folderId: string, name: string, text: string) => Promise<DriveArtifact>;
  get: (id: string) => Promise<DriveArtifact>;
};

export function validDriveId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(value);
}

export function validateDriveArtifact(value: DriveArtifact, id: string, parentId: string, requestId: string,
  kind: 'folder' | 'brief'): DriveArtifact {
  const mimeType = kind === 'folder' ? 'application/vnd.google-apps.folder' : 'application/vnd.google-apps.document';
  if (!validDriveId(value?.id) || value.id !== id || !Array.isArray(value.parents)
    || value.parents.length !== 1 || value.parents[0] !== parentId || value.mimeType !== mimeType
    || value.trashed === true || value.appProperties?.relayResearchRequestId !== requestId
    || value.appProperties?.relayArtifactKind !== kind
    || (value.webViewLink && (!value.webViewLink.startsWith('https://drive.google.com/')
      && !value.webViewLink.startsWith('https://docs.google.com/')))) {
    throw new Error('Drive artifact identity or parent does not match the research request.');
  }
  return value;
}

export function createResearchDrive(): ResearchDrive {
  const api = google.drive({ version: 'v3', auth: createGmailOAuthClient(loadGmailCredentials()) });
  const fields = 'id,mimeType,parents,appProperties,trashed,webViewLink';
  const props = (requestId: string, kind: string) => ({ relayResearchRequestId: requestId, relayArtifactKind: kind });
  return {
    async createFolder(requestId, parentId, name) {
      const response = await api.files.create({ fields, requestBody: {
        name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId], appProperties: props(requestId, 'folder'),
      } }, { retry: false });
      const item = response.data as DriveArtifact;
      return validateDriveArtifact(item, item.id, parentId, requestId, 'folder');
    },
    async createBrief(requestId, folderId, name, text) {
      const response = await api.files.create({ fields, requestBody: {
        name, mimeType: 'application/vnd.google-apps.document', parents: [folderId], appProperties: props(requestId, 'brief'),
      }, media: { mimeType: 'text/plain', body: Readable.from([text]) } }, { retry: false });
      const item = response.data as DriveArtifact;
      return validateDriveArtifact(item, item.id, folderId, requestId, 'brief');
    },
    async get(id) {
      const response = await api.files.get({ fileId: id, fields }, { retry: false });
      return response.data as DriveArtifact;
    },
  };
}
