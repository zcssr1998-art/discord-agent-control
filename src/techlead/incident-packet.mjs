/**
 * P3 TechLead — bounded, sanitized incident packet.
 *
 * The reviewer receives a small delta, never full logs or whole session history.
 * Secrets are redacted before persistence, Discord display or model submission.
 */
import { redactSecrets } from '../secrets.mjs';
import { toContractPayload } from './work-contract.mjs';
import { summarizeFingerprint } from './progress-fingerprint.mjs';
import { WORK_EVENT } from './work-event.mjs';

export const DEFAULT_PACKET_MAX_CHARS = 6000;

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function formatEvent(event) {
  const type = event?.type ?? 'EVENT';
  const parts = [type];
  if (event.action) parts.push(event.action);
  if (event.errorSignature) parts.push(`err=${event.errorSignature}`);
  else if (event.error) parts.push(`err=${clip(event.error, 160)}`);
  if (event.testState) parts.push(`test=${event.testState}`);
  if (type === WORK_EVENT.WORKER_MESSAGE && event.message) parts.push(clip(event.message, 160));
  else if (event.resultText) parts.push(clip(event.resultText, 160));
  if (event.file) parts.push(event.file);
  return `- ${parts.join(' · ')}`;
}

/**
 * Build the compact packet. `events` should already be a bounded tail of the
 * relevant window; this function caps it again defensively.
 */
export function buildIncidentPacket({
  workKey = 'unknown',
  channelId = null,
  contract = null,
  incident = {},
  fingerprint = null,
  previousFingerprint = null,
  events = [],
  elapsedMs = null,
  proposedNextAction = null,
  testSummary = null,
  diffSummary = null,
  maxChars = DEFAULT_PACKET_MAX_CHARS,
} = {}) {
  const budget = Math.max(800, Number(maxChars) || DEFAULT_PACKET_MAX_CHARS);
  const summary = summarizeFingerprint(fingerprint);
  const previous = summarizeFingerprint(previousFingerprint);
  const tail = (Array.isArray(events) ? events : []).slice(-12);
  const progressReasons = [];
  if ((summary.fileChangeCount ?? 0) > (previous.fileChangeCount ?? 0)) progressReasons.push('file changes increased');
  if ((summary.fileChangeCount ?? 0) === (previous.fileChangeCount ?? 0)) progressReasons.push('no new file changes');
  if ((summary.evidenceCount ?? 0) === (previous.evidenceCount ?? 0)) progressReasons.push('no new evidence');

  const sections = [];
  sections.push(`TASK/SESSION\nworkKey: ${workKey}${channelId ? `\nchannel: ${channelId}` : ''}`);
  sections.push(`WORK CONTRACT\n${JSON.stringify(toContractPayload(contract), null, 0)}`);
  sections.push(`INCIDENT CLASS\n${incident.class ?? 'UNKNOWN'}`);
  sections.push(`ELAPSED / INCIDENT WINDOW\n${elapsedMs != null ? `${Math.round(elapsedMs / 1000)}s elapsed · ` : ''}incidentAt=${incident.at ? new Date(incident.at).toISOString() : 'n/a'}`);
  sections.push(`LAST RELEVANT ACTIONS\n${tail.length ? tail.map(formatEvent).join('\n') : '- (none in window)'}`);
  sections.push(`NORMALIZED ERROR SIGNATURE\n${incident.errorSignature ?? summary.lastErrorSignature ?? '(none)'}`);
  sections.push(`PROGRESS DELTA\nchangedFiles=${summary.changedFiles?.length ?? 0} fileChangeCount=${summary.fileChangeCount} evidenceCount=${summary.evidenceCount} sameAction=${summary.sameActionCount} sameError=${summary.sameErrorCount}${progressReasons.length ? `\nnotes: ${progressReasons.join(', ')}` : ''}`);
  sections.push(`WORKER PROPOSED NEXT ACTION\n${clip(proposedNextAction ?? incident.proposedAction ?? '(not announced)', 300)}`);
  sections.push(`RELEVANT TEST/DIFF SUMMARY\ntest=${testSummary ?? summary.testState ?? 'unknown'} diff=${clip(diffSummary ?? `${summary.changedFiles?.length ?? 0} file(s) changed`, 300)}`);

  let text = sections.join('\n\n');
  let truncated = false;
  if (text.length > budget) {
    truncated = true;
    text = `${text.slice(0, budget - 20)}\n…[truncated]`;
  }
  text = redactSecrets(text);
  if (text.length > budget) text = `${text.slice(0, budget - 20)}\n…[truncated]`;
  return { text, chars: text.length, truncated, maxChars: budget };
}
