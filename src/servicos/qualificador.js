// Motor de Qualificação B2B & Playbook RevOps para ERP (Etapa 4).
// 100% determinístico e transparente: cada ponto do score, classificação de setor,
// alerta de qualidade (ex.: telefone de contador) e tese de abordagem tem justificativa explícita.

export const MACRO_SETORES = {
  agro: {
    id: 'agro',
    nome: 'Agronegócio, Bioenergia & Alimentos',
    cor: '#15803d',
    corSuave: 'rgba(21, 128, 61, 0.14)',
    dorPadrao:
      'Controle de safra/custo biológico, rastreabilidade de lotes, gestão de contratos futuros de commodities, crédito rural (LCDPR/Funrural) e integração balança-estoque-fiscal.',
    argumentoErp:
      'Unificar o apontamento agrícola/industrial ao backoffice contábil e fiscal em tempo real, eliminando planilhas paralelas no fechamento de safra e garantindo compliance automático de ICMS/exportação.',
  },
  industria: {
    id: 'industria',
    nome: 'Indústria, Celulose, Mineração & Energia',
    cor: '#d97706',
    corSuave: 'rgba(217, 119, 6, 0.14)',
    dorPadrao:
      'Apontamento de chão de fábrica (PCP/MRP), custeio por absorção de matéria-prima, manutenção de ativos industriais e Bloco K (SPED Fiscal).',
    argumentoErp:
      'Integrar engenharia de produto, planejamento de produção (MRP II) e custos industriais auditáveis, reduzindo perdas de insumo e paradas não planejadas.',
  },
  logistica: {
    id: 'logistica',
    nome: 'Logística, Transportadoras & Frotas',
    cor: '#2350c8',
    corSuave: 'rgba(35, 80, 200, 0.14)',
    dorPadrao:
      'Emissão massiva de CT-e/MDF-e, controle de custo por km rodado (combustível, pneus, manutenção preventiva de frota) e conciliação de fretes/pedágios.',
    argumentoErp:
      'Automatizar o faturamento logístico (CT-e/MDF-e) integrado à gestão de frotas e rentabilidade por rota/veículo, estancando vazamento de margem na operação.',
  },
  construcao: {
    id: 'construcao',
    nome: 'Construção Civil, Engenharia & Imobiliário',
    cor: '#be185d',
    corSuave: 'rgba(190, 24, 93, 0.14)',
    dorPadrao:
      'Orçamento vs. realizado por centro de custo/obra (BDI), medição de empreiteiros, compras descentralizadas em canteiro e gestão de SPEs/patrimônio de afetação.',
    argumentoErp:
      'Visão consolidada multi-CNPJ/SPE com trava orçamentária no pedido de compra da obra e conciliação física-financeira em tempo real.',
  },
  atacado: {
    id: 'atacado',
    nome: 'Atacado, Distribuição & Comércio B2B',
    cor: '#6d28d9',
    corSuave: 'rgba(109, 40, 217, 0.14)',
    dorPadrao:
      'Giro de estoque multi-filial, substituição tributária complexa (ICMS-ST/DIFAL em MS), política de comissionamento/descontos e ruptura de compras.',
    argumentoErp:
      'Motor fiscal parametrizado para incentivos e ICMS-ST de Mato Grosso do Sul, aliado a WMS e curva ABC preditiva para liberar caixa imobilizado em estoque.',
  },
  servicos: {
    id: 'servicos',
    nome: 'Holdings, Saúde & Serviços Corporativos',
    cor: '#0f766e',
    corSuave: 'rgba(15, 118, 110, 0.14)',
    dorPadrao:
      'Consolidação financeira multi-empresa (holdings/grupos familiares), rateio de centro de serviços compartilhados (CSC), faturamento recorrente e governança para auditoria.',
    argumentoErp:
      'Centralizar tesouraria, compras e contabilidade societária (DRE consolidada multi-empresa) com trilha de auditoria e alçadas eletrônicas de aprovação.',
  },
};

/** Classifica o CNAE principal (7 dígitos) num dos 6 macro-setores estratégicos de MS. */
export function classificarSetor(cnaePrincipal, razaoSocial = '') {
  const c = String(cnaePrincipal ?? '').replace(/\D/g, '');
  const div = Number(c.slice(0, 2));
  const r = String(razaoSocial ?? '').toUpperCase();

  if (c.length >= 2) {
    if ((div >= 1 && div <= 3) || (div >= 10 && div <= 12)) return MACRO_SETORES.agro;
    if (div === 19 || div === 20) {
      if (/USINA|BIOENERG|ETANOL|ALCOOL|ACUCAR|AGRO|FERTILIZ|ADUBO/.test(r)) return MACRO_SETORES.agro;
      return MACRO_SETORES.industria;
    }
    if ((div >= 5 && div <= 9) || (div >= 13 && div <= 18) || (div >= 21 && div <= 39)) return MACRO_SETORES.industria;
    if ((div >= 41 && div <= 43) || div === 68 || div === 71) return MACRO_SETORES.construcao;
    if (div === 45 || (div >= 49 && div <= 53)) return MACRO_SETORES.logistica;
    if (div === 46 || div === 47) {
      if (/AGRO|SEMENTE|DEFENSIV|INSUMO|VETERIN|GRAOS|CEREA/.test(r)) return MACRO_SETORES.agro;
      return MACRO_SETORES.atacado;
    }
  }
  if (/AGRO|FAZENDA|PECUARIA|SEMENTE|USINA|BIOENERG/.test(r)) return MACRO_SETORES.agro;
  if (/TRANSPORT|LOGISTICA|FROTA/.test(r)) return MACRO_SETORES.logistica;
  if (/CONSTRUT|ENGENHARIA|INCORPORA/.test(r)) return MACRO_SETORES.construcao;
  if (/INDUSTRIA|MINERACAO|CELULOSE|SIDERURG/.test(r)) return MACRO_SETORES.industria;
  return MACRO_SETORES.servicos;
}

/** Dicionário amigável dos CNAEs mais frequentes em MS. */
export const NOMES_CNAE = {
  '6911701': 'Serviços advocatícios',
  '6462000': 'Holdings de instituições não-financeiras',
  '0151201': 'Criação de bovinos para corte',
  '4930202': 'Transporte rodoviário de carga (intermunicipal/interestadual)',
  '4120400': 'Construção de edifícios',
  '4110700': 'Incorporação de empreendimentos imobiliários',
  '8630503': 'Atividade médica ambulatorial',
  '6810202': 'Aluguel de imóveis próprios',
  '4731800': 'Comércio varejista de combustíveis (postos)',
  '8211300': 'Serviços combinados de escritório e apoio administrativo',
  '7112000': 'Serviços de engenharia',
  '6810201': 'Compra e venda de imóveis próprios',
  '0115600': 'Cultivo de soja',
  '4781400': 'Comércio de artigos do vestuário',
  '5611201': 'Restaurantes e similares',
  '0111302': 'Cultivo de milho',
  '0113000': 'Cultivo de cana-de-açúcar',
  '1931400': 'Fabricação de álcool / biocombustíveis',
  '1011201': 'Frigorífico - abate de bovinos',
  '1710900': 'Fabricação de celulose e pastas para papel',
  '4623108': 'Comércio atacadista de matérias-primas agrícolas',
  '4683400': 'Comércio atacadista de defensivos agrícolas e adubos',
};

/** Coordenadas dos principais municípios de MS para plotagem de polos e fallback geográfico. */
export const COORDENADAS_MUNICIPIOS_MS = {
  'Campo Grande': { lat: -20.4697, lon: -54.6201 },
  Dourados: { lat: -22.2231, lon: -54.812 },
  'Três Lagoas': { lat: -20.7849, lon: -51.7007 },
  'Chapadão do Sul': { lat: -18.7905, lon: -52.6266 },
  'Ponta Porã': { lat: -22.5361, lon: -55.7256 },
  'Nova Andradina': { lat: -22.2381, lon: -53.3431 },
  Corumbá: { lat: -19.0092, lon: -57.6533 },
  Maracaju: { lat: -21.6144, lon: -55.1683 },
  'Ribas do Rio Pardo': { lat: -20.4431, lon: -53.7589 },
  Naviraí: { lat: -23.065, lon: -54.1906 },
  Sidrolândia: { lat: -20.9319, lon: -54.9614 },
  'São Gabriel do Oeste': { lat: -19.3953, lon: -54.5656 },
  Sonora: { lat: -17.5769, lon: -54.7578 },
  Paranaíba: { lat: -19.6772, lon: -51.1908 },
  'Rio Brilhante': { lat: -21.8019, lon: -54.5464 },
  Coxim: { lat: -18.5067, lon: -54.76 },
  Caarapó: { lat: -22.6342, lon: -54.8222 },
  Bonito: { lat: -21.1261, lon: -56.4836 },
  Aquidauana: { lat: -20.4711, lon: -55.7872 },
  Amambai: { lat: -23.1042, lon: -55.2258 },
   Aparecida: { lat: -20.1028, lon: -51.0939 },
  'Aparecida do Taboado': { lat: -20.0867, lon: -51.0936 },
  Ivinhema: { lat: -22.3047, lon: -53.8153 },
  'Costa Rica': { lat: -18.5439, lon: -53.1292 },
  Miranda: { lat: -20.2406, lon: -56.3783 },
  Jardim: { lat: -21.4803, lon: -56.1381 },
  'Água Clara': { lat: -20.4481, lon: -52.8781 },
  Cassilândia: { lat: -19.1133, lon: -51.7342 },
  Itaporã: { lat: -22.0789, lon: -54.7892 },
  Bataguassu: { lat: -21.7142, lon: -52.4222 },
  Eldorado: { lat: -23.7869, lon: -54.2836 },
  'Mundo Novo': { lat: -23.9381, lon: -54.2706 },
  Inocência: { lat: -19.7256, lon: -51.93 },
};

/**
 * Calcula score de qualificação B2B (0..100), alertas de qualidade e roteiro consultivo de abordagem.
 * @param {object} e Linha da empresa (com sinais, contratos_pncp, telefone_repeticoes)
 */
export function qualificarEmpresa(e) {
  const setor = classificarSetor(e.cnae_principal, e.razao_social);
  const fatores = [];
  const alertas = [];
  let pontos = 0;

  // 1) Porte oficial Receita
  if (e.porte === 'DEMAIS') {
    pontos += 30;
    fatores.push({ criterio: 'Porte DEMAIS (Médio/Grande Porte na Receita)', impacto: +30 });
  } else {
    pontos += 15;
    fatores.push({ criterio: 'Porte EPP (Empresa de Pequeno Porte)', impacto: +15 });
  }

  // 2) Capital social declarado
  const cap = Number(e.capital_social ?? 0);
  if (cap >= 10_000_000) {
    pontos += 20;
    fatores.push({ criterio: 'Capital social ≥ R$ 10 milhões', impacto: +20 });
  } else if (cap >= 1_000_000) {
    pontos += 15;
    fatores.push({ criterio: 'Capital social ≥ R$ 1 milhão', impacto: +15 });
  } else if (cap >= 200_000) {
    pontos += 8;
    fatores.push({ criterio: 'Capital social ≥ R$ 200 mil', impacto: +8 });
  }

  // 3) Maturidade / tempo de operação
  const anoAbertura = e.data_abertura ? Number(String(e.data_abertura).slice(0, 4)) : null;
  if (anoAbertura) {
    const idade = 2026 - anoAbertura;
    if (idade >= 5) {
      pontos += 10;
      fatores.push({ criterio: `Operação consolidada (${idade} anos de CNPJ)`, impacto: +10 });
    } else if (idade <= 0) {
      pontos -= 8;
      fatores.push({ criterio: 'CNPJ aberto em 2026 (operação recém-constituída)', impacto: -8 });
      alertas.push('Empresa constituída em 2026 — verificar se é SPE de grupo econômico ou holding patrimonial.');
    }
  }

  // 4) Contratos públicos PNCP
  const qtdPncp = Number(e.contratos_pncp ?? 0);
  const valorPncp = Number(e.valor_contratos_pncp ?? 0);
  if (qtdPncp > 0) {
    pontos += 18;
    fatores.push({
      criterio: `Fornecedora do setor público (${qtdPncp} contrato(s) no PNCP)`,
      impacto: +18,
    });
  }

  // 5) Sinais de RH e ERP (radar de site)
  const sinais = Array.isArray(e.sinais) ? e.sinais : [];
  const erps = sinais.filter((s) => s.tipo === 'erp').map((s) => s.nome.toUpperCase());
  const rhs = sinais.filter((s) => s.tipo === 'rh').map((s) => s.nome.toUpperCase());

  if (rhs.length > 0 || e.indicio_medio_grande) {
    pontos += 15;
    fatores.push({
      criterio: `Portal de recrutamento ativo (${rhs.join(', ') || 'RH estruturado'} → indício +40 funcionários)`,
      impacto: +15,
    });
  }

  if (erps.length > 0) {
    pontos += 12;
    fatores.push({
      criterio: `Assinatura tecnológica de ERP identificada (${erps.join(', ')})`,
      impacto: +12,
    });
  } else if (e.dominio_confirmado) {
    pontos += 6;
    fatores.push({ criterio: 'Domínio corporativo próprio confirmado (sem ERP exposto no HTML)', impacto: +6 });
  }

  // 6) Qualidade de contato e detecção de contador
  const repTel = Number(e.telefone_repeticoes ?? 1);
  if (e.telefone_e164) {
    if (repTel >= 10) {
      pontos -= 12;
      fatores.push({
        criterio: `Telefone repetido em ${repTel} empresas de MS (provável escritório contábil)`,
        impacto: -12,
      });
      alertas.push(
        `O telefone cadastral aparece em ${repTel} CNPJs no estado (provável contador). Usar o contador como ponte para a diretoria financeira ou abordar via domínio corporativo.`
      );
    } else {
      pontos += 8;
      fatores.push({ criterio: 'Telefone direto exclusivo na Receita Federal', impacto: +8 });
    }
  }

  const score = Math.max(0, Math.min(100, pontos));
  const classificacao =
    score >= 70 ? 'ALTA PRIORIDADE (Tier A)' : score >= 45 ? 'MÉDIA PRIORIDADE (Tier B)' : 'BASE / NUTRIÇÃO (Tier C)';

  // Diagnóstico de maturidade de ERP e tese de abordagem
  let cenarioErp;
  let estrategiaAbordagem;
  if (erps.length > 0) {
    cenarioErp = `Substituição / Upgrade de ERP (${erps.join(', ')})`;
    estrategiaAbordagem =
      `A empresa já possui cultura de ERP (${erps.join(', ')} detectado no domínio ${e.dominio || 'corporativo'}). ` +
      `Não vender "sair da planilha": focar em gargalos de integrações satélites, custo de manutenção/customização do legado, ` +
      `fechamento contábil lento e visão consolidada em tempo real para a diretoria.`;
  } else if (qtdPncp > 0) {
    cenarioErp = 'Alta Complexidade Fiscal / B2G (Fornecedor PNCP)';
    estrategiaAbordagem =
      `A empresa possui ${qtdPncp} contrato(s) público(s) registrado(s) no PNCP. Operações que vendem para o governo sofrem ` +
      `com controle de saldo de empenho, vigência contratual, certidões negativas e margem corroída por reajustes. ` +
      `Abordar pela segurança fiscal, controle de contratos e previsibilidade de fluxo de caixa.`;
  } else if (e.porte === 'DEMAIS' || rhs.length > 0 || cap >= 1_000_000) {
    cenarioErp = 'Operação de Médio/Grande Porte (Transição de Legado / Descentralizado)';
    estrategiaAbordagem =
      `Pelo porte (${e.porte}) e estrutura de capital, a operação em ${e.municipio} exige governança entre compras, estoque, ` +
      `produção/serviços e contabilidade. Explorar a dor de sistemas departamentais desconectados e retrabalho no fechamento mensal.`;
  } else {
    cenarioErp = 'Profissionalização de Gestão (Crescimento EPP → Médio Porte)';
    estrategiaAbordagem =
      `Empresa EPP ativa no polo de ${e.municipio} (${setor.nome}). Abordar com foco em ganho de escala operacional, ` +
      `padronização de processos financeiros/fiscais e preparação da empresa para crescimento sem inflar o backoffice.`;
  }

  const nomeCurto = e.nome_fantasia || e.razao_social;
  const msgWhatsapp =
    `Olá, tudo bem? Falo com a direção/gestão da *${nomeCurto}* em ${e.municipio}?\n\n` +
    `Estamos atuando junto às principais operações de *${setor.nome}* no Mato Grosso do Sul com uma plataforma global de gestão (ERP). ` +
    (erps.length
      ? `Vimos a estrutura digital de vocês (${e.dominio}) e temos ajudado empresas que utilizam ${erps.join('/')} a eliminar custos de customização e acelerar o fechamento gerencial. `
      : qtdPncp > 0
        ? `Acompanhamos a atuação relevante de vocês em contratos públicos e privados na região e temos apoiado operações desse porte a blindar o controle de contratos, estoque e margem líquida. `
        : `Mapeamos as operações de destaque de ${e.municipio} e temos apoiado empresas do setor a integrar operação, compras e fiscal sem depender de controles paralelos em planilhas. `) +
    `\n\nFaz sentido agendarmos uma conversa executiva de 15 minutos nesta semana para compartilhar um diagnóstico de benchmark do setor em MS?`;

  return {
    score,
    classificacao,
    setor,
    cnae_descricao: NOMES_CNAE[e.cnae_principal] || `CNAE ${e.cnae_principal || 'não informado'}`,
    cenario_erp: cenarioErp,
    dor_diagnosticada: setor.dorPadrao,
    argumento_erp: setor.argumentoErp,
    estrategia_abordagem: estrategiaAbordagem,
    fatores,
    alertas,
    roteiro_whatsapp: msgWhatsapp,
  };
}
