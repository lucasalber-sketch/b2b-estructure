// Esquemas Zod do repositório: espelham as CHECKs do 001_inicial.sql para falhar cedo, com mensagem clara.
// O banco continua sendo a última barreira (as mesmas regras existem lá).
import { z } from 'zod';
import { limparCnpj, validarCnpj } from '../conectores/cnpj.js';

export const ETAPAS = ['candidato', 'enriquecido', 'qualificado', 'contatado', 'descartado', 'bloqueado_lgpd'];
export const ATORES = ['sistema', 'mcp', 'usuario'];

const contemCpf = (t) => t != null && (/\d{11}/.test(t) || /\d{3}\.\d{3}\.\d{3}-\d{2}/.test(t));
const opcional = (s) => s.nullable().default(null);
const texto = () => opcional(z.string().trim().min(1));

export const cnpj = z
  .string()
  .transform(limparCnpj)
  .refine((c) => validarCnpj(c).valido, { message: 'CNPJ inválido (dígito verificador ou formato)' });

/** Aceita (67) 3321-0000, 6733210000, +556733210000 → +556733210000. */
export function paraE164(entrada) {
  if (entrada == null || entrada === '') return null;
  let d = String(entrada).replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? `+55${d}` : null;
}
export const telefoneE164 = z
  .string()
  .transform((t, ctx) => {
    const e = paraE164(t);
    if (!e) ctx.addIssue({ code: 'custom', message: 'telefone inválido (esperado DDD + número brasileiro)' });
    return e ?? z.NEVER;
  });

const ORIGEM_CONTATO = ['brasilapi', 'cnpjws', 'site', 'manual', 'NAO_VERIFICADO'];

export const EmpresaEntrada = z
  .object({
    cnpj,
    cnpj_origem: z.enum(['brasilapi', 'cnpjws', 'brasilapi+cnpjws', 'rfb_lote', 'site_radar', 'pncp', 'manual']),
    fonte_descoberta: z.enum(['rfb_lote', 'pncp', 'site_radar', 'mcp_consulta', 'manual']),
    razao_social: z.string().trim().min(1).refine((t) => !contemCpf(t), { message: 'razão social contém CPF (pessoa física) — recusada (LGPD)' }),
    nome_fantasia: texto().refine((t) => !contemCpf(t), { message: 'nome fantasia contém CPF — recusado (LGPD)' }),
    matriz_filial: opcional(z.enum(['MATRIZ', 'FILIAL'])),
    situacao: texto(),
    data_abertura: opcional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    porte: z.enum(['EPP', 'DEMAIS'], { message: 'porte fora do escopo (apenas EPP e DEMAIS)' }),
    natureza_juridica_codigo: z
      .string()
      .regex(/^2\d{3}$/, { message: 'natureza jurídica não empresarial (esperado 2xxx)' })
      .refine((c) => c !== '2135', { message: 'Empresário Individual (213-5) fora do escopo (LGPD)' }),
    mei: z.literal(false, { message: 'MEI fora do escopo (LGPD)' }).default(false),
    capital_social: opcional(z.number().nonnegative()),
    cnae_principal: opcional(z.string().regex(/^\d{7}$/)),
    cnaes_secundarios: z.array(z.string().regex(/^\d{7}$/)).default([]),
    logradouro: texto(),
    numero: texto(),
    complemento: texto(),
    bairro: texto(),
    cep: opcional(z.string().transform((c) => c.replace(/\D/g, '')).pipe(z.string().regex(/^\d{8}$/))),
    municipio: texto(),
    uf: opcional(z.string().regex(/^[A-Z]{2}$/)),
    codigo_ibge: opcional(z.string().regex(/^\d{7}$/)),
    lat: opcional(z.number().min(-90).max(90)),
    lon: opcional(z.number().min(-180).max(180)),
    geo_precisao: z.enum(['rua', 'cep_aproximado', 'municipio', 'NAO_VERIFICADO']).default('NAO_VERIFICADO'),
    geo_fonte: opcional(z.enum(['brasilapi_cep', 'nominatim', 'manual'])),
    telefone_e164: opcional(telefoneE164),
    telefone_origem: z.enum(ORIGEM_CONTATO).default('NAO_VERIFICADO'),
    email: opcional(z.string().trim().toLowerCase().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)),
    email_origem: z.enum(ORIGEM_CONTATO).default('NAO_VERIFICADO'),
    dominio: opcional(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)),
    etapa_funil: z.enum(ETAPAS).default('candidato'),
    consultado_em: opcional(z.string().datetime({ offset: true })),
  })
  .strict()
  .superRefine((e, ctx) => {
    const falta = (campo, msg) => ctx.addIssue({ code: 'custom', path: [campo], message: msg });
    if ((e.telefone_e164 == null) !== (e.telefone_origem === 'NAO_VERIFICADO'))
      falta('telefone_origem', 'telefone presente exige origem; sem telefone a origem é NAO_VERIFICADO');
    if ((e.email == null) !== (e.email_origem === 'NAO_VERIFICADO'))
      falta('email_origem', 'e-mail presente exige origem; sem e-mail a origem é NAO_VERIFICADO');
    const temGeo = e.lat != null || e.lon != null;
    if (temGeo && (e.lat == null || e.lon == null || !e.geo_fonte || e.geo_precisao === 'NAO_VERIFICADO'))
      falta('geo_fonte', 'coordenada exige lat, lon, geo_fonte e geo_precisao');
    if (!temGeo && (e.geo_fonte || e.geo_precisao !== 'NAO_VERIFICADO'))
      falta('geo_precisao', 'sem coordenada a precisão é NAO_VERIFICADO e a fonte é nula');
  });

export const ContratoPncpEntrada = z
  .object({
    cnpj_fornecedor: cnpj,
    numero_controle_pncp: z.string().trim().min(1),
    orgao_cnpj: opcional(cnpj),
    orgao_nome: texto(),
    objeto: texto(),
    valor_global: opcional(z.number().nonnegative()),
    data_assinatura: opcional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    data_vigencia_fim: opcional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    url_fonte: z.string().url().startsWith('https://'),
  })
  .strict();

export const SinalEntrada = z
  .object({
    cnpj,
    tipo: z.enum(['erp', 'rh']),
    nome: z.string().trim().min(1),
    erp_fonte: z.enum(['site_radar_html', 'manual']).default('site_radar_html'),
    status: z.enum(['CONFIRMADO', 'NAO_VERIFICADO']).default('NAO_VERIFICADO'),
    evidencia: texto(),
    url_evidencia: opcional(z.string().url()),
  })
  .strict()
  .refine((s) => s.status !== 'CONFIRMADO' || (s.evidencia && s.url_evidencia), {
    message: 'sinal CONFIRMADO exige evidência literal e URL',
    path: ['evidencia'],
  });

export const MoverFunilEntrada = z.object({
  cnpj,
  etapa: z.enum(ETAPAS),
  motivo: z.string().trim().min(1),
  ator: z.enum(ATORES).default('sistema'),
});

export const BloqueioEntrada = z
  .object({
    cnpj: opcional(cnpj),
    telefone: opcional(telefoneE164),
    motivo: z.string().trim().min(1),
    origem_solicitacao: z.enum(['titular', 'empresa', 'anpd', 'interno']).default('titular'),
  })
  .refine((b) => b.cnpj || b.telefone, { message: 'informe cnpj e/ou telefone' });

export const FiltroEmpresas = z
  .object({
    codigo_ibge: z.string().regex(/^\d{7}$/).optional(),
    uf: z.string().regex(/^[A-Z]{2}$/).optional(),
    cnae: z.string().regex(/^\d{7}$/).optional(),
    etapa: z.enum(ETAPAS).optional(),
    limite: z.number().int().min(1).max(1000).default(100),
  })
  .strict();

export const OrganizationId = z.uuid({ message: 'organization_id deve ser um UUID' });
