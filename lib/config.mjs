/**
 * Shared address configuration for the lit-search-mcp router and the stack launcher.
 *
 * Every value can be overridden with an environment variable. The default ports
 * (28495-28502) sit below the ephemeral port ranges of Linux (32768-60999) and
 * Windows/macOS (49152-65535), so an outgoing connection cannot occupy them first.
 *
 *   LIT_SEARCH_HOST                 bind/connect host for all eight processes (default 127.0.0.1)
 *   LIT_SEARCH_PORT                 router port (default 28502)
 *   LIT_SEARCH_PATH                 MCP endpoint path for every process (default /mcp)
 *   LIT_SEARCH_PORT_<SOURCE>        upstream port, e.g. LIT_SEARCH_PORT_OPENALEX=28495
 *   LIT_SEARCH_URL_<SOURCE>         full upstream URL; wins over host/port, e.g. for a remote upstream
 *
 * <SOURCE> is the source key upper-cased with "-" replaced by "_" (INTERNET_ARCHIVE).
 */

export const UPSTREAMS = {
  openalex:           { pkg: '@cyanheads/openalex-mcp-server',         port: 28495 },
  arxiv:              { pkg: '@cyanheads/arxiv-mcp-server',            port: 28496 },
  pubmed:             { pkg: '@cyanheads/pubmed-mcp-server',           port: 28497 },
  crossref:           { pkg: '@cyanheads/crossref-mcp-server',         port: 28498 },
  gutenberg:          { pkg: '@cyanheads/gutenberg-mcp-server',        port: 28499 },
  openlibrary:        { pkg: '@cyanheads/openlibrary-mcp-server',      port: 28500 },
  'internet-archive': { pkg: '@cyanheads/internet-archive-mcp-server', port: 28501 },
};

const env = process.env;

function envKey(source) {
  return source.toUpperCase().replace(/-/g, '_');
}

function intFrom(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} must be a TCP port number, got "${value}"`);
  }
  return n;
}

export const HOST = env.LIT_SEARCH_HOST || '127.0.0.1';
export const MCP_PATH = env.LIT_SEARCH_PATH || '/mcp';
export const ROUTER_PORT = intFrom(env.LIT_SEARCH_PORT, 28502, 'LIT_SEARCH_PORT');

export function upstreamPort(source) {
  const name = `LIT_SEARCH_PORT_${envKey(source)}`;
  return intFrom(env[name], UPSTREAMS[source].port, name);
}

export function upstreamUrl(source) {
  const override = env[`LIT_SEARCH_URL_${envKey(source)}`];
  if (override) return override;
  return `http://${HOST}:${upstreamPort(source)}${MCP_PATH}`;
}
