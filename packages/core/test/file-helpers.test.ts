import { describe, it, expect, vi } from 'vitest'
import { uploadArchiveViaExec, downloadArchiveViaExec } from '../src/file-helpers.js'
import type { AdapterSandbox } from '../src/types.js'

function mockSandbox(execFn?: (...args: unknown[]) => unknown): AdapterSandbox {
  return {
    id: 'sb-test',
    state: 'running',
    createdAt: '2025-01-01T00:00:00Z',
    exec: (execFn ?? vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))) as AdapterSandbox['exec'],
  }
}

describe('uploadArchiveViaExec', () => {
  it('base64 encodes data and runs tar xzf with default destDir', async () => {
    const calls: string[] = []
    const exec = vi.fn(async (cmd: string) => {
      calls.push(cmd)
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const sandbox = mockSandbox(exec)
    const data = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]) // fake gzip header

    await uploadArchiveViaExec(sandbox, data)

    // Should have 3 calls: write, extract, cleanup
    expect(calls).toHaveLength(3)
    expect(calls[0]).toContain('base64 -d')
    expect(calls[0]).toMatch(/\/tmp\/_sb_archive_\d+_\w+\.tar\.gz/)
    expect(calls[1]).toMatch(/tar xzf \/tmp\/_sb_archive_\d+_\w+\.tar\.gz -C '\/'/)
    expect(calls[2]).toMatch(/rm -f \/tmp\/_sb_archive_\d+_\w+\.tar\.gz/)
  })

  it('uses custom destDir when provided', async () => {
    const calls: string[] = []
    const exec = vi.fn(async (cmd: string) => {
      calls.push(cmd)
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const sandbox = mockSandbox(exec)

    await uploadArchiveViaExec(sandbox, new Uint8Array([1, 2, 3]), '/workspace')

    expect(calls[1]).toMatch(/tar xzf \/tmp\/_sb_archive_\d+_\w+\.tar\.gz -C '\/workspace'/)
  })

  it('handles ReadableStream input', async () => {
    const calls: string[] = []
    const exec = vi.fn(async (cmd: string) => {
      calls.push(cmd)
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const sandbox = mockSandbox(exec)

    const chunk1 = new Uint8Array([1, 2, 3])
    const chunk2 = new Uint8Array([4, 5, 6])
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk1)
        controller.enqueue(chunk2)
        controller.close()
      },
    })

    await uploadArchiveViaExec(sandbox, stream)

    // Verify base64 contains all bytes (1,2,3,4,5,6)
    const expected = btoa(String.fromCharCode(1, 2, 3, 4, 5, 6))
    expect(calls[0]).toContain(expected)
  })

  it('throws and cleans up on extract failure', async () => {
    let callCount = 0
    const exec = vi.fn(async () => {
      callCount++
      if (callCount === 2) {
        // extract fails
        return { exitCode: 1, stdout: '', stderr: 'tar: error' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const sandbox = mockSandbox(exec)

    await expect(uploadArchiveViaExec(sandbox, new Uint8Array([1]))).rejects.toThrow('extract failed')
    // cleanup call should have happened (write + extract fail + cleanup = 3)
    expect(exec).toHaveBeenCalledTimes(3)
  })

  it('throws on write failure', async () => {
    const exec = vi.fn(async () => {
      return { exitCode: 1, stdout: '', stderr: 'disk full' }
    })
    const sandbox = mockSandbox(exec)

    await expect(uploadArchiveViaExec(sandbox, new Uint8Array([1]))).rejects.toThrow('write failed')
  })
})

describe('downloadArchiveViaExec', () => {
  it('runs tar czf and returns base64-decoded ReadableStream with default srcDir', async () => {
    const tarContent = new Uint8Array([0x1f, 0x8b, 0x08, 0x00])
    let binary = ''
    for (let i = 0; i < tarContent.length; i++) {
      binary += String.fromCharCode(tarContent[i]!)
    }
    const base64Content = btoa(binary)

    const calls: string[] = []
    const exec = vi.fn(async (cmd: string) => {
      calls.push(cmd)
      if (cmd.startsWith('base64 ')) {
        return { exitCode: 0, stdout: base64Content + '\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const sandbox = mockSandbox(exec)

    const stream = await downloadArchiveViaExec(sandbox)

    // Verify commands
    expect(calls[0]).toMatch(/tar czf \/tmp\/_sb_archive_\d+_\w+\.tar\.gz -C '\/' \./)
    expect(calls[1]).toMatch(/base64 \/tmp\/_sb_archive_\d+_\w+\.tar\.gz/)
    expect(calls[2]).toMatch(/rm -f \/tmp\/_sb_archive_\d+_\w+\.tar\.gz/)

    // Read stream and verify content
    const reader = stream.getReader()
    const { value } = await reader.read()
    expect(new Uint8Array(value!)).toEqual(tarContent)
  })

  it('uses custom srcDir', async () => {
    const calls: string[] = []
    const exec = vi.fn(async (cmd: string) => {
      calls.push(cmd)
      if (cmd.startsWith('base64 ')) {
        return { exitCode: 0, stdout: btoa('x'), stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const sandbox = mockSandbox(exec)

    await downloadArchiveViaExec(sandbox, '/tmp/mydir')

    expect(calls[0]).toMatch(/tar czf \/tmp\/_sb_archive_\d+_\w+\.tar\.gz -C '\/tmp\/mydir' \./)
  })

  it('throws and cleans up on tar failure', async () => {
    const exec = vi.fn(async () => {
      return { exitCode: 1, stdout: '', stderr: 'tar: error' }
    })
    const sandbox = mockSandbox(exec)

    await expect(downloadArchiveViaExec(sandbox)).rejects.toThrow('tar failed')
    // tar fail + cleanup = 2 calls
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('throws and cleans up on base64 read failure', async () => {
    let callCount = 0
    const exec = vi.fn(async () => {
      callCount++
      if (callCount === 2) {
        // base64 read fails
        return { exitCode: 1, stdout: '', stderr: 'read error' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const sandbox = mockSandbox(exec)

    await expect(downloadArchiveViaExec(sandbox)).rejects.toThrow('read failed')
    // tar + base64 fail + cleanup = 3 calls
    expect(exec).toHaveBeenCalledTimes(3)
  })
})
