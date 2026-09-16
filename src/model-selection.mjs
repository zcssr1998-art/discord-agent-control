/**
 * One shared validator/normalizer for user-supplied Chat Provider/model IDs.
 *
 * The P2.2.2 bug was that the documentation placeholder `<model-id>` was
 * accepted as a real manual Chat pin and survived reboot. Validation therefore
 * lives in exactly one place and every Chat-selection entry point funnels
 * through it. It is intentionally narrow: it blocks obvious documentation
 * placeholders and empty IDs, not legitimate provider naming conventions
 * (hyphens, dots, slashes, colons, version numbers, ...).
 */

// Bare tokens that are clearly documentation placeholders rather than real
// provider/model IDs. Angle-bracket forms are caught by the shape check below.
const PLACEHOLDER_TOKENS = new Set([
  'model', 'provider',
  'model-id', 'provider-id',
  'model_id', 'provider_id',
  'modelid', 'providerid',
  'model-name', 'provider-name',
  'your-model-id', 'your-provider-id',
  'your-model', 'your-provider',
  'example-model', 'example-provider',
]);

// `<model-id>`, `<provider-id>`, `<anything>` — a whole value wrapped in angle
// brackets is documentation syntax, never a real ID.
const PLACEHOLDER_SHAPE = /^<.+>$/;

/** True when a user-supplied Provider/model ID is empty or an obvious placeholder. */
export function isPlaceholderId(value) {
  if (value == null) return true;
  const text = String(value).trim();
  if (!text) return true;
  if (PLACEHOLDER_SHAPE.test(text)) return true;
  const bare = text.replace(/[<>]/g, '').trim().toLowerCase();
  return PLACEHOLDER_TOKENS.has(bare);
}

function invalidSelection(field, value) {
  return Object.assign(new Error(`invalid chat ${field}`), {
    code: 'INVALID_CHAT_SELECTION', field, value,
  });
}

/**
 * Normalize a Chat selection to a persistable `{ providerId, model }`.
 * `auto` always clears the manual pin. Any placeholder throws
 * `INVALID_CHAT_SELECTION` so a caller cannot persist documentation text.
 */
export function normalizeChatSelection({ providerId = 'auto', model = null } = {}) {
  const provider = providerId == null ? 'auto' : String(providerId).trim();
  if (!provider) throw invalidSelection('providerId', providerId);
  if (provider.toLowerCase() === 'auto') return { providerId: 'auto', model: null };
  if (isPlaceholderId(provider)) throw invalidSelection('providerId', providerId);
  const trimmedModel = model == null ? '' : String(model).trim();
  if (!trimmedModel || isPlaceholderId(trimmedModel)) throw invalidSelection('model', model);
  return { providerId: provider, model: trimmedModel };
}

/**
 * True when an already-persisted Chat selection must be repaired to AUTO/null.
 * A placeholder provider or model is never valid runtime configuration.
 */
export function needsChatSelectionRepair({ providerId = null, model = null } = {}) {
  const provider = providerId == null ? '' : String(providerId).trim();
  const modelText = model == null ? '' : String(model).trim();
  if (!provider || provider.toLowerCase() === 'auto') {
    return Boolean(modelText) && isPlaceholderId(modelText);
  }
  if (isPlaceholderId(provider)) return true;
  return Boolean(modelText) && isPlaceholderId(modelText);
}
