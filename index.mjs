#!/usr/bin/env node
/**
 * lit-search-mcp: one MCP endpoint that routes six literature-search tools to
 * seven upstream MCP servers written by cyanheads (Casey Hand), each under
 * Apache-2.0. The upstream servers run as separate processes; this router only
 * calls their tools over Streamable HTTP. See NOTICE and README.md.
 *
 * Sources: openalex | arxiv | pubmed | crossref | gutenberg | openlibrary | internet-archive
 */

import { readFileSync } from 'node:fs';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HOST, MCP_PATH, ROUTER_PORT, upstreamUrl } from './lib/config.mjs';

const { version: VERSION } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

const DEFAULT_LIMIT = 10;

// ── upstream routing table ─────────────────────────────────────────────────
// Each entry maps the router's generic operations onto the upstream server's
// own tool names and argument shapes. null = the upstream has no equivalent.

const SOURCES = {
  openalex: {
    label: 'OpenAlex',
    description: '100M+ works with citations, references, concepts, institutions. The richest citation graph.',
    search: (q, lim) => ['openalex_search_entities', { entity_type: 'works', query: q, per_page: lim }],
    getWork: (id) => ['openalex_search_entities', { entity_type: 'works', id }],
    // `direction` follows OpenAlex's filter names, which read backwards in English:
    // `cited_by` returns the works the seed cites (its references) and `cites` returns
    // the works that cite the seed. See iprawiranegara/lit-search-mcp#1.
    getReferences: (id) => ['openalex_get_citation_graph', { seed_id: id, direction: 'cited_by' }],
    getCitations: (id) => ['openalex_get_citation_graph', { seed_id: id, direction: 'cites' }],
    getFullText: null,
  },
  arxiv: {
    label: 'arXiv',
    description: 'Preprints in physics, CS, math, econ, q-bio. Full-text HTML available.',
    search: (q, lim) => ['arxiv_search', { query: q, max_results: lim }],
    getWork: (id) => ['arxiv_get_metadata', { paper_ids: id }],
    getReferences: null,
    getCitations: null,
    getFullText: (id) => ['arxiv_read_paper', { paper_id: id }],
  },
  pubmed: {
    label: 'PubMed',
    description: 'Biomedical literature with MeSH terms, full-text OA, cited-by references.',
    search: (q, lim) => ['pubmed_search_articles', { query: q, maxResults: lim }],
    getWork: (id) => ['pubmed_fetch_articles', { pmids: [id] }],
    getReferences: (id) => ['pubmed_find_related', { pmid: id, relationship: 'references' }],
    getCitations: (id) => ['pubmed_find_related', { pmid: id, relationship: 'cited_by' }],
    getFullText: (id) => ['pubmed_fetch_fulltext', { pmids: [id] }],
  },
  crossref: {
    label: 'Crossref',
    description: 'DOI-centric metadata, the canonical reference/citation backbone.',
    search: (q, lim) => ['crossref_search_works', { query: q, rows: lim }],
    getWork: (id) => ['crossref_get_work', { doi: id }],
    getReferences: (id) => ['crossref_get_references', { doi: id }],
    getCitations: null,
    getFullText: null,
  },
  gutenberg: {
    label: 'Project Gutenberg',
    description: '70,000+ public domain books with full text. Search returns pages of up to 32 books; limit is ignored.',
    search: (q) => ['gutenberg_search_books', { query: q, page: 1 }],
    getWork: (id) => ['gutenberg_get_book', { id: Number.parseInt(id, 10) }],
    getReferences: null,
    getCitations: null,
    getFullText: (id) => ['gutenberg_get_text', { id: Number.parseInt(id, 10) }],
  },
  openlibrary: {
    label: 'OpenLibrary',
    description: 'Books metadata, editions, authors. No full text.',
    search: (q, lim) => ['openlibrary_search_books', { query: q, limit: lim }],
    getWork: (id) => ['openlibrary_get_work', { work_id: id }],
    getReferences: null,
    getCitations: null,
    getFullText: null,
  },
  'internet-archive': {
    label: 'Internet Archive',
    description: 'Wayback Machine + 40M items. Web captures, historical texts, multimedia.',
    search: (q, lim) => ['ia_search_items', { query: q, rows: lim }],
    getWork: (id) => ['ia_get_item', { identifier: id }],
    getReferences: null,
    getCitations: null,
    getFullText: (id) => ['ia_get_text', { identifier: id }],
  },
};

const SOURCE_NAMES = Object.keys(SOURCES);
const UPSTREAM_URLS = Object.fromEntries(SOURCE_NAMES.map((s) => [s, upstreamUrl(s)]));

const supporting = (op) => SOURCE_NAMES.filter((s) => SOURCES[s][op] !== null);
const REF_SOURCES = supporting('getReferences');
const CIT_SOURCES = supporting('getCitations');
const FULLTEXT_SOURCES = supporting('getFullText');

// ── upstream MCP client pool ───────────────────────────────────────────────
// One long-lived client per upstream, shared by every incoming session. A
// failed call drops the client, reconnects once and retries (covers a stale
// session after an upstream restart).

const clients = {};

async function connect(source) {
  const client = new Client({ name: 'lit-search-mcp', version: VERSION });
  await client.connect(new StreamableHTTPClientTransport(new URL(UPSTREAM_URLS[source])));
  clients[source] = client;
  return client;
}

async function upstream(source, toolName, args) {
  const client = clients[source] ?? (await connect(source));
  try {
    return await client.callTool({ name: toolName, arguments: args });
  } catch {
    try { await client.close(); } catch {}
    delete clients[source];
    const fresh = await connect(source);
    return await fresh.callTool({ name: toolName, arguments: args });
  }
}

// ── tool schemas ───────────────────────────────────────────────────────────

const sourceProp = { type: 'string', enum: SOURCE_NAMES, description: 'Literature source.' };

const TOOLS = [
  {
    name: 'list_sources',
    description: 'List all available literature sources with coverage summary. Call this first to choose the right source.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_works',
    description: 'Search for works (papers, books, preprints) by keyword. Returns matching items with IDs for get_work / get_references / get_citations / get_full_text.',
    inputSchema: {
      type: 'object',
      properties: {
        source: sourceProp,
        query: { type: 'string', description: 'Search keyword(s).' },
        limit: { type: 'number', description: `Max results (default ${DEFAULT_LIMIT}). Ignored by gutenberg, which returns pages of up to 32.`, default: DEFAULT_LIMIT },
      },
      required: ['source', 'query'],
    },
  },
  {
    name: 'get_work',
    description: 'Get full metadata for a single work by its ID (DOI, PMID, arXiv ID, OpenAlex ID, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        source: sourceProp,
        id: { type: 'string', description: 'Work identifier (DOI, PMID, arXiv ID, OpenAlex work ID, etc.).' },
      },
      required: ['source', 'id'],
    },
  },
  {
    name: 'get_references',
    description: `Get the reference list of a work (papers it cites). Supported: ${REF_SOURCES.join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: { source: sourceProp, id: { type: 'string', description: 'Work identifier.' } },
      required: ['source', 'id'],
    },
  },
  {
    name: 'get_citations',
    description: `Get works that cite a given work. Supported: ${CIT_SOURCES.join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: { source: sourceProp, id: { type: 'string', description: 'Work identifier.' } },
      required: ['source', 'id'],
    },
  },
  {
    name: 'get_full_text',
    description: `Get full text of a work. Supported: ${FULLTEXT_SOURCES.join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: { source: sourceProp, id: { type: 'string', description: 'Work identifier.' } },
      required: ['source', 'id'],
    },
  },
];

// ── tool dispatch ──────────────────────────────────────────────────────────

const text = (t, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: t }] });

const OPS = {
  get_references: ['getReferences', 'References', REF_SOURCES],
  get_citations: ['getCitations', 'Citations', CIT_SOURCES],
  get_full_text: ['getFullText', 'Full text', FULLTEXT_SOURCES],
};

async function dispatch(name, args) {
  if (name === 'list_sources') {
    return text(SOURCE_NAMES.map((k) => `**${k}** (${SOURCES[k].label}): ${SOURCES[k].description}`).join('\n'));
  }

  if (!Object.hasOwn(SOURCES, args.source ?? '')) {
    return text(`Unknown source "${args.source}". Valid: ${SOURCE_NAMES.join(', ')}`, true);
  }
  const src = SOURCES[args.source];

  let call;
  if (name === 'search_works') {
    call = src.search(args.query, args.limit ?? DEFAULT_LIMIT);
  } else if (name === 'get_work') {
    call = src.getWork(args.id);
  } else if (Object.hasOwn(OPS, name)) {
    const [op, label, supported] = OPS[name];
    if (!src[op]) {
      return text(`${label} not supported for source "${args.source}". Supported sources: ${supported.join(', ')}.`);
    }
    call = src[op](args.id);
  } else {
    return text(`Unknown tool: ${name}`, true);
  }

  try {
    return await upstream(args.source, ...call);
  } catch (err) {
    return text(`${args.source} error: ${err.message}`, true);
  }
}

// ── MCP server factory (the SDK Server is single-use, so one per request) ──

function makeServer() {
  const s = new Server({ name: 'lit-search-mcp', version: VERSION }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => dispatch(req.params.name, req.params.arguments ?? {}));
  return s;
}

// ── HTTP listener ──────────────────────────────────────────────────────────

function health() {
  return {
    status: 'ok',
    version: VERSION,
    sources: SOURCE_NAMES,
    tools: TOOLS.map((t) => t.name),
    upstreams: UPSTREAM_URLS,
    capabilities: Object.fromEntries(
      SOURCE_NAMES.map((s) => [s, {
        search: true,
        getWork: true,
        getReferences: SOURCES[s].getReferences !== null,
        getCitations: SOURCES[s].getCitations !== null,
        getFullText: SOURCES[s].getFullText !== null,
      }]),
    ),
  };
}

const httpServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health()));
    return;
  }

  if (!req.url?.startsWith(MCP_PATH)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  try {
    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      if (raw) {
        try { body = JSON.parse(raw); } catch { /* the transport reports the parse error */ }
      }
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = makeServer();
    res.on('close', () => transport.close().catch(() => {}));
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('request failed:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
    }
  }
});

httpServer.on('error', (err) => {
  console.error(`lit-search-mcp cannot listen on ${HOST}:${ROUTER_PORT}: ${err.code ?? err.message}`);
  process.exit(1);
});

httpServer.listen(ROUTER_PORT, HOST, () => {
  console.log(`lit-search-mcp ${VERSION} ready on http://${HOST}:${ROUTER_PORT}${MCP_PATH}`);
  for (const s of SOURCE_NAMES) console.log(`  ${s.padEnd(17)} -> ${UPSTREAM_URLS[s]}`);
});

function shutdown() {
  httpServer.close();
  for (const c of Object.values(clients)) c.close().catch(() => {});
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
