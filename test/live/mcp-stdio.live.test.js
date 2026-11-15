// Teste ponta-a-ponta AO VIVO: sobe `node src/mcp/server.js` via stdio, como o Claude Code faz pelo .mcp.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('MCP stdio: tools/list + tools/call ao vivo', { skip: process.env.LIVE !== '1' && 'defina LIVE=1', timeout: 60_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(RAIZ, 'src', 'mcp', 'server.js')],
    cwd: RAIZ,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'teste-stdio', version: '0.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 5);
    const r = await client.callTool({ name: 'ibge_municipios_cnaes', arguments: { uf: 'MS' } });
    const d = JSON.parse(r.content[0].text);
    assert.equal(d.total, 79);
    console.log(`\n── MCP stdio ──\nferramentas: ${tools.map((t) => t.name).join(', ')}\nibge_municipios_cnaes(MS).total = ${d.total}`);
  } finally {
    await client.close();
  }
});
