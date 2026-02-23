import type { AdapterSandbox } from './types.js'

/**
 * 基于 exec 的 writeFile 默认实现。
 * 将内容 base64 编码后通过 echo | base64 -d 写入文件。
 */
export async function writeFileViaExec(
  sandbox: AdapterSandbox,
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const bytes = typeof content === 'string'
    ? new TextEncoder().encode(content)
    : content

  const base64 = btoa(String.fromCharCode(...bytes))

  // 确保目标目录存在
  const dir = path.substring(0, path.lastIndexOf('/'))
  if (dir) {
    await sandbox.exec(`mkdir -p ${dir}`)
  }

  const result = await sandbox.exec(`echo '${base64}' | base64 -d > ${path}`)
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
  const result = await sandbox.exec(`base64 ${path}`)
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
