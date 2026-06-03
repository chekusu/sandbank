import { describe, expect, it } from 'vitest'
import {
  resolveProviderCreateConfig,
  resolveProviderImage,
} from '../src/index.js'

describe('provider image resolution', () => {
  it('resolves a logical image into provider-specific create config', () => {
    const catalog = {
      'agent-node': {
        default: {
          image: 'ghcr.io/acme/agent-node:2026.06',
          env: { IMAGE_FAMILY: 'agent-node' },
        },
        providers: {
          e2b: {
            image: 'agent-node-e2b-template',
            env: { E2B_TEMPLATE: 'agent-node' },
            timeout: 45,
          },
        },
      },
    }

    const config = resolveProviderCreateConfig({
      image: 'agent-node',
      env: { RUN_ID: 'run-1' },
      timeout: 10,
    }, 'e2b', catalog)

    expect(config).toEqual({
      image: 'agent-node-e2b-template',
      env: {
        IMAGE_FAMILY: 'agent-node',
        E2B_TEMPLATE: 'agent-node',
        RUN_ID: 'run-1',
      },
      timeout: 10,
    })
  })

  it('supports provider-specific image strings for local or OCI image files', () => {
    const image = resolveProviderImage('agent-node', 'boxlite', {
      'agent-node': {
        default: 'ghcr.io/acme/agent-node:2026.06',
        providers: {
          boxlite: '/var/lib/boxlite/images/agent-node.oci',
        },
      },
    })

    expect(image).toEqual({ image: '/var/lib/boxlite/images/agent-node.oci' })
  })

  it('falls back to the original image when no catalog entry exists', () => {
    const config = resolveProviderCreateConfig({ image: 'ubuntu:24.04' }, 'daytona', {})

    expect(config).toEqual({ image: 'ubuntu:24.04' })
  })

  it('throws when a logical image has no default or provider mapping', () => {
    expect(() => resolveProviderImage('agent-node', 'e2b', {
      'agent-node': {
        providers: {
          daytona: 'ghcr.io/acme/agent-node:2026.06',
        },
      },
    })).toThrow('No image mapping for provider "e2b"')
  })
})
