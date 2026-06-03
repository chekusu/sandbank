import type { CreateConfig } from './types.js'

export type ProviderImageSpec = string | Partial<CreateConfig>

export interface ProviderImageManifest {
  default?: ProviderImageSpec
  providers?: Record<string, ProviderImageSpec>
}

export type ProviderImageCatalog = Record<string, ProviderImageSpec | ProviderImageManifest>

export function resolveProviderImage(
  logicalImage: string,
  providerName: string,
  catalog: ProviderImageCatalog = {},
): Partial<CreateConfig> & { image: string } {
  const entry = catalog[logicalImage]
  if (!entry) return { image: logicalImage }

  if (!isManifest(entry)) {
    return requireImage(normalizeSpec(entry), logicalImage, providerName)
  }

  const defaultSpec = entry.default ? normalizeSpec(entry.default) : undefined
  const providerSpec = entry.providers?.[providerName] ? normalizeSpec(entry.providers[providerName]!) : undefined
  if (!defaultSpec && !providerSpec) {
    throw new Error(`No image mapping for provider "${providerName}" and logical image "${logicalImage}"`)
  }

  return requireImage(mergeCreateConfig(defaultSpec ?? {}, providerSpec ?? {}), logicalImage, providerName)
}

export function resolveProviderCreateConfig(
  config: CreateConfig,
  providerName: string,
  catalog: ProviderImageCatalog = {},
): CreateConfig {
  if (!config.image) return config

  const resolved = resolveProviderImage(config.image, providerName, catalog)
  const callerConfig = { ...config }
  delete callerConfig.image

  return mergeCreateConfig(resolved, callerConfig) as CreateConfig
}

function normalizeSpec(spec: ProviderImageSpec): Partial<CreateConfig> {
  return typeof spec === 'string' ? { image: spec } : { ...spec }
}

function isManifest(value: ProviderImageSpec | ProviderImageManifest): value is ProviderImageManifest {
  return typeof value === 'object'
    && value !== null
    && ('default' in value || 'providers' in value)
}

function mergeCreateConfig(
  base: Partial<CreateConfig>,
  override: Partial<CreateConfig>,
): Partial<CreateConfig> {
  return {
    ...base,
    ...override,
    env: base.env || override.env
      ? { ...base.env, ...override.env }
      : undefined,
  }
}

function requireImage(
  config: Partial<CreateConfig>,
  logicalImage: string,
  providerName: string,
): Partial<CreateConfig> & { image: string } {
  if (!config.image) {
    throw new Error(`No image mapping for provider "${providerName}" and logical image "${logicalImage}"`)
  }
  return config as Partial<CreateConfig> & { image: string }
}
