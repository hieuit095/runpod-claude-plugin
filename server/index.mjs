#!/usr/bin/env node
// Zero-dependency MCP (stdio) server for the RunPod API.
// - REST tools are generated at startup from spec/openapi.json (https://rest.runpod.io/v1)
// - Extra tools: serverless job runtime (api.runpod.ai/v2) and GraphQL passthrough (api.runpod.io/graphql)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const REST = process.env.RUNPOD_REST_URL || 'https://rest.runpod.io/v1';
const RUNTIME = process.env.RUNPOD_RUNTIME_URL || 'https://api.runpod.ai/v2';
const GRAPHQL = process.env.RUNPOD_GRAPHQL_URL || 'https://api.runpod.io/graphql';
const MAX_OUT = 100_000;
const spec = JSON.parse(readFileSync(join(here, '..', 'spec', 'openapi.json'), 'utf8'));

// ---------- schema helpers ----------
function deref(node, seen = new Set(), depth = 0) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => deref(n, seen, depth));
  if (node.$ref) {
    const name = node.$ref.replace('#/components/schemas/', '');
    if (seen.has(name) || depth > 6) return { type: 'object', description: `(see ${name})` };
    const target = spec.components.schemas[name];
    return deref(target, new Set([...seen, name]), depth + 1);
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'example' || k === 'examples' || k === 'readOnly') continue;
    if (k === 'nullable') continue;
    out[k] = deref(v, seen, depth);
  }
  if (node.nullable && typeof out.type === 'string') out.type = [out.type, 'null'];
  if (out.allOf) {
    const merged = { type: 'object', properties: {}, required: [] };
    for (const part of out.allOf) {
      Object.assign(merged.properties, part.properties || {});
      merged.required.push(...(part.required || []));
    }
    delete out.allOf;
    Object.assign(out, merged);
  }
  return out;
}

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

// ---------- REST tool generation ----------
const tools = new Map(); // name -> { def, handler }

function addTool(name, description, inputSchema, annotations, handler) {
  tools.set(name, {
    def: { name, description, inputSchema, annotations },
    handler,
  });
}

for (const [path, methods] of Object.entries(spec.paths)) {
  if (path === '/openapi.json' || path === '/docs') continue;
  if (path.endsWith('/update')) continue; // POST duplicate of PATCH
  for (const [method, op] of Object.entries(methods)) {
    if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
    const name = 'runpod_' + snake(op.operationId);
    const props = {};
    const required = [];
    const where = {}; // param -> 'path' | 'query' | 'body'
    for (const p of op.parameters || []) {
      const sch = deref(p.schema || {});
      if (p.description && !sch.description) sch.description = p.description;
      props[p.name] = sch;
      where[p.name] = p.in;
      if (p.required) required.push(p.name);
    }
    const bodySchema = op.requestBody?.content?.['application/json']?.schema;
    if (bodySchema) {
      const b = deref(bodySchema);
      for (const [k, v] of Object.entries(b.properties || {})) {
        const key = props[k] ? 'body_' + k : k;
        props[key] = v;
        where[key] = { body: k };
      }
      for (const r of b.required || []) required.push(props[r] && where[r] === 'path' ? 'body_' + r : r);
    }
    const isRead = method === 'get';
    const isDelete = method === 'delete';
    const desc =
      `${op.summary || op.operationId}: ${op.description || ''} ` +
      `[${method.toUpperCase()} ${path}]` +
      (method === 'post' && path === '/pods' ? ' WARNING: starts billing immediately.' : '') +
      (path === '/endpoints' && method === 'post' ? ' WARNING: may start billing workers.' : '');
    addTool(
      name,
      desc.trim(),
      { type: 'object', properties: props, required: [...new Set(required)] },
      { readOnlyHint: isRead, destructiveHint: isDelete, idempotentHint: isRead || isDelete, openWorldHint: true },
      async (args) => {
        let url = REST + path;
        const query = [];
        const body = {};
        for (const [k, v] of Object.entries(args || {})) {
          const w = where[k];
          if (w === undefined) throw new Error(`Unknown argument: ${k}`);
          if (w === 'path') url = url.replace(`{${k}}`, encodeURIComponent(String(v)));
          else if (w === 'query') {
            for (const item of Array.isArray(v) ? v : [v]) query.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`);
          } else if (typeof w === 'object') body[w.body] = v;
        }
        if (/\{/.test(url)) throw new Error('Missing required path parameter(s) for ' + path);
        if (query.length) url += '?' + query.join('&');
        return http(method.toUpperCase(), url, Object.keys(body).length || method === 'post' ? body : undefined);
      },
    );
  }
}

// ---------- serverless runtime tools ----------
const epId = { type: 'string', description: 'Serverless endpoint ID' };
const jobId = { type: 'string', description: 'Job ID returned by runpod_serverless_run' };
function rt(name, description, method, suffix, extraProps = {}, extraReq = [], ann = {}) {
  addTool(
    name,
    description,
    { type: 'object', properties: { endpointId: epId, ...extraProps }, required: ['endpointId', ...extraReq] },
    { readOnlyHint: method === 'GET', openWorldHint: true, ...ann },
    async (a) => {
      const u = `${RUNTIME}/${encodeURIComponent(a.endpointId)}/${suffix(a)}`;
      const body = method === 'POST' && suffix.name !== 'noBody' ? bodyOf(a) : undefined;
      return http(method, u, body);
    },
  );
}
const bodyOf = (a) => {
  const b = {};
  if (a.input !== undefined) b.input = a.input;
  if (a.webhook) b.webhook = a.webhook;
  if (a.policy) b.policy = a.policy;
  return b;
};
const inputProps = {
  input: { type: 'object', description: 'Job input payload passed to the worker handler (wrapped as {"input": ...}).' },
  webhook: { type: 'string', description: 'Optional HTTPS URL called when the job completes.' },
  policy: { type: 'object', description: 'Optional execution policy, e.g. {"executionTimeout": 3600000, "lowPriority": false, "ttl": 86400000}.' },
};
rt('runpod_serverless_run', 'Submit an ASYNC job to a Serverless endpoint (returns job id; poll with runpod_serverless_status). Billable.', 'POST', () => 'run', inputProps, ['input']);
rt('runpod_serverless_runsync', 'Submit a job and WAIT for the result (for short jobs, ~90s limit). Billable.', 'POST', () => 'runsync', inputProps, ['input']);
rt('runpod_serverless_status', 'Get status/output of a Serverless job.', 'GET', (a) => `status/${encodeURIComponent(a.jobId)}`, { jobId }, ['jobId']);
rt('runpod_serverless_stream', 'Get streamed partial output of a Serverless job.', 'GET', (a) => `stream/${encodeURIComponent(a.jobId)}`, { jobId }, ['jobId']);
rt('runpod_serverless_cancel', 'Cancel a Serverless job.', 'POST', function noBody(a) { return `cancel/${encodeURIComponent(a.jobId)}`; }, { jobId }, ['jobId'], { destructiveHint: true });
rt('runpod_serverless_retry', 'Retry a failed/timed-out Serverless job.', 'POST', function noBody(a) { return `retry/${encodeURIComponent(a.jobId)}`; }, { jobId }, ['jobId']);
rt('runpod_serverless_health', 'Worker and job-queue counts for a Serverless endpoint.', 'GET', () => 'health');
rt('runpod_serverless_purge_queue', 'Purge ALL queued (not running) jobs on an endpoint.', 'POST', function noBody() { return 'purge-queue'; }, {}, [], { destructiveHint: true });

// ---------- GraphQL passthrough ----------
addTool(
  'runpod_graphql',
  'Run a raw RunPod GraphQL query/mutation (https://api.runpod.io/graphql). Use for things REST lacks: gpuTypes (pricing, stock/availability), myself (balance, spend), dataCenters, pod bid/spot creation, etc. Mutations may incur cost.',
  {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'GraphQL document.' },
      variables: { type: 'object', description: 'Optional variables.' },
    },
    required: ['query'],
  },
  { openWorldHint: true },
  async (a) => http('POST', GRAPHQL, { query: a.query, variables: a.variables || {} }),
);

// ---------- HTTP ----------
async function http(method, url, body) {
  const key = process.env.RUNPOD_API_KEY;
  if (!key) throw new Error('RUNPOD_API_KEY is not set. Export it before starting Claude Code (create one at https://www.runpod.io/console/user/settings).');
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

// ---------- MCP stdio loop ----------
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    if (method === 'initialize') {
      reply({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'runpod', version: '0.1.0' },
      });
    } else if (method === 'ping') reply({});
    else if (method === 'tools/list') reply({ tools: [...tools.values()].map((t) => t.def) });
    else if (method === 'tools/call') {
      const t = tools.get(params?.name);
      if (!t) return fail(-32602, `Unknown tool: ${params?.name}`);
      try {
        const data = await t.handler(params.arguments || {});
        let text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        if (text.length > MAX_OUT) text = text.slice(0, MAX_OUT) + `\n…[truncated ${text.length - MAX_OUT} chars; narrow the query]`;
        reply({ content: [{ type: 'text', text: text ?? 'null' }] });
      } catch (e) {
        reply({ content: [{ type: 'text', text: String(e.message || e) }], isError: true });
      }
    } else if (id !== undefined) fail(-32601, `Method not found: ${method}`);
  } catch (e) {
    fail(-32603, String(e.message || e));
  }
});
