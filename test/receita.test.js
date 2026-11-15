// Conector + ingestão da Receita, 100% offline: ZIPs sintéticos em Latin-1 e PGlite.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import * as receita from '../src/conectores/receita.js';
import { ingerirReceita } from '../src/servicos/receita-ingestao.js';
import { criarRepositorio } from '../src/db/repositorio.js';
import { bancoMigrado, gerarCnpj, ORG_A } from './db/ajuda-db.js';

const q = (campos) => campos.map((c) => `"${c}"`).join(';');
const latin1Zip = (nomeInterno, linhas) =>
  zipSync({ [nomeInterno]: new Uint8Array(Buffer.from(`${linhas.join('\n')}\n`, 'latin1')) });

/** Linha de Estabelecimentos no layout real (30 campos). */
function estab({ cnpj, matriz = '1', situacao = '02', uf = 'MS', municipio = '9051', fantasia = '', email = '', ddd = '67', tel = '33215555', cep = '79002000' }) {
  const c = Array(30).fill('');
  [c[0], c[1], c[2]] = [cnpj.slice(0, 8), cnpj.slice(8, 12), cnpj.slice(12)];
  c[3] = matriz; c[4] = fantasia; c[5] = situacao; c[6] = '20200101'; c[7] = '00'; c[10] = '20150310';
  c[11] = '4930202'; c[12] = '4930201,5211799'; c[13] = 'RUA'; c[14] = 'DOM AQUINO'; c[15] = '1200';
  c[16] = 'SALA  3'; c[17] = 'CENTRO'; c[18] = cep; c[19] = uf; c[20] = municipio; c[21] = ddd; c[22] = tel; c[27] = email;
  return q(c);
}
const empresa = ({ cnpj, razao = 'TRANSPORTES PANTANAL LTDA', natureza = '2062', porte = '03', capital = '150000,00' }) =>
  q([cnpj.slice(0, 8), razao, natureza, '49', capital, porte, '']);

const IBGE_MS = [
  { id: 5002704, nome: 'Campo Grande' },
  { id: 5006606, nome: 'Ponta Porã' },
  { id: 5003702, nome: 'Dourados' },
];
const MUNICIPIOS = [q(['9051', 'CAMPO GRANDE']), q(['9141', 'PONTA PORA']), q(['9073', 'DOURADOS']), q(['7107', 'SAO PAULO'])];

describe('conector receita — unidades', () => {
  test('separarCampos e layoutConfere', () => {
    const c = receita.separarCampos(`${estab({ cnpj: gerarCnpj('123456780001') })}\r`);
    assert.equal(c.length, 30);
    assert.equal(receita.layoutConfere(c, 'estab'), true);
    assert.equal(receita.layoutConfere(c.slice(1), 'estab'), false);
    assert.equal(receita.separarCampos('sem aspas;x'), null);
    assert.equal(receita.layoutConfere(receita.separarCampos(empresa({ cnpj: gerarCnpj('123456780001') })), 'empresa'), true);
  });

  test('interpretarPropfind lê pastas, tamanhos e datas', () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/public.php/webdav/Dados/Cadastros/CNPJ/2026-10/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
      <d:response><d:href>/public.php/webdav/Dados/Cadastros/CNPJ/2026-10/Empresas0.zip</d:href><d:propstat><d:prop><d:getlastmodified>Tue, 13 Oct 2026 22:08:04 GMT</d:getlastmodified><d:getcontentlength>570972127</d:getcontentlength><d:resourcetype/></d:prop></d:propstat></d:response>
      <d:response><d:href>/public.php/webdav/Dados/Cadastros/CNPJ/2026-10/Socios0.zip</d:href><d:propstat><d:prop><d:getcontentlength>10</d:getcontentlength><d:resourcetype/></d:prop></d:propstat></d:response>
    </d:multistatus>`;
    const itens = receita.interpretarPropfind(xml, 'Dados/Cadastros/CNPJ/2026-10');
    assert.deepEqual(itens.map((i) => i.nome), ['Empresas0.zip', 'Socios0.zip']);
    assert.equal(itens[0].bytes, 570972127);
    assert.equal(itens[0].modificadoEm, '2026-10-13T22:08:04.000Z');
  });

  test('mapearMunicipios casa nomes sem acento (TOM → IBGE)', () => {
    const m = receita.mapearMunicipios(new Map([['9141', 'PONTA PORA'], ['9051', 'CAMPO GRANDE'], ['7107', 'SAO PAULO']]), IBGE_MS);
    assert.deepEqual(m.get('9141'), { codigo_ibge: '5006606', nome: 'Ponta Porã' });
    assert.equal(m.has('7107'), false);
  });

  test('lerZipCsv decodifica Latin-1 e conta malformadas', async () => {
    const zip = latin1Zip('X.ESTABELE', [q(['1', 'AÇÚCAR E ÁLCOOL']), 'linha quebrada', q(['2', 'Ñ'])]);
    const lidas = [];
    const r = await receita.lerZipCsv(zip, (c) => lidas.push(c));
    assert.deepEqual(lidas, [['1', 'AÇÚCAR E ÁLCOOL'], ['2', 'Ñ']]);
    assert.equal(r.malformadas, 1);
    assert.deepEqual(r.internos, ['X.ESTABELE']);
  });

  describe('montarEmpresa', () => {
    const mun = receita.mapearMunicipios(new Map([['9051', 'CAMPO GRANDE']]), IBGE_MS);
    const cnpj = gerarCnpj('445566770001');
    const est = (o = {}) => receita.compactarEstab(receita.separarCampos(estab({ cnpj, ...o })));
    const emp = (o = {}) => receita.compactarEmpresa(receita.separarCampos(empresa({ cnpj, ...o })));

    test('EPP Ltda em Campo Grande vira linha completa com origem rfb_lote', () => {
      const r = receita.montarEmpresa(est({ email: 'Comercial@Pantanal.com.br' }), emp(), mun, { consultadoEm: '2026-10-13T22:08:04.000Z' });
      assert.equal(r.aceita, true);
      const e = r.empresa;
      assert.equal(e.cnpj, cnpj);
      assert.equal(e.porte, 'EPP');
      assert.equal(e.codigo_ibge, '5002704');
      assert.equal(e.municipio, 'Campo Grande');
      assert.equal(e.telefone_e164, '+556733215555');
      assert.equal(e.telefone_origem, 'rfb_lote');
      assert.equal(e.email, 'comercial@pantanal.com.br');
      assert.equal(e.data_abertura, '2015-03-10');
      assert.equal(e.capital_social, 150000);
      assert.deepEqual(e.cnaes_secundarios, ['4930201', '5211799']);
      assert.equal(e.logradouro, 'RUA DOM AQUINO');
      assert.equal(e.complemento, 'SALA 3');
    });

    test('e-mail de provedor gratuito é gravado como cadastrado na Receita (com aviso no relatório)', () => {
      const r = receita.montarEmpresa(est({ email: 'Joao.Silva@Gmail.com' }), emp(), mun);
      assert.equal(r.empresa.email, 'joao.silva@gmail.com');
      assert.equal(r.empresa.email_origem, 'rfb_lote');
      assert.deepEqual(r.avisos, ['email_provedor_gratuito']);
    });

    test('e-mail só é gravado para PJ EPP/DEMAIS (MEI/EI nem chegam a virar linha)', () => {
      const r = receita.montarEmpresa(est({ email: 'x@gmail.com' }), emp({ natureza: '2135' }), mun);
      assert.equal(r.aceita, false);
    });

    test('descartes de escopo e LGPD', () => {
      assert.equal(receita.montarEmpresa(est(), emp({ porte: '01' }), mun).motivo, 'porte_ME');
      assert.equal(receita.montarEmpresa(est(), emp({ porte: '00' }), mun).motivo, 'porte_NAO_INFORMADO');
      assert.equal(receita.montarEmpresa(est(), emp({ natureza: '2135' }), mun).motivo, 'empresario_individual');
      assert.equal(receita.montarEmpresa(est(), emp({ natureza: '3999' }), mun).motivo, 'natureza_nao_empresarial');
      assert.equal(receita.montarEmpresa(est(), emp({ razao: 'JOAO DA SILVA 12345678900' }), mun).motivo, 'razao_social_com_cpf');
      assert.equal(receita.montarEmpresa(est({ municipio: '0001' }), emp(), mun).motivo, 'municipio_nao_mapeado');
      assert.equal(receita.montarEmpresa(est(), undefined, mun).motivo, 'sem_empresa');
    });

    test('nome fantasia com CPF é descartado, a empresa não', () => {
      const r = receita.montarEmpresa(est({ fantasia: 'MARIA 123.456.789-00' }), emp(), mun);
      assert.equal(r.aceita, true);
      assert.equal(r.empresa.nome_fantasia, null);
    });
  });
});

describe('ingestão receita (ponta a ponta, offline)', () => {
  let db, repo, dir;
  const C = {
    ok1: gerarCnpj('100000010001'),       // MS, ativa, matriz, EPP → entra
    ok2: gerarCnpj('100000020001'),       // MS, ativa, matriz, DEMAIS → entra
    filial: gerarCnpj('100000030002'),    // filial → fora
    baixada: gerarCnpj('100000040001'),   // situação 08 → fora
    sp: gerarCnpj('100000050001'),        // UF SP → fora
    me: gerarCnpj('100000060001'),        // porte ME → fora
    ei: gerarCnpj('100000070001'),        // empresário individual → fora
    cpf: gerarCnpj('100000080001'),       // razão com CPF → fora
  };
  const arquivos = {
    'Municipios.zip': latin1Zip('F.MUNICCSV', MUNICIPIOS),
    'Estabelecimentos0.zip': latin1Zip('K.ESTABELE', [
      estab({ cnpj: C.ok1, email: 'contato@pantanal.com.br' }),
      estab({ cnpj: C.filial, matriz: '2' }),
      estab({ cnpj: C.baixada, situacao: '08' }),
      estab({ cnpj: C.sp, uf: 'SP', municipio: '7107' }),
    ]),
    'Estabelecimentos1.zip': latin1Zip('K.ESTABELE', [
      estab({ cnpj: C.ok2, municipio: '9141', email: 'socio@hotmail.com' }),
      estab({ cnpj: C.me }), estab({ cnpj: C.ei }), estab({ cnpj: C.cpf }),
    ]),
    'Empresas0.zip': latin1Zip('K.EMPRECSV', [
      empresa({ cnpj: C.ok1 }), empresa({ cnpj: C.me, porte: '01' }), empresa({ cnpj: C.sp }),
    ]),
    'Empresas1.zip': latin1Zip('K.EMPRECSV', [
      empresa({ cnpj: C.ok2, porte: '05', razao: 'FRIGORIFICO FRONTEIRA S/A', natureza: '2054' }),
      empresa({ cnpj: C.ei, natureza: '2135' }), empresa({ cnpj: C.cpf, razao: 'FULANO 12345678900' }),
      empresa({ cnpj: C.filial }), empresa({ cnpj: C.baixada }),
    ]),
  };
  const baixados = [];
  const fonte = {
    async listarArquivosDoMes(mes) {
      const item = (nome) => ({ nome, bytes: arquivos[nome].length, modificadoEm: '2026-10-13T22:08:04.000Z' });
      return {
        mes,
        estabelecimentos: [item('Estabelecimentos0.zip'), item('Estabelecimentos1.zip')],
        empresas: [item('Empresas0.zip'), item('Empresas1.zip')],
        municipios: item('Municipios.zip'),
      };
    },
    async baixarArquivo({ arquivo, dir: d }) {
      baixados.push(arquivo.nome);
      const destino = path.join(d, arquivo.nome);
      writeFileSync(destino, arquivos[arquivo.nome]);
      return destino;
    },
  };

  before(async () => {
    db = await bancoMigrado();
    repo = criarRepositorio(db, { organizationId: ORG_A });
    dir = mkdtempSync(path.join(tmpdir(), 'receita-'));
  });
  after(async () => { await db.fechar(); rmSync(dir, { recursive: true, force: true }); });

  test('simulação conta tudo e não grava nada', async () => {
    const r = await ingerirReceita({ mes: '2026-10', dir, simular: true, fonte, municipiosIbge: IBGE_MS });
    assert.equal(r.estabelecimentos.linhas, 8);
    assert.equal(r.estabelecimentos.uf, 7);
    assert.equal(r.estabelecimentos.uf_ativas, 6);
    assert.equal(r.estabelecimentos.uf_ativas_matriz, 5);
    assert.equal(r.empresas.casadas, 5);
    assert.equal(r.juncao.aptas, 2);
    assert.deepEqual(r.juncao.descartes, { porte_ME: 1, empresario_individual: 1, razao_social_com_cpf: 1 });
    assert.deepEqual(r.juncao.por_porte, { EPP: 1, DEMAIS: 1 });
    assert.equal(r.juncao.com_email, 2);
    assert.deepEqual(r.juncao.avisos, { email_provedor_gratuito: 1 });
    assert.equal(r.execucao_id, null);
    assert.deepEqual(await repo.listarEmpresas(), []);
    assert.ok(existsSync(path.join(dir, 'Estabelecimentos0.zip.ok')));
  });

  test('retomada: arquivos já processados não são baixados de novo; gravação usa o repositório', async () => {
    baixados.length = 0;
    const r = await ingerirReceita({ mes: '2026-10', dir, simular: false, repo, fonte, municipiosIbge: IBGE_MS });
    assert.deepEqual(baixados, ['Municipios.zip']);
    assert.equal(r.juncao.gravadas, 2);
    const e = await repo.buscarPorCnpj(C.ok2);
    assert.equal(e.porte, 'DEMAIS');
    assert.equal(e.municipio, 'Ponta Porã');
    assert.equal(e.cnpj_origem, 'rfb_lote');
    assert.equal(e.email, 'socio@hotmail.com');
    assert.equal(e.email_origem, 'rfb_lote');
    assert.equal(e.consultado_em, '2026-10-13T22:08:04.000Z');
    const exec = await repo.ultimaExecucao('receita');
    assert.equal(exec.status, 'concluida');
    assert.equal(exec.contadores.gravadas, 2);
  });

  test('layout divergente aborta antes de gravar', async () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), 'receita-'));
    const ruim = { ...arquivos, 'Estabelecimentos0.zip': latin1Zip('K.ESTABELE', [q(['so', 'tres', 'campos'])]) };
    const fonteRuim = { ...fonte, baixarArquivo: async ({ arquivo, dir: d }) => { const p = path.join(d, arquivo.nome); writeFileSync(p, ruim[arquivo.nome]); return p; } };
    try {
      await assert.rejects(
        ingerirReceita({ mes: '2026-10', dir: dir2, simular: true, fonte: fonteRuim, municipiosIbge: IBGE_MS }),
        /layout divergente/
      );
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe('trava da pasta de ingestão', () => {
  test('bloqueia se outro processo vivo detém a trava; assume trava de processo morto', async () => {
    const { travarPasta } = await import('../src/servicos/receita-ingestao.js');
    const d = mkdtempSync(path.join(tmpdir(), 'trava-'));
    try {
      writeFileSync(path.join(d, '.trava'), String(process.ppid)); // processo pai: vivo
      assert.throws(() => travarPasta(d), /outra ingestão \(PID/);
      writeFileSync(path.join(d, '.trava'), '999999'); // PID inexistente: trava órfã
      const liberar = travarPasta(d);
      assert.ok(existsSync(path.join(d, '.trava')));
      liberar();
      assert.equal(existsSync(path.join(d, '.trava')), false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
