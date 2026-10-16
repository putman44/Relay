export type OutreachDraftContent = {
  requestId: string;
  prospectId: string;
  recipientEmail: string;
  subject: string;
  body: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const validateOutreachDraftContent = (input: OutreachDraftContent): void => {
  if (!UUID.test(input.requestId) || !UUID.test(input.prospectId)) {
    throw new Error("Request and prospect IDs must be UUIDs.");
  }
  // A single bare ASCII mailbox only: no display names, lists, or header injection.
  if (!/^[A-Za-z0-9!#$%&'+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(input.recipientEmail)
    || input.recipientEmail.length > 254
    || input.recipientEmail.split("@")[0]!.length > 64
    || /email\s*protected|redacted|obfuscat/i.test(input.recipientEmail)) {
    throw new Error("Recipient must be one valid email address.");
  }
  if (!input.subject.trim() || /[\x00-\x1f\x7f]/.test(input.subject)
    || Buffer.byteLength(input.subject) > 500) {
    throw new Error("Subject must be nonblank, at most 500 UTF-8 bytes, and contain no control characters.");
  }
  if (!input.body.trim() || input.body.includes("\0")
    || Buffer.byteLength(input.body) > 100_000) {
    throw new Error("Body must be nonblank and at most 100000 UTF-8 bytes, without NUL characters.");
  }
};

export const buildOutreachDraftMime = (input: OutreachDraftContent): string => {
  validateOutreachDraftContent(input);
  // Fold UTF-8 encoded words without splitting a Unicode code point.
  const chunks: string[] = [];
  let chunk = "";
  for (const character of input.subject) {
    if (Buffer.byteLength(chunk + character) > 39) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  const subject = chunks.map((part) => `=?UTF-8?B?${Buffer.from(part).toString("base64")}?=`).join("\r\n ");
  const body = Buffer.from(input.body, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  const mime = [
    `To: ${input.recipientEmail}`,
    `Subject: ${subject}`,
    `Message-ID:\r\n <relay-outreach-${input.requestId.toLowerCase()}@relay.invalid>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body,
    "",
  ].join("\r\n");
  return Buffer.from(mime).toString("base64url");
};
