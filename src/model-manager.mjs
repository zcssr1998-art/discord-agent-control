export class ModelManager {
  constructor(providerManager) { this.providers = providerManager; }

  list(providerId, options) { return this.providers.listModels(providerId, options); }

  async select(providerId, modelId) {
    const profile = this.providers.get(providerId);
    if (!profile) throw Object.assign(new Error('provider not found'), { code: 'PROVIDER_NOT_FOUND' });
    if (profile.models?.some((model) => model.id === modelId)) return modelId;
    await this.providers.validateModel(providerId, modelId);
    return modelId;
  }
}
