# lit-search-mcp

One MCP endpoint for literature search across seven sources: OpenAlex, arXiv, PubMed, Crossref, Project Gutenberg, Open Library and the Internet Archive.

lit-search-mcp is a router. The seven sources are served by MCP servers written by [cyanheads](https://github.com/cyanheads), which npm installs alongside the router. The router gives an agent six uniform tools and forwards each call to the right server.

## Credits

The search work is done by these servers by cyanheads (Casey Hand), each under Apache-2.0:

| Source | Package | Repository |
|---|---|---|
| OpenAlex | `@cyanheads/openalex-mcp-server` | <https://github.com/cyanheads/openalex-mcp-server> |
| arXiv | `@cyanheads/arxiv-mcp-server` | <https://github.com/cyanheads/arxiv-mcp-server> |
| PubMed | `@cyanheads/pubmed-mcp-server` | <https://github.com/cyanheads/pubmed-mcp-server> |
| Crossref | `@cyanheads/crossref-mcp-server` | <https://github.com/cyanheads/crossref-mcp-server> |
| Project Gutenberg | `@cyanheads/gutenberg-mcp-server` | <https://github.com/cyanheads/gutenberg-mcp-server> |
| Open Library | `@cyanheads/openlibrary-mcp-server` | <https://github.com/cyanheads/openlibrary-mcp-server> |
| Internet Archive | `@cyanheads/internet-archive-mcp-server` | <https://github.com/cyanheads/internet-archive-mcp-server> |

lit-search-mcp does not copy or modify their code. It is an independent project and is not affiliated with or endorsed by cyanheads. If a source misbehaves, check whether the problem is in the upstream server before filing it there; see NOTICE.

## How it runs

Eight processes: seven upstream servers, each on its own loopback port, and the router in front of them.

```
MCP client(s) ──> router :28502/mcp ──> openalex          :28495
                                    ├─> arxiv             :28496
                                    ├─> pubmed            :28497
                                    ├─> crossref          :28498
                                    ├─> gutenberg         :28499
                                    ├─> openlibrary       :28500
                                    └─> internet-archive  :28501
```

All MCP clients on the machine (Claude Code, Codex, OpenCode, Hermes and so on) share one running set. Nothing is started per client session, so memory use stays flat as you add clients. On the reference machine the eight processes take about 250 MiB RSS in total.

The `lit-search-stack` command starts all eight, prefixes their log lines with the source name, and restarts any process that exits.

## Install

Requires Node.js 24 or later. No API keys are needed.

```bash
npm install -g github:iprawiranegara/lit-search-mcp
lit-search-stack
```

Check it:

```bash
curl http://127.0.0.1:28502/health
```

### Run it in the background (Linux)

`examples/systemd/lit-search-mcp.service` is a systemd user unit. Edit the `ExecStart` paths, then:

```bash
cp examples/systemd/lit-search-mcp.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now lit-search-mcp.service
```

`loginctl enable-linger "$USER"` keeps it running after you log out. On Windows or macOS, run `lit-search-stack` from the platform's own startup mechanism (a logon scheduled task, a launchd user agent). Only the Linux setup has been tested.

## Connect a client

Register the router as a remote Streamable HTTP server, by URL. Do not register the upstream servers individually.

```bash
# Claude Code
claude mcp add --transport http --scope user lit-search http://127.0.0.1:28502/mcp
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.lit-search]
url = "http://127.0.0.1:28502/mcp"
```

## Tools

| Tool | What it does | Sources |
|---|---|---|
| `list_sources` | Coverage summary for each source | all |
| `search_works` | Keyword search (`source`, `query`, optional `limit`, default 10) | all |
| `get_work` | Metadata for one work by ID (DOI, PMID, arXiv ID, OpenAlex ID, ...) | all |
| `get_references` | Works cited by a work | openalex, pubmed, crossref |
| `get_citations` | Works that cite a work | openalex, pubmed |
| `get_full_text` | Full text | arxiv, pubmed, gutenberg, internet-archive |

Gutenberg search ignores `limit` and returns pages of up to 32 books.

## Configuration

Everything is optional. Set variables in the shell or, with the systemd unit, in `~/.config/lit-search-mcp/env`. `examples/env.example` lists them all.

| Variable | Default | Meaning |
|---|---|---|
| `LIT_SEARCH_HOST` | `127.0.0.1` | Host every process binds to and the router connects to |
| `LIT_SEARCH_PORT` | `28502` | Router port |
| `LIT_SEARCH_PATH` | `/mcp` | MCP endpoint path for all processes |
| `LIT_SEARCH_PORT_<SOURCE>` | 28495 to 28501 | Port of one upstream, e.g. `LIT_SEARCH_PORT_INTERNET_ARCHIVE` |
| `LIT_SEARCH_URL_<SOURCE>` | unset | Full URL of an upstream you run yourself; overrides host and port |

The default ports sit below the ephemeral port ranges of Linux (32768 to 60999) and Windows and macOS (49152 to 65535), so an outgoing connection cannot take one of them first.

The upstream servers read their own settings from the same environment. Two are worth setting: `CROSSREF_MAILTO` (a contact address puts Crossref requests in its polite pool) and `NCBI_API_KEY` with `NCBI_ADMIN_EMAIL` for PubMed. Each package's README documents the full list.

### Router only

If you already run the upstream servers, start only the router with `lit-search-mcp` and point it at them with the `LIT_SEARCH_PORT_<SOURCE>` or `LIT_SEARCH_URL_<SOURCE>` variables.

## Behaviour notes

- The router keeps one connection per upstream. If a call fails it reconnects once and retries, so an upstream restart costs one slower call, not an error.
- The upstream versions are pinned in `package.json` to the versions this router was tested against. Newer cyanheads releases may rename tools or arguments; update the pins and the routing table in `index.mjs` together.
- Errors from the remote services (rate limits, outages) come back as tool errors with the upstream message.

## License

Apache License 2.0. See LICENSE and NOTICE.
