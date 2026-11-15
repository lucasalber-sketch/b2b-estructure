-- 001_inicial — schema `prospeccao`: fonte da verdade dos dados empresariais (Etapa 2).
--
-- Princípios aplicados no próprio banco (valem para qualquer cliente, não só para o app):
--   • Isolamento por organization_id via FORCE ROW LEVEL SECURITY + papel `prospeccao_app`
--     (o app faz SET LOCAL ROLE prospeccao_app e set_config('app.organization_id', …) em cada transação).
--   • Anti-invenção: todo dado presente exige a origem; dado não confirmado = NULL / 'NAO_VERIFICADO'.
--     Não existe coluna de número de funcionários. CNPJ só entra com dígito verificador válido.
--   • LGPD: nenhuma coluna de sócio/QSA/CPF/nome de pessoa física; MEI e Empresário Individual
--     são recusados; razão social contendo CPF é recusada; `nao_contatar` é global e permanente.

CREATE SCHEMA IF NOT EXISTS prospeccao;
REVOKE ALL ON SCHEMA prospeccao FROM PUBLIC;

-- ───────────────────────── Papel da aplicação ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prospeccao_app') THEN
    CREATE ROLE prospeccao_app NOLOGIN NOINHERIT;
  END IF;
  -- Necessário para `SET ROLE` (PG16+ não concede SET automaticamente a quem cria o papel).
  EXECUTE format('GRANT prospeccao_app TO %I', current_user);
END $$;

-- Papéis da Data API do Supabase não enxergam este schema (no pglite eles não existem).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA prospeccao FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA prospeccao REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA prospeccao REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA prospeccao TO prospeccao_app;

-- ───────────────────────── Funções utilitárias ─────────────────────────

-- CNPJ numérico ou alfanumérico (IN RFB 2.229/2024): 12 × [A-Z0-9] + 2 DV numéricos, módulo 11 sobre (ASCII − 48).
CREATE OR REPLACE FUNCTION prospeccao.cnpj_valido(c text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  p1 int[] := ARRAY[5,4,3,2,9,8,7,6,5,4,3,2];
  p2 int[] := ARRAY[6,5,4,3,2,9,8,7,6,5,4,3,2];
  s int := 0; dv1 int; dv2 int; i int;
BEGIN
  IF c IS NULL THEN RETURN NULL; END IF; -- NULL passa na CHECK (coluna opcional); NOT NULL é regra à parte
  IF c !~ '^[A-Z0-9]{12}[0-9]{2}$' OR c ~ '^(.)\1{13}$' THEN RETURN false; END IF;
  FOR i IN 1..12 LOOP s := s + (ascii(substr(c, i, 1)) - 48) * p1[i]; END LOOP;
  dv1 := CASE WHEN s % 11 < 2 THEN 0 ELSE 11 - s % 11 END;
  s := 0;
  FOR i IN 1..12 LOOP s := s + (ascii(substr(c, i, 1)) - 48) * p2[i]; END LOOP;
  s := s + dv1 * p2[13];
  dv2 := CASE WHEN s % 11 < 2 THEN 0 ELSE 11 - s % 11 END;
  RETURN substr(c, 13, 2) = dv1::text || dv2::text;
END $$;

-- Texto que parece conter CPF (11 dígitos seguidos ou máscara 000.000.000-00) → indício de pessoa física.
CREATE OR REPLACE FUNCTION prospeccao.contem_cpf(t text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT t IS NOT NULL AND (t ~ '[0-9]{11}' OR t ~ '[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}')
$$;

-- Organização da transação corrente (NULL se não definida → RLS não devolve nada).
CREATE OR REPLACE FUNCTION prospeccao.org_atual() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.organization_id', true), '')::uuid
$$;

GRANT EXECUTE ON FUNCTION prospeccao.cnpj_valido(text), prospeccao.contem_cpf(text), prospeccao.org_atual()
  TO prospeccao_app;

-- ───────────────────────── empresas ─────────────────────────
CREATE TABLE prospeccao.empresas (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,

  cnpj                      text NOT NULL CHECK (prospeccao.cnpj_valido(cnpj)),
  cnpj_origem               text NOT NULL
                            CHECK (cnpj_origem IN ('brasilapi', 'cnpjws', 'brasilapi+cnpjws', 'rfb_lote', 'site_radar', 'pncp', 'manual')),
  fonte_descoberta          text NOT NULL
                            CHECK (fonte_descoberta IN ('rfb_lote', 'pncp', 'site_radar', 'mcp_consulta', 'manual')),

  razao_social              text NOT NULL CHECK (length(btrim(razao_social)) > 0 AND NOT prospeccao.contem_cpf(razao_social)),
  nome_fantasia             text CHECK (NOT prospeccao.contem_cpf(nome_fantasia)),
  matriz_filial             text CHECK (matriz_filial IN ('MATRIZ', 'FILIAL')),
  situacao                  text,
  data_abertura             date,
  -- Decisão C: só PJ empresarial EPP/DEMAIS; MEI e Empresário Individual (213-5) ficam fora.
  porte                     text NOT NULL CHECK (porte IN ('EPP', 'DEMAIS')),
  natureza_juridica_codigo  text NOT NULL CHECK (natureza_juridica_codigo ~ '^2[0-9]{3}$' AND natureza_juridica_codigo <> '2135'),
  mei                       boolean NOT NULL DEFAULT false CHECK (mei = false),
  capital_social            numeric(18,2) CHECK (capital_social >= 0),
  cnae_principal            text CHECK (cnae_principal ~ '^[0-9]{7}$'),
  cnaes_secundarios         text[] NOT NULL DEFAULT '{}',

  logradouro                text,
  numero                    text,
  complemento               text,
  bairro                    text,
  cep                       text CHECK (cep ~ '^[0-9]{8}$'),
  municipio                 text,
  uf                        text CHECK (uf ~ '^[A-Z]{2}$'),
  codigo_ibge               text CHECK (codigo_ibge ~ '^[0-9]{7}$'),

  lat                       numeric(9,6) CHECK (lat BETWEEN -90 AND 90),
  lon                       numeric(9,6) CHECK (lon BETWEEN -180 AND 180),
  geo_precisao              text NOT NULL DEFAULT 'NAO_VERIFICADO'
                            CHECK (geo_precisao IN ('rua', 'cep_aproximado', 'municipio', 'NAO_VERIFICADO')),
  geo_fonte                 text CHECK (geo_fonte IN ('brasilapi_cep', 'nominatim', 'manual')),

  telefone_e164             text CHECK (telefone_e164 ~ '^\+55[0-9]{10,11}$'),
  telefone_origem           text NOT NULL DEFAULT 'NAO_VERIFICADO'
                            CHECK (telefone_origem IN ('brasilapi', 'cnpjws', 'site', 'manual', 'NAO_VERIFICADO', 'BLOQUEADO_LGPD')),
  email                     text CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  email_origem              text NOT NULL DEFAULT 'NAO_VERIFICADO'
                            CHECK (email_origem IN ('brasilapi', 'cnpjws', 'site', 'manual', 'NAO_VERIFICADO', 'BLOQUEADO_LGPD')),
  dominio                   text CHECK (dominio ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),

  etapa_funil               text NOT NULL DEFAULT 'candidato'
                            CHECK (etapa_funil IN ('candidato', 'enriquecido', 'qualificado', 'contatado', 'descartado', 'bloqueado_lgpd')),

  consultado_em             timestamptz,
  criado_em                 timestamptz NOT NULL DEFAULT now(),
  atualizado_em             timestamptz NOT NULL DEFAULT now(),

  -- Anti-invenção: dado presente ⇔ origem declarada.
  CONSTRAINT empresas_telefone_com_origem CHECK ((telefone_e164 IS NULL) = (telefone_origem IN ('NAO_VERIFICADO', 'BLOQUEADO_LGPD'))),
  CONSTRAINT empresas_email_com_origem    CHECK ((email IS NULL) = (email_origem IN ('NAO_VERIFICADO', 'BLOQUEADO_LGPD'))),
  CONSTRAINT empresas_geo_com_origem CHECK (
    (lat IS NULL AND lon IS NULL AND geo_fonte IS NULL AND geo_precisao = 'NAO_VERIFICADO')
    OR (lat IS NOT NULL AND lon IS NOT NULL AND geo_fonte IS NOT NULL AND geo_precisao <> 'NAO_VERIFICADO')
  ),
  CONSTRAINT empresas_cnpj_por_org UNIQUE (organization_id, cnpj),
  CONSTRAINT empresas_org_id UNIQUE (organization_id, id) -- alvo das FKs compostas (impede vínculo entre orgs)
);
CREATE INDEX empresas_org_municipio ON prospeccao.empresas (organization_id, codigo_ibge);
CREATE INDEX empresas_org_cnae      ON prospeccao.empresas (organization_id, cnae_principal);
CREATE INDEX empresas_org_etapa     ON prospeccao.empresas (organization_id, etapa_funil);
CREATE INDEX empresas_telefone      ON prospeccao.empresas (telefone_e164) WHERE telefone_e164 IS NOT NULL;

-- ───────────────────────── empresa_contratos_pncp ─────────────────────────
CREATE TABLE prospeccao.empresa_contratos_pncp (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  empresa_id            uuid NOT NULL,
  numero_controle_pncp  text NOT NULL CHECK (length(btrim(numero_controle_pncp)) > 0),
  cnpj_fornecedor       text NOT NULL CHECK (prospeccao.cnpj_valido(cnpj_fornecedor)),
  orgao_cnpj            text CHECK (prospeccao.cnpj_valido(orgao_cnpj)),
  orgao_nome            text,
  objeto                text,
  valor_global          numeric(18,2) CHECK (valor_global >= 0),
  data_assinatura       date,
  data_vigencia_fim     date,
  url_fonte             text NOT NULL CHECK (url_fonte ~ '^https://'),
  coletado_em           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contratos_empresa_fk FOREIGN KEY (organization_id, empresa_id)
    REFERENCES prospeccao.empresas (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT contratos_numero_por_org UNIQUE (organization_id, numero_controle_pncp)
);
CREATE INDEX contratos_empresa ON prospeccao.empresa_contratos_pncp (organization_id, empresa_id);

-- ───────────────────────── empresa_sinais_erp ─────────────────────────
CREATE TABLE prospeccao.empresa_sinais_erp (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  empresa_id       uuid NOT NULL,
  tipo             text NOT NULL CHECK (tipo IN ('erp', 'rh')),
  nome             text NOT NULL CHECK (length(btrim(nome)) > 0),
  erp_fonte        text NOT NULL CHECK (erp_fonte IN ('site_radar_html', 'manual')),
  status           text NOT NULL DEFAULT 'NAO_VERIFICADO' CHECK (status IN ('CONFIRMADO', 'NAO_VERIFICADO')),
  evidencia        text,
  url_evidencia    text,
  coletado_em      timestamptz NOT NULL DEFAULT now(),
  -- Só é CONFIRMADO com trecho literal e a URL onde ele foi visto.
  CONSTRAINT sinais_confirmado_com_evidencia CHECK (
    status <> 'CONFIRMADO' OR (evidencia IS NOT NULL AND length(btrim(evidencia)) > 0 AND url_evidencia IS NOT NULL)
  ),
  CONSTRAINT sinais_empresa_fk FOREIGN KEY (organization_id, empresa_id)
    REFERENCES prospeccao.empresas (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT sinais_unico UNIQUE (organization_id, empresa_id, tipo, nome)
);

-- ───────────────────────── funil_historico (append-only) ─────────────────────────
CREATE TABLE prospeccao.funil_historico (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  empresa_id       uuid NOT NULL,
  etapa_anterior   text,
  etapa            text NOT NULL
                   CHECK (etapa IN ('candidato', 'enriquecido', 'qualificado', 'contatado', 'descartado', 'bloqueado_lgpd')),
  motivo           text,
  ator             text NOT NULL DEFAULT 'sistema' CHECK (ator IN ('sistema', 'mcp', 'usuario')),
  ocorrido_em      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT funil_empresa_fk FOREIGN KEY (organization_id, empresa_id)
    REFERENCES prospeccao.empresas (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX funil_empresa ON prospeccao.funil_historico (organization_id, empresa_id, ocorrido_em);

-- ───────────────────────── nao_contatar (global e permanente) ─────────────────────────
CREATE TABLE prospeccao.nao_contatar (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj                 text CHECK (prospeccao.cnpj_valido(cnpj)),
  telefone_e164        text CHECK (telefone_e164 ~ '^\+55[0-9]{10,11}$'),
  motivo               text NOT NULL CHECK (length(btrim(motivo)) > 0),
  origem_solicitacao   text NOT NULL DEFAULT 'titular' CHECK (origem_solicitacao IN ('titular', 'empresa', 'anpd', 'interno')),
  registrado_por_org   uuid,
  solicitado_em        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nao_contatar_algum_alvo CHECK (cnpj IS NOT NULL OR telefone_e164 IS NOT NULL)
);
CREATE UNIQUE INDEX nao_contatar_cnpj     ON prospeccao.nao_contatar (cnpj) WHERE cnpj IS NOT NULL;
CREATE UNIQUE INDEX nao_contatar_telefone ON prospeccao.nao_contatar (telefone_e164) WHERE telefone_e164 IS NOT NULL;

-- ───────────────────────── Gatilhos ─────────────────────────

-- Bloqueio LGPD na gravação de empresas:
--   INSERT de CNPJ bloqueado → erro (impede reimportação);
--   UPDATE de CNPJ bloqueado → saneia (sem contato, etapa bloqueado_lgpd);
--   telefone bloqueado → gravado como NULL / BLOQUEADO_LGPD.
CREATE OR REPLACE FUNCTION prospeccao.tg_empresas_lgpd() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM prospeccao.nao_contatar n WHERE n.cnpj = NEW.cnpj) THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'nao_contatar: CNPJ % está na lista de não contatar (LGPD); importação recusada', NEW.cnpj
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.telefone_e164 := NULL; NEW.telefone_origem := 'BLOQUEADO_LGPD';
    NEW.email := NULL;         NEW.email_origem := 'BLOQUEADO_LGPD';
    NEW.etapa_funil := 'bloqueado_lgpd';
  ELSIF NEW.telefone_e164 IS NOT NULL
        AND EXISTS (SELECT 1 FROM prospeccao.nao_contatar n WHERE n.telefone_e164 = NEW.telefone_e164) THEN
    NEW.telefone_e164 := NULL; NEW.telefone_origem := 'BLOQUEADO_LGPD';
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.atualizado_em := now(); END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER empresas_lgpd BEFORE INSERT OR UPDATE ON prospeccao.empresas
  FOR EACH ROW EXECUTE FUNCTION prospeccao.tg_empresas_lgpd();

-- Toda mudança de etapa vira linha no histórico (motivo/ator vêm de set_config local da transação).
CREATE OR REPLACE FUNCTION prospeccao.tg_empresas_funil() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.etapa_funil IS DISTINCT FROM OLD.etapa_funil THEN
    INSERT INTO prospeccao.funil_historico (organization_id, empresa_id, etapa_anterior, etapa, motivo, ator)
    VALUES (
      NEW.organization_id, NEW.id,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.etapa_funil END,
      NEW.etapa_funil,
      coalesce(nullif(current_setting('app.funil_motivo', true), ''),
               CASE WHEN TG_OP = 'INSERT' THEN 'importacao' WHEN NEW.etapa_funil = 'bloqueado_lgpd' THEN 'nao_contatar' END),
      coalesce(nullif(current_setting('app.funil_ator', true), ''), 'sistema')
    );
  END IF;
  RETURN NULL;
END $$;

-- Sem lista de colunas: `UPDATE OF etapa_funil` não dispara quando quem muda a etapa é o gatilho BEFORE (LGPD).
CREATE TRIGGER empresas_funil AFTER INSERT OR UPDATE ON prospeccao.empresas
  FOR EACH ROW EXECUTE FUNCTION prospeccao.tg_empresas_funil();

-- Tabelas imutáveis: nem o dono altera/apaga sem remover o gatilho numa migração explícita.
CREATE OR REPLACE FUNCTION prospeccao.tg_somente_insercao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: tabela somente-inserção (% não permitido)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER nao_contatar_imutavel BEFORE UPDATE OR DELETE ON prospeccao.nao_contatar
  FOR EACH ROW EXECUTE FUNCTION prospeccao.tg_somente_insercao();
CREATE TRIGGER nao_contatar_sem_truncate BEFORE TRUNCATE ON prospeccao.nao_contatar
  FOR EACH STATEMENT EXECUTE FUNCTION prospeccao.tg_somente_insercao();
CREATE TRIGGER funil_imutavel BEFORE UPDATE OR DELETE ON prospeccao.funil_historico
  FOR EACH ROW EXECUTE FUNCTION prospeccao.tg_somente_insercao();
CREATE TRIGGER funil_sem_truncate BEFORE TRUNCATE ON prospeccao.funil_historico
  FOR EACH STATEMENT EXECUTE FUNCTION prospeccao.tg_somente_insercao();

-- ───────────────────────── RLS + privilégios ─────────────────────────
ALTER TABLE prospeccao.empresas               ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospeccao.empresas               FORCE  ROW LEVEL SECURITY;
ALTER TABLE prospeccao.empresa_contratos_pncp ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospeccao.empresa_contratos_pncp FORCE  ROW LEVEL SECURITY;
ALTER TABLE prospeccao.empresa_sinais_erp     ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospeccao.empresa_sinais_erp     FORCE  ROW LEVEL SECURITY;
ALTER TABLE prospeccao.funil_historico        ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospeccao.funil_historico        FORCE  ROW LEVEL SECURITY;
ALTER TABLE prospeccao.nao_contatar           ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospeccao.nao_contatar           FORCE  ROW LEVEL SECURITY;

CREATE POLICY org_isolamento ON prospeccao.empresas TO prospeccao_app
  USING (organization_id = prospeccao.org_atual()) WITH CHECK (organization_id = prospeccao.org_atual());
CREATE POLICY org_isolamento ON prospeccao.empresa_contratos_pncp TO prospeccao_app
  USING (organization_id = prospeccao.org_atual()) WITH CHECK (organization_id = prospeccao.org_atual());
CREATE POLICY org_isolamento ON prospeccao.empresa_sinais_erp TO prospeccao_app
  USING (organization_id = prospeccao.org_atual()) WITH CHECK (organization_id = prospeccao.org_atual());
CREATE POLICY org_isolamento ON prospeccao.funil_historico TO prospeccao_app
  USING (organization_id = prospeccao.org_atual()) WITH CHECK (organization_id = prospeccao.org_atual());

-- Decisão A: lista global — toda organização consulta e inclui; ninguém altera ou apaga.
CREATE POLICY global_leitura ON prospeccao.nao_contatar FOR SELECT TO prospeccao_app USING (true);
CREATE POLICY global_inclusao ON prospeccao.nao_contatar FOR INSERT TO prospeccao_app
  WITH CHECK (registrado_por_org IS NOT DISTINCT FROM prospeccao.org_atual());

GRANT SELECT, INSERT, UPDATE ON prospeccao.empresas, prospeccao.empresa_contratos_pncp, prospeccao.empresa_sinais_erp
  TO prospeccao_app;
GRANT SELECT, INSERT ON prospeccao.funil_historico, prospeccao.nao_contatar TO prospeccao_app;
