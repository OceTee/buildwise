/** Shared (server and client) labels for document processing states. */
const STATE_LABEL: Record<string, string> = {
  awaiting_upload: 'Waiting for upload', quarantined: 'Uploaded, queued for checks', scanning: 'Checking for malware',
  processing: 'Reading the file', available: 'Ready', failed: 'Processing failed', rejected: 'Rejected',
};
export const stateLabel = (s: string) => STATE_LABEL[s] ?? s;
