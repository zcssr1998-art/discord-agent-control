/**
 * P3 TechLead — Work Contract.
 *
 * A compact machine-readable contract derived from the user Work request / task
 * specification. It is intentionally small: no rulebook, no repository history.
 * It gives the reviewer enough context to judge direction without replaying the
 * whole session.
 */
import { looksRisky } from './work-event.mjs';

export const CONTRACT_RISK = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high' });

const HIGH_RISK = /(?:删除|清空|重置|重装|格式化|凭据|密钥|生产|线上|数据库迁移|rm\s+-rf|git\s+reset\s+--hard|drop\s+(?:database|table)|force\s+push|reinstall|credential|secret)/i;
const MEDIUM_RISK = /(?:升级|迁移|重构|部署|安装|依赖|版本|upgrade|migrate|refactor|deploy|install|dependency)/i;
const DO_NOT = /(?:不要|禁止|请勿|勿|不得|不可|禁止修改|do\s+not|don't|never|must\s+not|avoid)/i;
const ACCEPTANCE = /(?:验收|acceptance|通过|测试|test|pass|verified|verify|npm\s+test|npm\s+run\s+check|smoke)/i;
const CONSTRAINT = /(?:必须|需要|只能|保持|不得|constraint|must|should|only|keep|preserve|without\s+changing)/i;
const SUBJECTIVE = /(?:主观|体验|美观|设计|感觉|产品|用户体验|quality|look\s+and\s+feel|ux)/i;
const PATH_LIKE = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|docs\/tasks\/[A-Za-z0-9_.-]+|src\/[A-Za-z0-9_.\/-]+/g;

function lines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s>*#\-–•\d.、)]+/, '').trim())
    .filter(Boolean);
}

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function uniqueBounded(list, max) {
  const out = [];
  for (const item of list) {
    const value = clip(item, 200);
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function firstSentences(text, max = 2) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  const parts = value.split(/(?<=[。.!?；;])\s*/).filter(Boolean);
  return clip(parts.slice(0, max).join(' '), 220);
}

/** Derive the compact contract. Deterministic, no model call. */
export function deriveWorkContract({ prompt = '', spec = null, at = new Date().toISOString() } = {}) {
  const source = [spec?.objective, spec?.text, prompt].filter(Boolean).join('\n');
  const promptLines = lines(prompt);
  const allLines = lines(source);

  const objective = clip(spec?.objective, 220)
    || firstSentences(prompt, 2)
    || clip(allLines[0] ?? '', 220)
    || 'unspecified Work objective';

  const constraints = uniqueBounded([
    ...(spec?.constraints ?? []),
    ...allLines.filter((line) => CONSTRAINT.test(line) && !DO_NOT.test(line)),
  ], 6);

  const acceptance = uniqueBounded([
    ...(spec?.acceptance ?? []),
    ...allLines.filter((line) => ACCEPTANCE.test(line)),
  ], 6);

  const doNot = uniqueBounded([
    ...(spec?.doNot ?? []),
    ...allLines.filter((line) => DO_NOT.test(line)),
  ], 6);

  const watch = uniqueBounded([
    ...(spec?.watch ?? []),
    ...(String(source).match(PATH_LIKE) ?? []),
  ], 8);

  const risk = HIGH_RISK.test(source) || looksRisky(source)
    ? CONTRACT_RISK.HIGH
    : (MEDIUM_RISK.test(source) ? CONTRACT_RISK.MEDIUM : CONTRACT_RISK.LOW);

  const ownerRequired = uniqueBounded([
    ...(spec?.ownerRequired ?? []),
    ...allLines.filter((line) => HIGH_RISK.test(line)),
  ], 5);

  const subjectiveAcceptance = SUBJECTIVE.test(acceptance.join(' ')) || SUBJECTIVE.test(source);

  return {
    objective,
    constraints,
    acceptance,
    do_not: doNot,
    risk,
    watch,
    owner_required: ownerRequired,
    // Internal helpers: not part of the reviewer-facing JSON contract shape but
    // used by deterministic detection.
    scope: uniqueBounded(watch, 8),
    subjectiveAcceptance,
    derivedAt: at,
    sourceLines: promptLines.length,
  };
}

/** Reviewer-facing compact form (drops internal detection helpers). */
export function toContractPayload(contract) {
  if (!contract) return null;
  return {
    objective: contract.objective,
    constraints: contract.constraints,
    acceptance: contract.acceptance,
    do_not: contract.do_not,
    risk: contract.risk,
    watch: contract.watch,
    owner_required: contract.owner_required,
  };
}
