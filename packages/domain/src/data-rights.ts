/**
 * Data rights (spec §20.2, §20.3, §28 "Export, correction, deletion and retention controls"): how long each
 * personal record class is kept, how exports are limited, and what an account deletion keeps. The windows are
 * the §20.3 proposed defaults; counsel confirms them per market (D-07), so they live in the market pack.
 */
export interface PrivacyConfig {
  export: {
    /** Data exports a person may make in 24 hours. */
    perDay: number;
    /** Minutes the signed download link stays valid. */
    linkMinutes: number;
    /** Days an export archive is kept in storage before the worker deletes it. */
    keepDays: number;
  };
  retention: {
    /** Days a deleted account's details are held (fraud, disputes) before the user row is pseudonymised. */
    deletedAccountDays: number;
    /** Days after the last message before a deleted user's website chats are redacted (§20.3: 2 years). */
    deletedUserChatDays: number;
    /** Days a contact-reveal log is kept (§20.3: 12 months). */
    contactRevealDays: number;
    /** Days after which a contact-reveal log loses its device id (§20.3: pseudonymised after 30 days). */
    contactRevealPseudonymiseDays: number;
    /** Days a revoked or expired sign-in session is kept (§20.3: sign-in events 90 days). */
    sessionDays: number;
  };
  staff: {
    /** Hours a staff session stays verified by its second factor before the code is asked again. */
    mfaSessionHours: number;
    /** Minutes within which a staff member must have entered a code to grant or revoke roles (step-up). */
    stepUpMinutes: number;
    /** One-time recovery codes issued with an authenticator. */
    recoveryCodes: number;
  };
}

export const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  export: { perDay: 3, linkMinutes: 15, keepDays: 7 },
  retention: { deletedAccountDays: 30, deletedUserChatDays: 730, contactRevealDays: 365, contactRevealPseudonymiseDays: 30, sessionDays: 90 },
  staff: { mfaSessionHours: 12, stepUpMinutes: 15, recoveryCodes: 10 },
};

/** What an account deletion does, in the words shown before the person confirms (§3.11, §20.3). */
export const DELETION_EFFECTS: readonly string[] = [
  'Your listings close, including those of businesses where you are the only owner; those businesses stop trading on BuildWise.',
  'You leave businesses and projects you share with other people. Projects you own alone are archived.',
  'Reviews you wrote are removed. Your saved searches, favourites and notifications are deleted.',
  'People you chatted with keep the conversation, shown from “Deleted user”. Those chats are erased after the retention period.',
  'Your name, phone number and email are removed from the account at once, and erased completely after the holding period.',
];

/** Records kept after deletion because law, contracts or audit require them (§20.3, §20.4). */
export const RETAINED_AFTER_DELETION: readonly string[] = [
  'The audit log (7 years, append-only).',
  'Issued estimates, awards, orders and contracts (project close + 7 years).',
  'Supplier invoices and payment records (at least 7 years, as tax law requires).',
  'Trust and safety cases and their evidence (resolution + 7 years).',
];
