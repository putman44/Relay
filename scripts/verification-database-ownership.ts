export type VerificationOwnershipRow = {
  database_user: string;
  database_name: string;
  ownership_nonce: string | null;
};

export function assertVerificationDatabaseOwnership(
  row: VerificationOwnershipRow | undefined,
  expectedUser: string,
  expectedNonce: string,
) {
  if (!row || row.database_user !== expectedUser || row.database_name !== 'relay_test'
    || row.ownership_nonce !== expectedNonce) {
    throw new Error('Verification database ownership could not be proven.');
  }
}
