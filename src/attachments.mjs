import fs from 'node:fs';
import path from 'node:path';

/**
 * Discord attachment handling for Work and Chat.
 *
 * Security posture:
 *   - only HTTPS Discord CDN URLs are accepted (never an arbitrary URL)
 *   - filenames are sanitized so no attachment can escape its inbox directory
 *   - hard count/size caps; oversize or untrusted items are reported, not ignored
 *   - attachment bodies are never logged
 *   - Work downloads land in a git-ignored runtime inbox and are passed to the
 *     Agent as local paths; Jarvis never executes them
 */
export const ATTACHMENT_LIMITS = Object.freeze({
  WORK_MAX_FILES: 10,
  WORK_MAX_BYTES: 25 * 1024 * 1024,
  CHAT_MAX_FILES: 5,
  CHAT_MAX_IMAGE_BYTES: 8 * 1024 * 1024,
  CHAT_MAX_TEXT_BYTES: 256 * 1024,
  CHAT_MAX_TEXT_CHARS: 12000,
  CHAT_MAX_TOTAL_TEXT_CHARS: 24000,
});

const TRUSTED_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

const IMAGE_MIME = new Map([
  ['image/png', 'image/png'],
  ['image/jpeg', 'image/jpeg'],
  ['image/jpg', 'image/jpeg'],
  ['image/webp', 'image/webp'],
  ['image/gif', 'image/gif'],
]);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.yaml', '.yml', '.toml', '.ini',
  '.env', '.cfg', '.conf', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.html', '.htm',
  '.css', '.scss', '.xml', '.sql', '.gitignore', '.dockerfile',
]);

const TEXT_MIME = /^(?:text\/|application\/(?:json|xml|javascript|x-yaml|x-sh|x-python|x-shellscript))/i;

export function isTrustedAttachmentUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'https:' && TRUSTED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Strip directories, control characters and Windows-reserved characters. */
export function sanitizeFileName(name) {
  const raw = String(name ?? '');
  const noControl = raw.replace(/[\u0000-\u001f\u007f]/g, '');
  const base = path.basename(noControl.replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'attachment';
  return cleaned.slice(-120) || 'attachment';
}

function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

export function normalizeAttachment(raw) {
  if (!raw) return null;
  const url = raw.url || raw.proxyURL || raw.proxyUrl || null;
  return {
    name: sanitizeFileName(raw.name),
    originalName: String(raw.name ?? 'attachment'),
    url,
    size: Number(raw.size ?? 0),
    contentType: raw.contentType || raw.content_type || null,
    id: raw.id ?? null,
  };
}

export function normalizeAttachments(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  return list.map(normalizeAttachment).filter(Boolean);
}

export function classifyAttachment(attachment) {
  const mime = String(attachment.contentType || '').toLowerCase();
  if (IMAGE_MIME.has(mime)) return 'image';
  if (TEXT_MIME.test(mime)) return 'text';
  if (TEXT_EXTENSIONS.has(extOf(attachment.name)) || TEXT_EXTENSIONS.has(extOf(attachment.originalName))) return 'text';
  return 'unsupported';
}

async function fetchBuffer(url, { fetchImpl, timeoutMs, maxBytes }) {
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw Object.assign(new Error(`download failed (HTTP ${response.status})`), { code: 'DOWNLOAD_FAILED' });
  const declared = Number(response.headers?.get?.('content-length') ?? 0);
  if (declared && declared > maxBytes) throw Object.assign(new Error('attachment exceeds the size limit'), { code: 'TOO_LARGE' });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw Object.assign(new Error('attachment exceeds the size limit'), { code: 'TOO_LARGE' });
  return buffer;
}

/**
 * Download Work attachments once into a per-message inbox. Returns a manifest of
 * local paths plus a list of skipped items so the caller can tell the user.
 */
export async function downloadWorkAttachments({
  attachments,
  inboxRoot,
  channelId,
  messageId,
  fetchImpl = fetch,
  timeoutMs = 60000,
  maxFiles = ATTACHMENT_LIMITS.WORK_MAX_FILES,
  maxBytes = ATTACHMENT_LIMITS.WORK_MAX_BYTES,
} = {}) {
  const list = normalizeAttachments(attachments);
  const accepted = [];
  const skipped = [];
  for (const attachment of list) {
    if (accepted.length >= maxFiles) { skipped.push({ name: attachment.name, reason: 'count-limit' }); continue; }
    if (!isTrustedAttachmentUrl(attachment.url)) { skipped.push({ name: attachment.name, reason: 'untrusted-url' }); continue; }
    if (attachment.size && attachment.size > maxBytes) { skipped.push({ name: attachment.name, reason: 'too-large' }); continue; }
    accepted.push(attachment);
  }
  if (!accepted.length) return { files: [], skipped };

  const dir = path.join(inboxRoot, sanitizeFileName(channelId), sanitizeFileName(messageId || `msg-${Date.now()}`));
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  let index = 0;
  for (const attachment of accepted) {
    index += 1;
    const local = path.join(dir, `${index}-${attachment.name}`);
    try {
      const buffer = await fetchBuffer(attachment.url, { fetchImpl, timeoutMs, maxBytes });
      fs.writeFileSync(local, buffer);
      files.push({ name: attachment.name, path: local, size: buffer.length, contentType: attachment.contentType });
    } catch (error) {
      skipped.push({ name: attachment.name, reason: error?.code === 'TOO_LARGE' ? 'too-large' : 'download-failed' });
    }
  }
  return { files, skipped };
}

export function buildWorkManifest(files) {
  const lines = [
    '📎 Discord 附件已下载到本机（请按需读取，不要执行）：',
    ...files.map((file, index) => `${index + 1}. ${file.name} -> \`${file.path}\` (${file.size} bytes)`),
    '',
    '需要时用 Read/Bash 等工具读取这些本地文件。',
  ];
  return lines.join('\n');
}

/**
 * Extract a bounded, transport-neutral Chat turn from attachments.
 *
 * Returns text blocks, image parts (`{ type, mediaType, data }`) and a list of
 * unsupported names so the caller can redirect them to Work instead of silently
 * dropping them.
 */
export async function readChatAttachments({
  attachments,
  fetchImpl = fetch,
  timeoutMs = 60000,
  maxFiles = ATTACHMENT_LIMITS.CHAT_MAX_FILES,
  maxImageBytes = ATTACHMENT_LIMITS.CHAT_MAX_IMAGE_BYTES,
  maxTextBytes = ATTACHMENT_LIMITS.CHAT_MAX_TEXT_BYTES,
  maxTextChars = ATTACHMENT_LIMITS.CHAT_MAX_TEXT_CHARS,
  maxTotalTextChars = ATTACHMENT_LIMITS.CHAT_MAX_TOTAL_TEXT_CHARS,
} = {}) {
  const list = normalizeAttachments(attachments);
  const texts = [];
  const images = [];
  const unsupported = [];
  let totalChars = 0;
  for (const attachment of list) {
    if (texts.length + images.length >= maxFiles) { unsupported.push({ name: attachment.name, reason: 'count-limit' }); continue; }
    if (!isTrustedAttachmentUrl(attachment.url)) { unsupported.push({ name: attachment.name, reason: 'untrusted-url' }); continue; }
    const kind = classifyAttachment(attachment);
    try {
      if (kind === 'image') {
        if (attachment.size && attachment.size > maxImageBytes) { unsupported.push({ name: attachment.name, reason: 'too-large' }); continue; }
        const buffer = await fetchBuffer(attachment.url, { fetchImpl, timeoutMs, maxBytes: maxImageBytes });
        const mediaType = IMAGE_MIME.get(String(attachment.contentType || '').toLowerCase()) || 'image/png';
        images.push({ name: attachment.name, mediaType, data: buffer.toString('base64'), size: buffer.length });
        continue;
      }
      if (kind === 'text') {
        const buffer = await fetchBuffer(attachment.url, { fetchImpl, timeoutMs, maxBytes: maxTextBytes });
        let content = buffer.toString('utf8');
        let truncated = false;
        if (content.length > maxTextChars) { content = content.slice(0, maxTextChars); truncated = true; }
        if (totalChars + content.length > maxTotalTextChars) {
          content = content.slice(0, Math.max(0, maxTotalTextChars - totalChars));
          truncated = true;
        }
        totalChars += content.length;
        texts.push({ name: attachment.name, content, truncated });
        continue;
      }
      unsupported.push({ name: attachment.name, reason: 'unsupported-type' });
    } catch (error) {
      unsupported.push({ name: attachment.name, reason: error?.code === 'TOO_LARGE' ? 'too-large' : 'download-failed' });
    }
  }
  return { texts, images, unsupported };
}

/** Build the transport-neutral user content for a Chat turn with attachments. */
export function buildChatContent({ prompt = '', texts = [], images = [], unsupported = [] } = {}) {
  const blocks = [];
  const trimmed = String(prompt ?? '').trim();
  if (trimmed) blocks.push({ type: 'text', text: trimmed });
  for (const text of texts) {
    blocks.push({ type: 'text', text: `📄 附件 ${text.name}${text.truncated ? '（已截断）' : ''}:\n\`\`\`\n${text.content}\n\`\`\`` });
  }
  for (const item of unsupported) {
    blocks.push({ type: 'text', text: `⚠️ 附件 ${item.name} 无法在 Chat 中读取（${item.reason}）。如需处理请改用 Work。` });
  }
  for (const image of images) {
    blocks.push({ type: 'image', mediaType: image.mediaType, data: image.data });
  }
  return blocks;
}

/** Persisted summary of a turn: filename + bounded text, never a base64 body. */
export function buildChatHistoryText({ prompt = '', texts = [], images = [], unsupported = [] } = {}) {
  const parts = [String(prompt ?? '').trim()];
  for (const text of texts) parts.push(`[附件 ${text.name}]\n${text.content}`);
  for (const image of images) parts.push(`[图片附件 ${image.name} ${image.size} bytes]`);
  for (const item of unsupported) parts.push(`[无法读取的附件 ${item.name}: ${item.reason}]`);
  return parts.filter(Boolean).join('\n\n');
}

/** Remove inbox directories older than the TTL (best effort, safe at startup). */
export function cleanupInbox(inboxRoot, { ttlMs = 48 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const removed = [];
  if (!inboxRoot || !fs.existsSync(inboxRoot)) return removed;
  const cutoff = now() - ttlMs;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        try {
          if (fs.readdirSync(full).length === 0 && fs.statSync(full).mtimeMs < cutoff) { fs.rmdirSync(full); removed.push(full); }
        } catch { /* best effort */ }
      } else {
        try { if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); removed.push(full); } } catch { /* best effort */ }
      }
    }
  };
  walk(inboxRoot);
  return removed;
}

export default {
  ATTACHMENT_LIMITS,
  sanitizeFileName,
  isTrustedAttachmentUrl,
  downloadWorkAttachments,
  buildWorkManifest,
  readChatAttachments,
  buildChatContent,
  buildChatHistoryText,
  cleanupInbox,
};
