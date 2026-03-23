export function helpCommand(): void {
  console.log(`sandbank — Sandbox SDK and CLI for AI agents

Usage: sandbank <command> [options]

Commands:
  login                             Save API key or wallet key
  config                            Show or set configuration
  create [--image <img>]            Create a new sandbox
  list                              List your sandboxes
  get <id>                          Get sandbox details
  destroy <id>                      Destroy a sandbox
  exec <id> <command>               Execute a command in a sandbox
  clone [<id>]                      Clone a sandbox
  keep <id> [--minutes <n>]         Extend sandbox timeout
  addons create <type> [--intent]   Create an addon
  addons list                       List addons
  snapshot create <id> <name>       Create a snapshot
  snapshot list <id>                List snapshots
  snapshot restore <id> <name>      Restore a snapshot
  snapshot delete <id> <name>       Delete a snapshot

Global options:
  --api-key <key>       API key for authentication
  --wallet-key <0x..>   EVM private key for x402 payment
  --url <url>           API URL (default: https://cloud.sandbank.dev)
  --json                Output as JSON
  --version, -v         Show version
  --help, -h            Show this help

Environment variables:
  SANDBANK_API_KEY          API key
  SANDBANK_AGENT_TOKEN      Box agent token (inside sandbox)
  SANDBANK_WALLET_KEY       EVM private key
  SANDBANK_API_URL          API URL
  SANDBANK_BOX_ID           Current box ID (inside sandbox)

https://sandbank.dev`)
}
