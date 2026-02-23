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
