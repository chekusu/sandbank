import type {
  Checkpoint,
  WorkspaceAdapter,
  WorkspaceData,
  WorkspaceEntry,
} from './types.js'

export interface SandboxArchiveMount {
  uploadArchive(archive: Uint8Array | ReadableStream, destDir?: string): Promise<void>
  downloadArchive(srcDir?: string): Promise<ReadableStream>
}

export interface WorkspaceSandboxPathOptions {
  /** Durable workspace path to project into the sandbox. Defaults to `/workspace`. */
  workspacePath?: string
  /** Sandbox path used as the execution mount point. Defaults to `/workspace`. */
  sandboxPath?: string
}

export interface MaterializeWorkspaceOptions extends WorkspaceSandboxPathOptions {}

export interface SyncWorkspaceOptions extends WorkspaceSandboxPathOptions {
  /** Remove workspace files under `workspacePath` that are absent from the sandbox archive. */
  deleteMissing?: boolean
  /** Create a workspace checkpoint after sync. Set false to skip. Defaults to `sandbox-sync`. */
  checkpointLabel?: string | false
}

export interface WorkspaceBridgeResult {
  files: number
  bytes: number
}

export interface SyncWorkspaceResult extends WorkspaceBridgeResult {
  removed: number
  checkpoint?: Checkpoint
}

interface ArchiveFile {
  path: string
  data: Uint8Array
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })
const BLOCK_SIZE = 512

export async function materializeWorkspaceToSandbox(
  workspace: WorkspaceAdapter,
  sandbox: SandboxArchiveMount,
  options: MaterializeWorkspaceOptions = {},
): Promise<WorkspaceBridgeResult> {
  const workspacePath = normalizeAbsolutePath(options.workspacePath ?? '/workspace')
  const sandboxPath = normalizeAbsolutePath(options.sandboxPath ?? '/workspace')
  const entries = await workspace.list(workspacePath, { recursive: true })
  const files: ArchiveFile[] = []

  for (const entry of entries) {
    if (!shouldBridgeEntry(entry)) continue
    const data = await workspace.read(entry.path, { encoding: 'bytes' })
    const bytes = data instanceof Uint8Array ? data : textEncoder.encode(data)
    files.push({
      path: relativeArchivePath(workspacePath, entry.path),
      data: bytes,
    })
  }

  const archive = await gzip(createTar(files))
  await sandbox.uploadArchive(archive, sandboxPath)

  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.data.byteLength, 0),
  }
}

export async function syncWorkspaceFromSandbox(
  workspace: WorkspaceAdapter,
  sandbox: SandboxArchiveMount,
  options: SyncWorkspaceOptions = {},
): Promise<SyncWorkspaceResult> {
  const workspacePath = normalizeAbsolutePath(options.workspacePath ?? '/workspace')
  const sandboxPath = normalizeAbsolutePath(options.sandboxPath ?? '/workspace')
  const archive = await streamToBytes(await sandbox.downloadArchive(sandboxPath))
  const files = readTar(await gunzip(archive))
  const writtenPaths = new Set<string>()

  for (const file of files) {
    const target = joinAbsolutePath(workspacePath, file.path)
    await workspace.write(target, workspaceDataFromArchive(file.data))
    writtenPaths.add(target)
  }

  let removed = 0
  if (options.deleteMissing) {
    const existing = await workspace.list(workspacePath, { recursive: true })
    for (const entry of existing) {
      if (!shouldBridgeEntry(entry) || writtenPaths.has(entry.path)) continue
      await workspace.remove(entry.path, { missingOk: true })
      removed++
    }
  }

  const label = options.checkpointLabel ?? 'sandbox-sync'
  const checkpoint = label !== false && workspace.capabilities.checkpoint
    ? await workspace.checkpoint(label)
    : undefined

  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.data.byteLength, 0),
    removed,
    checkpoint,
  }
}

function isFileLike(entry: WorkspaceEntry): boolean {
  return entry.type !== 'directory'
}

function shouldBridgeEntry(entry: WorkspaceEntry): boolean {
  return isFileLike(entry) && !isSandbankInternalPath(entry.path)
}

function isSandbankInternalPath(path: string): boolean {
  const normalized = normalizeAbsolutePath(path)
  return normalized === '/.sandbank' || normalized.startsWith('/.sandbank/')
}

function workspaceDataFromArchive(data: Uint8Array): WorkspaceData {
  try {
    const text = textDecoder.decode(data)
    if (hasBinaryControlChars(text)) return copyBytes(data)
    return text
  } catch {
    return copyBytes(data)
  }
}

function hasBinaryControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true
  }
  return false
}

function createTar(files: ArchiveFile[]): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const file of files) {
    const header = createTarHeader(file.path, file.data.byteLength)
    chunks.push(header, file.data, new Uint8Array(paddingFor(file.data.byteLength)))
  }
  chunks.push(new Uint8Array(BLOCK_SIZE * 2))
  return concatBytes(chunks)
}

function readTar(tar: Uint8Array): ArchiveFile[] {
  const files: ArchiveFile[] = []
  let offset = 0

  while (offset + BLOCK_SIZE <= tar.byteLength) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE)
    if (isZeroBlock(header)) break

    const name = readNullTerminated(header, 0, 100)
    const prefix = readNullTerminated(header, 345, 155)
    const type = readNullTerminated(header, 156, 1)
    const size = parseOctal(readNullTerminated(header, 124, 12))
    const path = sanitizeArchivePath(prefix ? `${prefix}/${name}` : name)
    offset += BLOCK_SIZE

    const data = copyBytes(tar.subarray(offset, offset + size))
    if (type === '' || type === '0') files.push({ path, data })
    offset += size + paddingFor(size)
  }

  return files
}

function createTarHeader(path: string, size: number): Uint8Array {
  const normalized = sanitizeArchivePath(path)
  const { name, prefix } = splitTarPath(normalized)
  const header = new Uint8Array(BLOCK_SIZE)

  writeAscii(header, 0, 100, name)
  writeAscii(header, 100, 8, '0000644')
  writeAscii(header, 108, 8, '0000000')
  writeAscii(header, 116, 8, '0000000')
  writeAscii(header, 124, 12, octal(size, 11))
  writeAscii(header, 136, 12, octal(Math.floor(Date.now() / 1000), 11))
  header.fill(32, 148, 156)
  writeAscii(header, 156, 1, '0')
  writeAscii(header, 257, 6, 'ustar')
  writeAscii(header, 263, 2, '00')
  writeAscii(header, 345, 155, prefix)

  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  writeAscii(header, 148, 8, `${octal(checksum, 6)}\0 `)
  return header
}

function splitTarPath(path: string): { name: string; prefix: string } {
  if (byteLength(path) <= 100) return { name: path, prefix: '' }
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/')
    const name = parts.slice(i).join('/')
    if (byteLength(prefix) <= 155 && byteLength(name) <= 100) {
      return { name, prefix }
    }
  }
  throw new Error(`Workspace archive path is too long for ustar: ${path}`)
}

function sanitizeArchivePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
  const parts: string[] = []
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') throw new Error(`Workspace archive path cannot escape root: ${path}`)
    parts.push(part)
  }
  if (parts.length === 0) throw new Error('Workspace archive path cannot be empty')
  return parts.join('/')
}

function relativeArchivePath(basePath: string, filePath: string): string {
  const base = normalizeAbsolutePath(basePath)
  const file = normalizeAbsolutePath(filePath)
  if (base === '/') return sanitizeArchivePath(file)
  if (file === base) return sanitizeArchivePath(file.split('/').pop() ?? file)
  if (!file.startsWith(`${base}/`)) {
    throw new Error(`Workspace path ${file} is outside ${base}`)
  }
  return sanitizeArchivePath(file.slice(base.length + 1))
}

function joinAbsolutePath(basePath: string, relativePath: string): string {
  const base = normalizeAbsolutePath(basePath)
  const rel = sanitizeArchivePath(relativePath)
  return base === '/' ? `/${rel}` : `${base}/${rel}`
}

function normalizeAbsolutePath(input: string): string {
  const parts: string[] = []
  for (const part of input.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function paddingFor(size: number): number {
  return (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE
}

function readNullTerminated(bytes: Uint8Array, start: number, length: number): string {
  const end = start + length
  let cursor = start
  while (cursor < end && bytes[cursor] !== 0) cursor++
  return String.fromCharCode(...bytes.subarray(start, cursor)).trimEnd()
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = textEncoder.encode(value)
  if (bytes.byteLength > length) throw new Error(`Value does not fit tar header field: ${value}`)
  target.set(bytes, offset)
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0').slice(0, length - 1)
}

function parseOctal(value: string): number {
  const clean = value.replace(/\0/g, '').trim()
  return clean ? Number.parseInt(clean, 8) : 0
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every(byte => byte === 0)
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new CompressionStream('gzip'))
  return streamToBytes(stream)
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'))
  return streamToBytes(stream)
}

async function streamToBytes(stream: ReadableStream): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer))
  }
  return concatBytes(chunks)
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength
}
