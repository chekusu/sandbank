import { describe, expect, it } from 'vitest'
import {
  MemoryWorkspaceAdapter,
  materializeWorkspaceToSandbox,
  syncWorkspaceFromSandbox,
} from '../src/index.js'

class ArchiveSandbox {
  uploadedArchive?: Uint8Array
  uploadDest?: string
  archiveToDownload?: Uint8Array
  downloadSource?: string

  async uploadArchive(archive: Uint8Array | ReadableStream, destDir?: string): Promise<void> {
    this.uploadedArchive = archive instanceof Uint8Array ? archive : await streamToBytes(archive)
    this.uploadDest = destDir
  }

  async downloadArchive(srcDir?: string): Promise<ReadableStream<Uint8Array>> {
    this.downloadSource = srcDir
    const archive = this.archiveToDownload
    if (!archive) throw new Error('missing archive')
    return new ReadableStream({
      start(controller) {
        controller.enqueue(archive)
        controller.close()
      },
    })
  }
}

describe('sandbox workspace bridge', () => {
  it('materializes a durable workspace into a sandbox and syncs it back elsewhere', async () => {
    const workspace = new MemoryWorkspaceAdapter()
    await workspace.write('/workspace/readme.md', 'hello')
    await workspace.write('/workspace/nested/data.bin', new Uint8Array([1, 2, 3]))
    const sandbox = new ArchiveSandbox()

    const materialized = await materializeWorkspaceToSandbox(workspace, sandbox, {
      workspacePath: '/workspace',
      sandboxPath: '/mnt/workspace',
    })

    expect(materialized).toEqual({ files: 2, bytes: 8 })
    expect(sandbox.uploadDest).toBe('/mnt/workspace')
    expect(sandbox.uploadedArchive).toBeInstanceOf(Uint8Array)

    sandbox.archiveToDownload = sandbox.uploadedArchive
    const restored = new MemoryWorkspaceAdapter()
    const synced = await syncWorkspaceFromSandbox(restored, sandbox, {
      workspacePath: '/copy',
      sandboxPath: '/mnt/workspace',
      checkpointLabel: false,
    })

    expect(synced.files).toBe(2)
    expect(synced.checkpoint).toBeUndefined()
    expect(sandbox.downloadSource).toBe('/mnt/workspace')
    await expect(restored.read('/copy/readme.md')).resolves.toBe('hello')
    const binary = await restored.read('/copy/nested/data.bin', { encoding: 'bytes' })
    expect([...binary as Uint8Array]).toEqual([1, 2, 3])
  })

  it('can replace stale workspace files and checkpoint after syncing from a sandbox', async () => {
    const sandboxSource = new MemoryWorkspaceAdapter()
    await sandboxSource.write('/workspace/keep.txt', 'provider-b')
    await sandboxSource.write('/workspace/new.txt', 'new')
    const sandbox = new ArchiveSandbox()
    await materializeWorkspaceToSandbox(sandboxSource, sandbox, {
      workspacePath: '/workspace',
      sandboxPath: '/workspace',
    })
    sandbox.archiveToDownload = sandbox.uploadedArchive

    const workspace = new MemoryWorkspaceAdapter()
    await workspace.write('/workspace/keep.txt', 'provider-a')
    await workspace.write('/workspace/stale.txt', 'old')

    const result = await syncWorkspaceFromSandbox(workspace, sandbox, {
      workspacePath: '/workspace',
      sandboxPath: '/workspace',
      deleteMissing: true,
      checkpointLabel: 'after provider switch',
    })

    expect(result.files).toBe(2)
    expect(result.removed).toBe(1)
    expect(result.checkpoint?.label).toBe('after provider switch')
    await expect(workspace.read('/workspace/keep.txt')).resolves.toBe('provider-b')
    await expect(workspace.read('/workspace/new.txt')).resolves.toBe('new')
    await expect(workspace.stat('/workspace/stale.txt')).rejects.toThrow('Workspace path not found')
  })

  it('does not expose or delete Sandbank internal workspace metadata', async () => {
    const source = new MemoryWorkspaceAdapter()
    await source.write('/workspace/app.txt', 'app')
    await source.write('/.sandbank/checkpoints/internal.json', 'metadata')
    const sandbox = new ArchiveSandbox()

    await materializeWorkspaceToSandbox(source, sandbox, {
      workspacePath: '/',
      sandboxPath: '/workspace',
    })

    sandbox.archiveToDownload = sandbox.uploadedArchive
    const restored = new MemoryWorkspaceAdapter()
    await restored.write('/.sandbank/checkpoints/existing.json', 'keep')
    await restored.write('/workspace/stale.txt', 'stale')

    await syncWorkspaceFromSandbox(restored, sandbox, {
      workspacePath: '/',
      sandboxPath: '/workspace',
      deleteMissing: true,
      checkpointLabel: false,
    })

    await expect(restored.read('/workspace/app.txt')).resolves.toBe('app')
    await expect(restored.read('/.sandbank/checkpoints/existing.json')).resolves.toBe('keep')
    await expect(restored.stat('/.sandbank/checkpoints/internal.json')).rejects.toThrow('Workspace path not found')
    await expect(restored.stat('/workspace/stale.txt')).rejects.toThrow('Workspace path not found')
  })
})

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
