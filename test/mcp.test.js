// Testa o servidor MCP em memória (sem stdio) com fetch simulado.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { criarServidor } from '../src/mcp/server.js';
import { ambienteIsolado, simularFetch, fixture } from './helpers.js';

describe('servidor MCP', () => {
  let client, limpar, fetchSim;

  before(async () => {
    limpar = ambienteIsolado();
    fetchSim = simularFetch([
      ['/localidades/estados/MS/municipios', { json: fixture('ibge-municipios-ms.json') }],
      ['brasilapi.com.br/api/cnpj', { json: fixture('brasilapi-cnpj-bb.json') }],
      ['publica.cnpj.ws', { json: fixture('cnpjws-bb.json') }],
    ]);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await criarServidor().connect(a);
    client = new Client({ name: 'teste', version: '0.0.0' });
    await client.connect(b);
  });

  after(async () => {
    await client?.close();
    fetchSim.restaurar();
    limpar();
  });

  test('expõe as 6 ferramentas', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'consultar_cnpj_real', 'consultar_pncp_contratos', 'db_status', 'geocodificar_cep', 'ibge_municipios_cnaes', 'inspecionar_site_erp',
    ]);
  });

  test('db_status sem DATABASE_URL responde configurado=false sem erro', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.DB_MEMORIA;
    const r = await client.callTool({ name: 'db_status', arguments: {} });
    assert.equal(r.isError, undefined);
    assert.equal(JSON.parse(r.content[0].text).configurado, false);
  });

  test('ibge_municipios_cnaes padrão retorna 79 municípios de MS', async () => {
    const r = await client.callTool({ name: 'ibge_municipios_cnaes', arguments: {} });
    assert.equal(r.isError, undefined);
    assert.equal(JSON.parse(r.content[0].text).total, 79);
  });

  test('consultar_cnpj_real retorna dados normalizados', async () => {
    const r = await client.callTool({ name: 'consultar_cnpj_real', arguments: { cnpj: '00.000.000/0001-91' } });
    const d = JSON.parse(r.content[0].text);
    assert.equal(d.razaoSocial, 'BANCO DO BRASIL SA');
    assert.equal(d.inscricoesEstaduais[0].inscricao, '0809427800174');
  });

  test('erro vira isError sem derrubar o servidor', async () => {
    const r = await client.callTool({ name: 'consultar_cnpj_real', arguments: { cnpj: '00000000000192' } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /CNPJ inválido/);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
  });
});
