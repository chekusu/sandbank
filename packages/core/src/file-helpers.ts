import type { AdapterSandbox } from './types.js'

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * 基于 exec 的 writeFile 默认实现。
 * 将内容 base64 编码后通过 printf | base64 -d 写入文件。
 */
export async function writeFileViaExec(
  sandbox: AdapterSandbox,
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const bytes = typeof content === 'string'
    ? new TextEncoder().encode(content)
    : content

  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  const base64 = btoa(binary)

  // 确保目标目录存在
  const dir = path.substring(0, path.lastIndexOf('/'))
  if (dir) {
    await sandbox.exec(`mkdir -p ${shellEscape(dir)}`)
  }

  const result = await sandbox.exec(`printf '%s' ${shellEscape(base64)} | base64 -d > ${shellEscape(path)}`)
  if (result.exitCode !== 0) {
    throw new Error(`writeFile failed: ${result.stderr}`)
  }
}

/**
 * 基于 exec 的 readFile 默认实现。
 * 通过 base64 编码读取文件内容。
 */
export async function readFileViaExec(
  sandbox: AdapterSandbox,
  path: string,
): Promise<Uint8Array> {
  const result = await sandbox.exec(`base64 ${shellEscape(path)}`)
  if (result.exitCode !== 0) {
    throw new Error(`readFile failed: ${result.stderr}`)
  }

  const clean = result.stdout.replace(/\s/g, '')
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * 基于 exec 的 uploadArchive 默认实现。
 * 将 tar.gz 数据 base64 编码后传输并解压。
 */
export async function uploadArchiveViaExec(
  sandbox: AdapterSandbox,
  archive: Uint8Array | ReadableStream,
  destDir?: string,
): Promise<void> {
  // ReadableStream → Uint8Array
  let bytes: Uint8Array
  if (archive instanceof Uint8Array) {
    bytes = archive
  } else {
    const reader = (archive as ReadableStream<Uint8Array>).getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
    bytes = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
  }

  // base64 编码
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  const base64 = btoa(binary)

  const target = destDir ?? '/'
  const tmp = `/tmp/_sb_archive_${Date.now()}_${Math.random().toString(36).slice(2)}.tar.gz`

  // 写入临时文件
  const writeResult = await sandbox.exec(`printf '%s' ${shellEscape(base64)} | base64 -d > ${tmp}`)
  if (writeResult.exitCode !== 0) {
    throw new Error(`uploadArchive: write failed: ${writeResult.stderr}`)
  }

  // 解压
  const extractResult = await sandbox.exec(`tar xzf ${tmp} -C ${shellEscape(target)}`)
  if (extractResult.exitCode !== 0) {
    await sandbox.exec(`rm -f ${tmp}`)
    throw new Error(`uploadArchive: extract failed: ${extractResult.stderr}`)
  }

  // 清理
  await sandbox.exec(`rm -f ${tmp}`)
}

/**
 * 基于 exec 的 downloadArchive 默认实现。
 * 将指定目录打包为 tar.gz 并通过 base64 传输。
 */
export async function downloadArchiveViaExec(
  sandbox: AdapterSandbox,
  srcDir?: string,
): Promise<ReadableStream> {
  const source = srcDir ?? '/'
  const tmp = `/tmp/_sb_archive_${Date.now()}_${Math.random().toString(36).slice(2)}.tar.gz`

  // 打包
  const tarResult = await sandbox.exec(`tar czf ${tmp} -C ${shellEscape(source)} .`)
  if (tarResult.exitCode !== 0) {
    await sandbox.exec(`rm -f ${tmp}`).catch(() => {})
    throw new Error(`downloadArchive: tar failed: ${tarResult.stderr}`)
  }

  let readResult: { exitCode: number; stdout: string; stderr: string }
  try {
    // 读取 base64
    readResult = await sandbox.exec(`base64 ${tmp}`)
    if (readResult.exitCode !== 0) {
      throw new Error(`downloadArchive: read failed: ${readResult.stderr}`)
    }
  } finally {
    // 清理临时文件（无论成功或失败）
    await sandbox.exec(`rm -f ${tmp}`).catch(() => {})
  }

  // 解码为 Uint8Array
  const clean = readResult.stdout.replace(/\s/g, '')
  const binaryStr = atob(clean)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i)
  }

  // 包装为 ReadableStream
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}
