import { readFile, writeFile } from 'node:fs/promises'
import {
  runHarnessBenchmarkSuite,
  type HarnessBenchmarkCase,
  type HarnessBenchmarkReport,
} from '../../harness-benchmark.js'
import type { CliFlags } from '../auth.js'

export async function harnessBenchmarkCommand(args: string[], flags: CliFlags): Promise<void> {
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    usage()
    return
  }

  const baseUrl = takeOption(args, '--base-url')
    ?? process.env['SANDBANK_HARNESS_BASE_URL']
    ?? process.env['CHATW_HARNESS_BASE_URL']
    ?? 'http://127.0.0.1:8789'
  const apiKey = takeOption(args, '--api-key')
    ?? process.env['SANDBANK_HARNESS_API_KEY']
    ?? process.env['CHATW_HARNESS_API_KEY']
  const casesFile = takeOption(args, '--cases')
  const outFile = takeOption(args, '--out')
  const question = takeOption(args, '--question')
  const caseId = takeOption(args, '--case-id') ?? 'manual'
  const json = flags.json || takeFlag(args, '--json')

  const cases = casesFile
    ? await readCases(casesFile)
    : question
      ? [{
        id: caseId,
        question,
        expect: {
          requireDynamicWorker: true,
        },
      }]
      : []

  if (cases.length === 0) {
    usage()
    process.exit(1)
  }

  const report = await runHarnessBenchmarkSuite({ baseUrl, apiKey, cases })
  const output = json ? JSON.stringify(report, null, 2) : formatTextReport(report)
  if (outFile) await writeFile(outFile, `${output}\n`)
  else console.log(output)
}

async function readCases(path: string): Promise<HarnessBenchmarkCase[]> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as HarnessBenchmarkCase[] | { cases?: HarnessBenchmarkCase[] }
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed.cases)) return parsed.cases
  throw new Error('Harness benchmark cases file must be an array or an object with a cases array.')
}

function formatTextReport(report: HarnessBenchmarkReport): string {
  const lines = [
    `Harness benchmark: ${report.summary.averageScore}/100 average (${report.summary.passed}/${report.summary.total} passed)`,
    `Target: ${report.baseUrl}`,
  ]
  for (const item of report.cases) {
    lines.push('')
    lines.push(`${item.caseId}: ${item.score.score}/100 ${item.score.passed ? 'passed' : 'failed'} (${item.timings.totalMs}ms, events=${item.observations.eventCount})`)
    lines.push(`  question: ${item.question}`)
    lines.push(`  final: ${item.observations.finalText.slice(0, 240) || '(empty)'}`)
    if (item.observations.toolUses?.length) lines.push(`  tools: ${item.observations.toolUses.join(', ')}`)
    if (item.observations.harnessEventLabels?.length) lines.push(`  events: ${item.observations.harnessEventLabels.join(', ')}`)
    for (const feedback of item.score.feedback) lines.push(`  - ${feedback}`)
  }
  return lines.join('\n')
}

function takeFlag(args: string[], name: string): boolean {
  const idx = args.indexOf(name)
  if (idx === -1) return false
  args.splice(idx, 1)
  return true
}

function takeOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx === -1) return undefined
  const value = args[idx + 1]
  args.splice(idx, 2)
  return value
}

function usage(): void {
  console.log(`Usage: sandbank harness-benchmark --question <prompt> [--base-url <url>] [--json]
       sandbank harness-benchmark --cases <cases.json> [--out <report.json>]

Runs benchmark prompts against a Sandbank harness API and scores transport,
lifecycle events, workspace persistence, Dynamic Worker capsule execution,
model streaming, expectations, and latency.

Case file format:
  [
    {
      "id": "basic-dynamic-worker",
      "question": "@agent inspect the Dynamic Worker state",
      "expect": {
        "requireDynamicWorker": true,
        "requiredTextIncludes": ["Dynamic Worker"],
        "maxTotalMs": 30000
      }
    }
  ]`)
}
