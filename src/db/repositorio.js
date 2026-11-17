// Repositório: única porta de leitura/escrita do schema `prospeccao`.
// Cada operação roda numa transação com SET LOCAL ROLE prospeccao_app + app.organization_id,
// de modo que o RLS do banco (e não só este código) garante o isolamento entre organizações.
import {
  EmpresaEntrada, ContratoPncpEntrada, SinalEntrada, MoverFunilEntrada, BloqueioEntrada, FiltroEmpresas,
  OrganizationId, ExecucaoInicio, ExecucaoAtualizacao, cnpj as CnpjSchema, paraE164,
} from './esquemas.js';

const TAMANHO_LOTE = 500;

const COLUNAS = [
  'cnpj', 'cnpj_origem', 'fonte_descoberta', 'razao_social', 'nome_fantasia', 'matriz_filial', 'situacao',
  'data_abertura', 'porte', 'natureza_juridica_codigo', 'mei', 'capital_social', 'cnae_principal', 'cnaes_secundarios',
  'logradouro', 'numero', 'complemento', 'bairro', 'cep', 'municipio', 'uf', 'codigo_ibge',
  'lat', 'lon', 'geo_precisao', 'geo_fonte', 'telefone_e164', 'telefone_origem', 'email', 'email_origem',
  'dominio', 'dominio_origem', 'etapa_funil', 'consultado_em',
];
// No upsert, coordenada e domínio antigos são preservados se a nova consulta não os trouxer;
// a etapa do funil só muda via moverFunil().
const PRESERVAR_SE_NULO = { lat: 'lat', lon: 'lat', geo_precisao: 'lat', geo_fonte: 'lat', dominio: 'dominio', dominio_origem: 'dominio' };

const SELECT_EMPRESA = `
  SELECT e.*,
         EXISTS (SELECT 1 FROM prospeccao.nao_contatar n WHERE n.telefone_e164 = e.telefone_e164) AS telefone_bloqueado
    FROM prospeccao.empresas e
   WHERE NOT EXISTS (SELECT 1 FROM prospeccao.nao_contatar n WHERE n.cnpj = e.cnpj)`;

const num = (v) => (v == null ? null : Number(v));
const iso = (v) => (v == null ? null : new Date(v).toISOString());

/** Linha do banco → objeto de saída (telefone bloqueado depois da gravação nunca é devolvido). */
function mapearEmpresa(r) {
  const bloq = r.telefone_bloqueado === true;
  const { telefone_bloqueado, ...e } = r;
  return {
    ...e,
    capital_social: num(e.capital_social),
    lat: num(e.lat),
    lon: num(e.lon),
    telefone_e164: bloq ? null : e.telefone_e164,
    telefone_origem: bloq ? 'BLOQUEADO_LGPD' : e.telefone_origem,
    geo_enriquecido_em: iso(e.geo_enriquecido_em),
    site_enriquecido_em: iso(e.site_enriquecido_em),
    consultado_em: iso(e.consultado_em),
    criado_em: iso(e.criado_em),
    atualizado_em: iso(e.atualizado_em),
  };
}

// ───────────────────── Conversão da saída da Etapa 1 ─────────────────────

const ORIGEM_POR_FONTE = { brasilapi: 'brasilapi', cnpjws: 'cnpjws', 'brasilapi+cnpjws': 'brasilapi' };
const so = (re) => (v) => (v != null && re.test(String(v)) ? String(v) : null);
const cnae7 = (c) => (c?.codigo && /^\d{7}$/.test(c.codigo) && c.codigo !== '0000000' ? c.codigo : null);

/**
 * Converte o resultado de consultarCnpj() (ferramenta `consultar_cnpj_real`) numa linha de `empresas`.
 * Decisão C: MEI, Empresário Individual, natureza não empresarial e porte fora de EPP/DEMAIS são descartados.
 * @returns {{ aceita: true, empresa: object } | { aceita: false, motivo: string }}
 */
export function empresaDeConsulta(r, { fonte_descoberta = 'mcp_consulta' } = {}) {
  if (!r || r.encontrado === false) return { aceita: false, motivo: 'cnpj_nao_encontrado' };
  const natureza = r.naturezaJuridica?.codigo ? String(r.naturezaJuridica.codigo).replace(/\D/g, '') : null;
  if (r.mei === true) return { aceita: false, motivo: 'descartada_mei' };
  if (natureza === '2135') return { aceita: false, motivo: 'descartada_empresario_individual' };
  if (!natureza || !/^2\d{3}$/.test(natureza)) return { aceita: false, motivo: 'descartada_natureza_nao_empresarial' };
  if (r.porte !== 'EPP' && r.porte !== 'DEMAIS') return { aceita: false, motivo: 'descartada_porte' };

  const origemContato = ORIGEM_POR_FONTE[r.fonte] ?? 'NAO_VERIFICADO';
  const telefone = paraE164(r.telefone);
  const email = r.email ? String(r.email).toLowerCase() : null;
  const end = r.endereco ?? {};
  const matriz = String(r.matrizFilial ?? '').toUpperCase();

  return {
    aceita: true,
    empresa: {
      cnpj: r.cnpj,
      cnpj_origem: ['brasilapi', 'cnpjws', 'brasilapi+cnpjws'].includes(r.fonte) ? r.fonte : 'manual',
      fonte_descoberta,
      razao_social: r.razaoSocial,
      nome_fantasia: r.nomeFantasia || null,
      matriz_filial: matriz === 'MATRIZ' || matriz === 'FILIAL' ? matriz : null,
      situacao: r.situacao || null,
      data_abertura: so(/^\d{4}-\d{2}-\d{2}$/)(r.dataAbertura),
      porte: r.porte,
      natureza_juridica_codigo: natureza,
      mei: false,
      capital_social: r.capitalSocial ?? null,
      cnae_principal: cnae7(r.cnaePrincipal),
      cnaes_secundarios: (r.cnaesSecundarios ?? []).map(cnae7).filter(Boolean),
      logradouro: end.logradouro || null,
      numero: end.numero || null,
      complemento: end.complemento || null,
      bairro: end.bairro || null,
      cep: so(/^\d{8}$/)(String(end.cep ?? '').replace(/\D/g, '')),
      municipio: end.municipio || null,
      uf: so(/^[A-Z]{2}$/)(end.uf),
      codigo_ibge: so(/^\d{7}$/)(end.codigoIbge),
      telefone_e164: origemContato !== 'NAO_VERIFICADO' ? telefone : null,
      telefone_origem: telefone && origemContato !== 'NAO_VERIFICADO' ? origemContato : 'NAO_VERIFICADO',
      email: origemContato !== 'NAO_VERIFICADO' ? email : null,
      email_origem: email && origemContato !== 'NAO_VERIFICADO' ? origemContato : 'NAO_VERIFICADO',
      consultado_em: r.consultadoEm ?? null,
    },
  };
}

// ───────────────────────── Repositório ─────────────────────────

/**
 * @param {Awaited<ReturnType<import('./conexao.js').criarConexao>>} conexao
 * @param {{ organizationId: string }} opcoes
 */
export function criarRepositorio(conexao, { organizationId }) {
  const org = OrganizationId.parse(organizationId);

  /** Transação no contexto da organização, como papel restrito. */
  const comOrg = (fn, { motivo, ator } = {}) =>
    conexao.transacao(async (tx) => {
      await tx.query(
        `SELECT set_config('app.organization_id', $1, true), set_config('app.funil_motivo', $2, true),
                set_config('app.funil_ator', $3, true)`,
        [org, motivo ?? '', ator ?? '']
      );
      await tx.exec('SET LOCAL ROLE prospeccao_app');
      return fn(tx);
    });

  async function idEmpresa(tx, cnpj, { aceitarBasico = false } = {}) {
    const { rows } = aceitarBasico
      ? await tx.query(
          `SELECT id FROM prospeccao.empresas WHERE cnpj = $1 OR cnpj_basico = substr($1, 1, 8) ORDER BY (cnpj = $1) DESC LIMIT 1`,
          [cnpj]
        )
      : await tx.query('SELECT id FROM prospeccao.empresas WHERE cnpj = $1', [cnpj]);
    if (!rows.length) throw new Error(`empresa ${cnpj} não cadastrada nesta organização`);
    return rows[0].id;
  }

  // dominio_confirmado só vale para o domínio em que foi confirmado: domínio novo volta a false.
  const SET_UPSERT = [
    ...COLUNAS.filter((c) => c !== 'cnpj' && c !== 'etapa_funil').map((c) =>
      PRESERVAR_SE_NULO[c]
        ? `${c} = CASE WHEN EXCLUDED.${PRESERVAR_SE_NULO[c]} IS NULL THEN empresas.${c} ELSE EXCLUDED.${c} END`
        : `${c} = EXCLUDED.${c}`
    ),
    `dominio_confirmado = CASE WHEN EXCLUDED.dominio IS NULL OR EXCLUDED.dominio = empresas.dominio
                               THEN empresas.dominio_confirmado ELSE false END`,
  ].join(', ');
  const SQL_UPSERT = `INSERT INTO prospeccao.empresas (organization_id, ${COLUNAS.join(', ')})
     VALUES ($1, ${COLUNAS.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (organization_id, cnpj) DO UPDATE SET ${SET_UPSERT}
     RETURNING *, false AS telefone_bloqueado`;
  const upsert = async (tx, e) => (await tx.query(SQL_UPSERT, [org, ...COLUNAS.map((c) => e[c])])).rows[0];
  const upsertLote = async (tx, lote) => {
    const nCols = COLUNAS.length;
    const params = [org];
    const tuplas = lote.map((e, idx) => {
      const base = idx * nCols + 2;
      for (const c of COLUNAS) params.push(e[c]);
      return `($1, ${COLUNAS.map((_, j) => `$${base + j}`).join(', ')})`;
    });
    const sql = `INSERT INTO prospeccao.empresas (organization_id, ${COLUNAS.join(', ')})
       VALUES ${tuplas.join(', ')}
       ON CONFLICT (organization_id, cnpj) DO UPDATE SET ${SET_UPSERT}`;
    await tx.query(sql, params);
  };

  return {
    organizationId: org,

    /** Insere ou atualiza por (organização, CNPJ). Recusa CNPJ em nao_contatar. */
    async salvarEmpresa(dados) {
      const e = EmpresaEntrada.parse(dados);
      return comOrg(async (tx) => mapearEmpresa(await upsert(tx, e)));
    },

    /**
     * Versão em lote de salvarEmpresa (mesma validação e mesmo SQL), uma transação por lote de até 500.
     * Linhas inválidas (Zod) ou em nao_contatar ficam fora e são relatadas; se o lote falhar no banco,
     * ele é regravado linha a linha para isolar só a linha problemática.
     * @returns {Promise<{ gravadas: number, recusadas: Array<{ cnpj: string, motivo: string }> }>}
     */
    async salvarEmpresas(lista) {
      const recusadas = [];
      const validas = [];
      for (const dados of lista) {
        const r = EmpresaEntrada.safeParse(dados);
        if (r.success) validas.push(r.data);
        else recusadas.push({ cnpj: String(dados?.cnpj ?? ''), motivo: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      }
      const bloqueados = await this.cnpjsBloqueados(validas.map((e) => e.cnpj));
      // Um INSERT multi-linha não pode tocar o mesmo CNPJ duas vezes (ON CONFLICT … "cannot affect
      // row a second time"): fica a última ocorrência de cada CNPJ.
      const unicas = new Map();
      for (const e of validas) {
        if (bloqueados.has(e.cnpj)) recusadas.push({ cnpj: e.cnpj, motivo: 'nao_contatar' });
        else unicas.set(e.cnpj, e);
      }
      const aGravar = [...unicas.values()];

      let gravadas = 0;
      for (let i = 0; i < aGravar.length; i += TAMANHO_LOTE) {
        const lote = aGravar.slice(i, i + TAMANHO_LOTE);
        try {
          await comOrg((tx) => upsertLote(tx, lote));
          gravadas += lote.length;
        } catch {
          for (const e of lote) {
            try {
              await comOrg((tx) => upsert(tx, e));
              gravadas += 1;
            } catch (erro) {
              recusadas.push({ cnpj: e.cnpj, motivo: erro.message });
            }
          }
        }
      }
      return { gravadas, recusadas };
    },

    /** Subconjunto dos CNPJs informados que está em nao_contatar. */
    async cnpjsBloqueados(cnpjs) {
      if (!cnpjs.length) return new Set();
      return comOrg(async (tx) => {
        const { rows } = await tx.query('SELECT cnpj FROM prospeccao.nao_contatar WHERE cnpj = ANY($1::text[])', [cnpjs]);
        return new Set(rows.map((r) => r.cnpj));
      });
    },

    /** Abre o registro de uma rodada de ingestão/enriquecimento. Retorna o id. */
    async iniciarExecucao(dados) {
      const e = ExecucaoInicio.parse(dados);
      return comOrg(async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO prospeccao.ingestao_execucoes (organization_id, tipo, parametros) VALUES ($1, $2, $3) RETURNING id`,
          [org, e.tipo, JSON.stringify(e.parametros)]
        );
        return rows[0].id;
      });
    },

    /** Atualiza checkpoint/contadores; status final grava finalizado_em. */
    async atualizarExecucao(id, dados) {
      const a = ExecucaoAtualizacao.parse(dados);
      return comOrg(async (tx) => {
        const { rows } = await tx.query(
          `UPDATE prospeccao.ingestao_execucoes SET
             status = coalesce($2, status),
             checkpoint = CASE WHEN $3::boolean THEN $4::jsonb ELSE checkpoint END,
             contadores = coalesce($5::jsonb, contadores),
             erro = CASE WHEN $6::boolean THEN $7 ELSE erro END,
             atualizado_em = now(),
             finalizado_em = CASE WHEN coalesce($2, status) = 'em_andamento' THEN NULL ELSE coalesce(finalizado_em, now()) END
           WHERE id = $1 RETURNING id, tipo, status, checkpoint, contadores, erro`,
          [id, a.status ?? null, a.checkpoint !== undefined, JSON.stringify(a.checkpoint ?? null),
            a.contadores ? JSON.stringify(a.contadores) : null, a.erro !== undefined, a.erro ?? null]
        );
        if (!rows.length) throw new Error(`execução ${id} não encontrada nesta organização`);
        return rows[0];
      });
    },

    /** Última execução de um tipo (para retomar pelo checkpoint). */
    async ultimaExecucao(tipo) {
      return comOrg(async (tx) => {
        const { rows } = await tx.query(
          `SELECT id, tipo, status, parametros, checkpoint, contadores, erro, iniciado_em, finalizado_em
             FROM prospeccao.ingestao_execucoes WHERE tipo = $1 ORDER BY iniciado_em DESC LIMIT 1`,
          [tipo]
        );
        return rows[0] ?? null;
      });
    },

    /** Grava o resultado de `consultar_cnpj_real`. Retorna { importada, motivo?, empresa? }. */
    async importarConsulta(resultado, opcoes) {
      const conv = empresaDeConsulta(resultado, opcoes);
      if (!conv.aceita) return { importada: false, motivo: conv.motivo };
      return { importada: true, empresa: await this.salvarEmpresa(conv.empresa) };
    },

    async buscarPorCnpj(cnpj) {
      const c = CnpjSchema.parse(cnpj);
      return comOrg(async (tx) => {
        const { rows } = await tx.query(`${SELECT_EMPRESA} AND e.cnpj = $1`, [c]);
        if (!rows.length) return null;
        const empresa = mapearEmpresa(rows[0]);
        const sinais = await tx.query(
          `SELECT tipo, nome, erp_fonte, status, evidencia, url_evidencia, coletado_em
             FROM prospeccao.empresa_sinais_erp WHERE empresa_id = $1 ORDER BY tipo, nome`,
          [empresa.id]
        );
        const contratos = await tx.query(
          'SELECT count(*)::int AS n FROM prospeccao.empresa_contratos_pncp WHERE empresa_id = $1',
          [empresa.id]
        );
        return {
          ...empresa,
          sinais: sinais.rows.map((s) => ({ ...s, coletado_em: iso(s.coletado_em) })),
          // Indício de porte vem só de sinal de RH com evidência — nunca de contagem inventada.
          indicio_medio_grande: sinais.rows.some((s) => s.tipo === 'rh' && s.status === 'CONFIRMADO'),
          contratos_pncp: contratos.rows[0].n,
        };
      });
    },

    async listarEmpresas(filtro = {}) {
      const f = FiltroEmpresas.parse(filtro);
      const cond = [];
      const params = [];
      const add = (sql, v) => { params.push(v); cond.push(sql.replace('?', `$${params.length}`)); };
      if (f.codigo_ibge) add('e.codigo_ibge = ?', f.codigo_ibge);
      if (f.uf) add('e.uf = ?', f.uf);
      if (f.cnae) {
        params.push(f.cnae);
        cond.push(`(e.cnae_principal = $${params.length} OR $${params.length} = ANY(e.cnaes_secundarios))`);
      }
      if (f.etapa) add('e.etapa_funil = ?', f.etapa);
      params.push(f.limite);
      const sql = `${SELECT_EMPRESA} ${cond.map((c) => `AND ${c}`).join(' ')} ORDER BY e.razao_social LIMIT $${params.length}`;
      return comOrg(async (tx) => (await tx.query(sql, params)).rows.map(mapearEmpresa));
    },

    async registrarContratoPncp(dados) {
      const c = ContratoPncpEntrada.parse(dados);
      return comOrg(async (tx) => {
        const empresaId = await idEmpresa(tx, c.cnpj_fornecedor, { aceitarBasico: true });
        const { rows } = await tx.query(
          `INSERT INTO prospeccao.empresa_contratos_pncp
             (organization_id, empresa_id, numero_controle_pncp, cnpj_fornecedor, orgao_cnpj, orgao_nome, objeto,
              valor_global, data_assinatura, data_vigencia_fim, url_fonte)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (organization_id, numero_controle_pncp) DO UPDATE SET
             orgao_cnpj = EXCLUDED.orgao_cnpj, orgao_nome = EXCLUDED.orgao_nome, objeto = EXCLUDED.objeto,
             valor_global = EXCLUDED.valor_global, data_assinatura = EXCLUDED.data_assinatura,
             data_vigencia_fim = EXCLUDED.data_vigencia_fim, url_fonte = EXCLUDED.url_fonte, coletado_em = now()
           RETURNING *`,
          [org, empresaId, c.numero_controle_pncp, c.cnpj_fornecedor, c.orgao_cnpj, c.orgao_nome, c.objeto,
            c.valor_global, c.data_assinatura, c.data_vigencia_fim, c.url_fonte]
        );
        return { ...rows[0], valor_global: num(rows[0].valor_global), coletado_em: iso(rows[0].coletado_em) };
      });
    },

    /** Conjunto de todas as raízes cnpj_basico (8 chars) cadastradas e não bloqueadas nesta organização. */
    async cnpjsBasicosCadastrados() {
      return comOrg(async (tx) => {
        const { rows } = await tx.query(
          `SELECT DISTINCT e.cnpj_basico
             FROM prospeccao.empresas e
            WHERE NOT EXISTS (SELECT 1 FROM prospeccao.nao_contatar n WHERE n.cnpj = e.cnpj)`
        );
        return new Set(rows.map((r) => r.cnpj_basico));
      });
    },

    /**
     * Grava contratos PNCP em lote (casando fornecedor pelo CNPJ ou pela raiz cnpj_basico da matriz).
     * @returns {Promise<{ gravados: number, recusados: Array<{ numero_controle_pncp: string, motivo: string }> }>}
     */
    async registrarContratosPncp(lista) {
      const recusados = [];
      let gravados = 0;
      for (const item of lista) {
        const r = ContratoPncpEntrada.safeParse(item);
        if (!r.success) {
          recusados.push({
            numero_controle_pncp: String(item?.numero_controle_pncp ?? ''),
            motivo: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          });
          continue;
        }
        try {
          await this.registrarContratoPncp(r.data);
          gravados += 1;
        } catch (erro) {
          recusados.push({ numero_controle_pncp: r.data.numero_controle_pncp, motivo: erro.message });
        }
      }
      return { gravados, recusados };
    },

    /**
     * Lista empresas com enriquecimento pendente (geo e/ou site).
     * @param {{ tipo?: 'geo' | 'site' | 'ambos', codigo_ibge?: string, cnae?: string, porte?: 'EPP' | 'DEMAIS', limite?: number }} [opcoes]
     */
    async listarPendentesEnriquecimento({ tipo = 'ambos', codigo_ibge, cnae, porte, limite = 100 } = {}) {
      const cond = [];
      const params = [];
      const add = (sql, v) => { params.push(v); cond.push(sql.replace('?', `$${params.length}`)); };
      if (tipo === 'geo') cond.push('e.geo_enriquecido_em IS NULL');
      else if (tipo === 'site') cond.push('e.site_enriquecido_em IS NULL');
      else cond.push('(e.geo_enriquecido_em IS NULL OR e.site_enriquecido_em IS NULL)');
      if (codigo_ibge) add('e.codigo_ibge = ?', codigo_ibge);
      if (porte) add('e.porte = ?', porte);
      if (cnae) {
        params.push(cnae);
        cond.push(`(e.cnae_principal = $${params.length} OR $${params.length} = ANY(e.cnaes_secundarios))`);
      }
      params.push(Math.min(Math.max(1, Number(limite) || 100), 1000));
      const sql = `${SELECT_EMPRESA} AND ${cond.join(' AND ')}
                   ORDER BY (e.porte = 'DEMAIS') DESC, e.capital_social DESC NULLS LAST, e.cnpj
                   LIMIT $${params.length}`;
      return comOrg(async (tx) => (await tx.query(sql, params)).rows.map(mapearEmpresa));
    },

    /**
     * Registra o resultado da geocodificação e carimba geo_enriquecido_em (mesmo quando não encontrou ponto).
     */
    async registrarEnriquecimentoGeo(cnpj, { lat = null, lon = null, geo_precisao = 'NAO_VERIFICADO', geo_fonte = null } = {}) {
      const c = CnpjSchema.parse(cnpj);
      const temGeo = lat != null && lon != null && geo_fonte && geo_precisao !== 'NAO_VERIFICADO';
      return comOrg(async (tx) => {
        const { rows } = await tx.query(
          `UPDATE prospeccao.empresas SET
             lat = CASE WHEN $2::boolean THEN $3::double precision ELSE lat END,
             lon = CASE WHEN $2::boolean THEN $4::double precision ELSE lon END,
             geo_precisao = CASE WHEN $2::boolean THEN $5 ELSE geo_precisao END,
             geo_fonte = CASE WHEN $2::boolean THEN $6 ELSE geo_fonte END,
             geo_enriquecido_em = now(),
             atualizado_em = now()
           WHERE cnpj = $1
           RETURNING *, false AS telefone_bloqueado`,
          [c, Boolean(temGeo), temGeo ? Number(lat) : null, temGeo ? Number(lon) : null, temGeo ? geo_precisao : 'NAO_VERIFICADO', temGeo ? geo_fonte : null]
        );
        if (!rows.length) throw new Error(`empresa ${c} não cadastrada nesta organização`);
        return mapearEmpresa(rows[0]);
      });
    },

    /**
     * Registra o resultado do radar de site (domínio, confirmação, site_status e sinais de ERP/RH).
     * Sinais só são gravados quando o domínio foi confirmado pelo CNPJ no site ou informado manualmente.
     */
    async registrarEnriquecimentoSite(
      cnpj,
      { dominio = null, dominio_origem = null, dominio_confirmado = false, site_status, radar = null } = {}
    ) {
      const c = CnpjSchema.parse(cnpj);
      const statusValidos = ['cnpj_confirmado', 'cnpj_nao_encontrado', 'inacessivel', 'sem_dominio', 'dominio_gratuito'];
      if (!statusValidos.includes(site_status)) throw new Error(`site_status inválido: "${site_status}"`);
      const dom = dominio ? String(dominio).trim().toLowerCase() : null;
      const orig = dom ? dominio_origem : null;
      const conf = Boolean(dom && dominio_confirmado);

      const empresa = await comOrg(async (tx) => {
        const { rows } = await tx.query(
          `UPDATE prospeccao.empresas SET
             dominio = COALESCE($2, dominio),
             dominio_origem = CASE WHEN $2 IS NOT NULL THEN $3 ELSE dominio_origem END,
             dominio_confirmado = CASE WHEN $2 IS NOT NULL THEN $4 ELSE dominio_confirmado END,
             site_status = $5,
             site_enriquecido_em = now(),
             atualizado_em = now()
           WHERE cnpj = $1
           RETURNING *, false AS telefone_bloqueado`,
          [c, dom, orig, conf, site_status]
        );
        if (!rows.length) throw new Error(`empresa ${c} não cadastrada nesta organização`);
        return mapearEmpresa(rows[0]);
      });

      let sinaisGravados = [];
      if (radar?.acessivel && (conf || orig === 'manual')) {
        sinaisGravados = await this.registrarSinaisSite(c, radar);
      }
      return { empresa, sinais: sinaisGravados };
    },

    async registrarSinal(dados) {
      const s = SinalEntrada.parse(dados);
      return comOrg(async (tx) => {
        const empresaId = await idEmpresa(tx, s.cnpj);
        const { rows } = await tx.query(
          `INSERT INTO prospeccao.empresa_sinais_erp
             (organization_id, empresa_id, tipo, nome, erp_fonte, status, evidencia, url_evidencia)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (organization_id, empresa_id, tipo, nome) DO UPDATE SET
             erp_fonte = EXCLUDED.erp_fonte, status = EXCLUDED.status, evidencia = EXCLUDED.evidencia,
             url_evidencia = EXCLUDED.url_evidencia, coletado_em = now()
           RETURNING tipo, nome, erp_fonte, status, evidencia, url_evidencia`,
          [org, empresaId, s.tipo, s.nome, s.erp_fonte, s.status, s.evidencia, s.url_evidencia]
        );
        return rows[0];
      });
    },

    /**
     * Grava os sinais do `inspecionar_site_erp`. Só entram sinais com trecho de evidência literal
     * (CONFIRMADO); o "trabalhe conosco" é sinal fraco e não é gravado como RH.
     */
    async registrarSinaisSite(cnpj, radar) {
      if (!radar?.acessivel) return [];
      const url = radar.urlFinal ?? null;
      const sinais = [
        ...(radar.erps ?? []).map((x) => ({ tipo: 'erp', ...x })),
        ...(radar.rh ?? []).map((x) => ({ tipo: 'rh', ...x })),
      ].filter((x) => x.evidencia && url);
      const gravados = [];
      for (const x of sinais) {
        gravados.push(await this.registrarSinal({
          cnpj, tipo: x.tipo, nome: x.nome, erp_fonte: 'site_radar_html', status: 'CONFIRMADO',
          evidencia: x.evidencia, url_evidencia: url,
        }));
      }
      return gravados;
    },

    async moverFunil(dados) {
      const m = MoverFunilEntrada.parse(dados);
      return comOrg(async (tx) => {
        const { rows } = await tx.query(
          `UPDATE prospeccao.empresas SET etapa_funil = $2 WHERE cnpj = $1 RETURNING id, cnpj, etapa_funil`,
          [m.cnpj, m.etapa]
        );
        if (!rows.length) throw new Error(`empresa ${m.cnpj} não cadastrada nesta organização`);
        return rows[0];
      }, { motivo: m.motivo, ator: m.ator });
    },

    async historico(cnpj) {
      const c = CnpjSchema.parse(cnpj);
      return comOrg(async (tx) => {
        const { rows } = await tx.query(
          `SELECT h.etapa_anterior, h.etapa, h.motivo, h.ator, h.ocorrido_em
             FROM prospeccao.funil_historico h JOIN prospeccao.empresas e ON e.id = h.empresa_id
            WHERE e.cnpj = $1 ORDER BY h.ocorrido_em, h.id`,
          [c]
        );
        return rows.map((r) => ({ ...r, ocorrido_em: iso(r.ocorrido_em) }));
      });
    },

    /**
     * Inclui CNPJ e/ou telefone na lista global `nao_contatar` (permanente) e saneia as linhas
     * desta organização na mesma transação. Nas demais organizações o bloqueio vale na leitura
     * e na próxima gravação (gatilho do banco).
     */
    async bloquearContato(dados) {
      const b = BloqueioEntrada.parse(dados);
      return comOrg(async (tx) => {
        // Uma linha por alvo: se o CNPJ já estava bloqueado, o telefone novo ainda entra (e vice-versa).
        for (const [cnpj, telefone] of [[b.cnpj, null], [null, b.telefone]]) {
          if (!cnpj && !telefone) continue;
          await tx.query(
            `INSERT INTO prospeccao.nao_contatar (cnpj, telefone_e164, motivo, origem_solicitacao, registrado_por_org)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
            [cnpj, telefone, b.motivo, b.origem_solicitacao, org]
          );
        }
        const { rowCount } = await tx.query(
          `UPDATE prospeccao.empresas SET atualizado_em = now()
            WHERE ($1::text IS NOT NULL AND cnpj = $1) OR ($2::text IS NOT NULL AND telefone_e164 = $2)`,
          [b.cnpj, b.telefone]
        );
        return { bloqueado: true, cnpj: b.cnpj, telefone_e164: b.telefone, empresas_saneadas: rowCount ?? 0 };
      }, { motivo: `nao_contatar: ${b.motivo}`, ator: 'sistema' });
    },

    async estaBloqueado({ cnpj, telefone } = {}) {
      const c = cnpj ? CnpjSchema.parse(cnpj) : null;
      const t = telefone ? paraE164(telefone) : null;
      return comOrg(async (tx) => {
        const { rows } = await tx.query(
          `SELECT EXISTS (SELECT 1 FROM prospeccao.nao_contatar WHERE cnpj = $1) AS cnpj,
                  EXISTS (SELECT 1 FROM prospeccao.nao_contatar WHERE telefone_e164 = $2) AS telefone`,
          [c, t]
        );
        const por = Object.entries(rows[0]).filter(([, v]) => v).map(([k]) => k);
        return { bloqueado: por.length > 0, por };
      });
    },
  };
}
