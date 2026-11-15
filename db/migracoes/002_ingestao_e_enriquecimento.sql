-- 002_ingestao_e_enriquecimento — Etapa 3: ingestão em lote (Receita/PNCP) e enriquecimento (geo/site).
-- A 001 não é editada (o executor confere o sha256); toda evolução de schema vem em novas migrações.

-- ───────────── Origem 'rfb_lote' para contato vindo dos Dados Abertos da Receita ─────────────
ALTER TABLE prospeccao.empresas DROP CONSTRAINT empresas_telefone_origem_check;
ALTER TABLE prospeccao.empresas ADD CONSTRAINT empresas_telefone_origem_check CHECK (
  telefone_origem IN ('brasilapi', 'cnpjws', 'rfb_lote', 'site', 'manual', 'NAO_VERIFICADO', 'BLOQUEADO_LGPD'));
ALTER TABLE prospeccao.empresas DROP CONSTRAINT empresas_email_origem_check;
ALTER TABLE prospeccao.empresas ADD CONSTRAINT empresas_email_origem_check CHECK (
  email_origem IN ('brasilapi', 'cnpjws', 'rfb_lote', 'site', 'manual', 'NAO_VERIFICADO', 'BLOQUEADO_LGPD'));

-- ───────────── CNPJ básico (raiz de 8 posições): liga contrato de filial à matriz ─────────────
ALTER TABLE prospeccao.empresas ADD COLUMN cnpj_basico text GENERATED ALWAYS AS (substr(cnpj, 1, 8)) STORED;
CREATE INDEX empresas_org_cnpj_basico ON prospeccao.empresas (organization_id, cnpj_basico);

-- ───────────── Domínio: origem declarada e confirmação pelo próprio site ─────────────
ALTER TABLE prospeccao.empresas
  ADD COLUMN dominio_origem text CHECK (dominio_origem IN ('email_rfb', 'email_brasilapi', 'email_cnpjws', 'site_radar', 'manual')),
  -- true só quando o radar encontrou o CNPJ da própria empresa no HTML do domínio
  -- (o e-mail cadastral costuma ser do contador; domínio sem essa prova não é atribuído à empresa).
  ADD COLUMN dominio_confirmado boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT empresas_dominio_com_origem CHECK ((dominio IS NULL) = (dominio_origem IS NULL)),
  ADD CONSTRAINT empresas_dominio_confirmado_exige_dominio CHECK (NOT dominio_confirmado OR dominio IS NOT NULL);

-- ───────────── Controle do enriquecimento (evita reprocessar e explica falhas) ─────────────
ALTER TABLE prospeccao.empresas
  ADD COLUMN geo_enriquecido_em  timestamptz,
  ADD COLUMN site_enriquecido_em timestamptz,
  ADD COLUMN site_status text CHECK (site_status IN (
    'cnpj_confirmado', 'cnpj_nao_encontrado', 'inacessivel', 'sem_dominio', 'dominio_gratuito')),
  ADD CONSTRAINT empresas_site_status_com_data CHECK ((site_status IS NULL) = (site_enriquecido_em IS NULL));
CREATE INDEX empresas_org_geo_pendente  ON prospeccao.empresas (organization_id) WHERE geo_enriquecido_em IS NULL;
CREATE INDEX empresas_org_site_pendente ON prospeccao.empresas (organization_id) WHERE site_enriquecido_em IS NULL;

-- ───────────── ingestao_execucoes: auditoria e checkpoint de cada rodada ─────────────
CREATE TABLE prospeccao.ingestao_execucoes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  tipo             text NOT NULL CHECK (tipo IN ('receita', 'pncp', 'enriquecimento')),
  status           text NOT NULL DEFAULT 'em_andamento' CHECK (status IN ('em_andamento', 'concluida', 'falhou', 'interrompida')),
  parametros       jsonb NOT NULL DEFAULT '{}',
  checkpoint       jsonb,
  contadores       jsonb NOT NULL DEFAULT '{}',
  erro             text,
  iniciado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em    timestamptz NOT NULL DEFAULT now(),
  finalizado_em    timestamptz,
  CONSTRAINT execucoes_finalizada_com_data CHECK ((status = 'em_andamento') = (finalizado_em IS NULL))
);
CREATE INDEX execucoes_org_tipo ON prospeccao.ingestao_execucoes (organization_id, tipo, iniciado_em DESC);

ALTER TABLE prospeccao.ingestao_execucoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospeccao.ingestao_execucoes FORCE  ROW LEVEL SECURITY;
CREATE POLICY org_isolamento ON prospeccao.ingestao_execucoes TO prospeccao_app
  USING (organization_id = prospeccao.org_atual()) WITH CHECK (organization_id = prospeccao.org_atual());
GRANT SELECT, INSERT, UPDATE ON prospeccao.ingestao_execucoes TO prospeccao_app;
