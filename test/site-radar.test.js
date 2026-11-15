import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { analisarHtml, extrairCnpjs, normalizarDominio, inspecionarSite } from '../src/conectores/site-radar.js';
import { simularFetch } from './helpers.js';

const HTML_EMPRESA = `<!doctype html><html><head><title> Indústria Exemplo  Ltda </title>
<script src="https://cdn.exemplo.com/whatsapp-widget.js"></script></head>
<body>
  <a href="https://wa.me/5567999999999">Fale no WhatsApp</a>
  <a href="https://exemplo.gupy.io/">Trabalhe Conosco</a>
  <a href="https://portal.exemplo.com.br/totvs-rm/portal">Portal do Fornecedor (TOTVS RM)</a>
  <footer>Indústria Exemplo Ltda — CNPJ: 00.000.000/0001-91 · CNPJ 11222333000181 · 12.ABC.345/01DE-35
  · inválido 00.000.000/0001-92</footer>
</body></html>`;

describe('analisarHtml', () => {
  test('extrai título, CNPJs válidos, ERP e RH com evidência', () => {
    const r = analisarHtml(HTML_EMPRESA);
    assert.equal(r.titulo, 'Indústria Exemplo Ltda');
    assert.deepEqual(r.cnpjs.map((c) => c.cnpj).sort(), ['00000000000191', '11222333000181', '12ABC34501DE35']);
    assert.deepEqual(r.erps.map((e) => e.nome), ['totvs']);
    assert.match(r.erps[0].evidencia, /totvs-rm/);
    assert.deepEqual(r.rh.map((e) => e.nome), ['gupy']);
    assert.ok(r.trabalheConosco);
    assert.equal(r.indicioMedioGrande, true);
  });

  test('não confunde "whatsapp" com SAP nem marca médio/grande só por "trabalhe conosco"', () => {
    const r = analisarHtml('<a href="/trabalhe-conosco">Vagas</a><script src="whatsapp.js"></script>');
    assert.deepEqual(r.erps, []);
    assert.ok(r.trabalheConosco);
    assert.equal(r.indicioMedioGrande, false);
  });

  test('detecta SAP, Sankhya, Sólides e Vagas.com', () => {
    const r = analisarHtml('Usamos SAP Business One e sankhya-om; vagas em empresa.vagas.solides.com.br e www.vagas.com.br/empresa');
    assert.deepEqual(r.erps.map((e) => e.nome).sort(), ['sankhya', 'sap']);
    assert.deepEqual(r.rh.map((e) => e.nome).sort(), ['solides', 'vagas_com']);
  });

  test('extrairCnpjs ignora 14 dígitos soltos sem rótulo', () => {
    assert.deepEqual(extrairCnpjs('pedido 00000000000191 enviado'), []);
  });
});

describe('normalizarDominio', () => {
  test('aceita domínio puro e URL', () => {
    assert.deepEqual(normalizarDominio('empresa.com.br').candidatos, ['https://empresa.com.br/', 'http://empresa.com.br/']);
    assert.deepEqual(normalizarDominio('https://www.empresa.com.br/x').candidatos, ['https://www.empresa.com.br/x']);
  });
  test('bloqueia endereços locais/privados', () => {
    assert.throws(() => normalizarDominio('localhost:3000'), /não permitido/);
    assert.throws(() => normalizarDominio('http://192.168.0.1'), /não permitido/);
  });
});

describe('inspecionarSite (fetch simulado)', () => {
  let fetchSim;
  afterEach(() => fetchSim?.restaurar());

  test('https falha → tenta http', async () => {
    fetchSim = simularFetch([
      [/^https:/, new TypeError('ECONNREFUSED')],
      [/^http:/, { html: HTML_EMPRESA }],
    ]);
    const r = await inspecionarSite('empresa.com.br');
    assert.equal(r.acessivel, true);
    assert.equal(r.urlFinal, 'http://empresa.com.br/');
    assert.equal(r.cnpjs.length, 3);
    assert.equal(r.avisos.length, 1);
  });

  test('site inacessível → acessivel=false', async () => {
    fetchSim = simularFetch([[/./, { status: 404 }]]);
    const r = await inspecionarSite('empresa.com.br');
    assert.equal(r.acessivel, false);
    assert.equal(r.avisos.length, 2);
  });
});
