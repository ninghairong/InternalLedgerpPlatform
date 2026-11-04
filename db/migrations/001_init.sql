-- =============================================================================
-- 内部账目管理平台 — 初始数据库结构（PostgreSQL 16）
--
-- 约定
--   * 金额 numeric(18,2)；程序侧以"分"为整数处理，禁止浮点
--   * 主键 bigint identity；账目类型用稳定的文本编码作主键（c-wage 等）
--   * 业务日期 date，系统时间 timestamptz（数据库时区 Asia/Shanghai）
--   * 账务数据只增不删：流水保存即生效，只能冲销；分录、审计日志只追加
--   * 关键不变式由触发器在数据库层保证，应用层校验只为给出友好提示
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE DOMAIN amount_pos AS numeric(18,2) CHECK (VALUE > 0);
CREATE DOMAIN amount_any AS numeric(18,2);
CREATE DOMAIN rate       AS numeric(9,6)  CHECK (VALUE >= 0 AND VALUE < 1);

CREATE TYPE record_status  AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE user_role      AS ENUM ('ADMIN', 'FINANCE', 'READONLY');
CREATE TYPE entity_kind    AS ENUM ('HEAD', 'BRANCH', 'INDEPENDENT');
CREATE TYPE taxpayer_type  AS ENUM ('GENERAL', 'SMALL');
CREATE TYPE filing_period  AS ENUM ('MONTH', 'QUARTER');
CREATE TYPE account_kind   AS ENUM ('CORPORATE', 'INTERNAL_PERSONAL', 'CASH', 'EXTERNAL', 'VIRTUAL');
CREATE TYPE virtual_kind   AS ENUM ('OPENING', 'TAX', 'SOCIAL', 'BANK_FEE', 'BANK_INTEREST', 'LOSS');
CREATE TYPE trace_mode     AS ENUM ('REQUIRED', 'OPTIONAL', 'NONE');
CREATE TYPE flow_method    AS ENUM ('BANK_TRANSFER', 'CORPORATE_TRANSFER', 'WECHAT', 'ALIPAY', 'CASH_WITHDRAW', 'CASH_DEPOSIT', 'CASH_HANDOVER', 'OTHER');
CREATE TYPE flow_status    AS ENUM ('CONFIRMED', 'VOIDED', 'REVERSED');  -- 保存即生效；VOIDED = 整批撤销导入
CREATE TYPE ic_nature      AS ENUM ('LOAN', 'REPAYMENT', 'ON_BEHALF', 'SERVICE_SETTLEMENT', 'FUND_ALLOCATION');
CREATE TYPE project_status AS ENUM ('PREPARING', 'ACTIVE', 'CLOSED');
CREATE TYPE project_kind   AS ENUM ('NORMAL', 'COMMON');
CREATE TYPE vat_method     AS ENUM ('GENERAL', 'SIMPLE');
CREATE TYPE category_nature AS ENUM ('EXPENSE', 'INCOME', 'TRANSFER', 'CURRENT', 'TAX');
CREATE TYPE tax_kind       AS ENUM ('VAT', 'VAT_PREPAY', 'SURCHARGE', 'IIT', 'CIT', 'STAMP', 'SOCIAL');
CREATE TYPE invoice_direction AS ENUM ('OUTPUT', 'INPUT');
CREATE TYPE invoice_type   AS ENUM ('VAT_SPECIAL', 'VAT_NORMAL');
CREATE TYPE period_status  AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE import_status  AS ENUM ('VALIDATED', 'COMMITTED', 'ROLLED_BACK');

CREATE FUNCTION touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version    := OLD.version + 1;
  RETURN NEW;
END $$;

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

-- -----------------------------------------------------------------------------
-- 用户（≤5 人自用，三种角色，不做数据范围权限）
-- -----------------------------------------------------------------------------
CREATE TABLE app_user (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  role          user_role NOT NULL,
  status        record_status NOT NULL DEFAULT 'ACTIVE',
  failed_logins int NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 0
);
CREATE TRIGGER touch_app_user BEFORE UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION touch_row();

-- -----------------------------------------------------------------------------
-- 公司主体与纳税信息
-- -----------------------------------------------------------------------------
CREATE TABLE entity (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL UNIQUE,
  short_name  text NOT NULL,
  uscc        text UNIQUE,
  kind        entity_kind NOT NULL,
  parent_id   bigint REFERENCES entity(id),
  region      text NOT NULL,
  status      record_status NOT NULL DEFAULT 'ACTIVE',
  remark      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 0,
  CHECK (kind <> 'BRANCH' OR parent_id IS NOT NULL),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE TRIGGER touch_entity BEFORE UPDATE ON entity FOR EACH ROW EXECUTE FUNCTION touch_row();

-- 纳税人身份历史：身份变更后，之前期间仍按原身份计算；同一主体的生效区间不得重叠
CREATE TABLE entity_tax_profile (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id     bigint NOT NULL REFERENCES entity(id),
  taxpayer_type taxpayer_type NOT NULL,
  vat_filing    filing_period NOT NULL,
  valid_from    date NOT NULL,
  valid_to      date,
  urban_rate    rate NOT NULL,
  halving       boolean NOT NULL DEFAULT false,
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (urban_rate IN (0.07, 0.05, 0.01)),
  EXCLUDE USING gist (entity_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);

CREATE TABLE tax_rule (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tax              text NOT NULL,
  name             text NOT NULL,
  taxpayer         taxpayer_type,
  method           vat_method,
  rate             rate NOT NULL,
  threshold_amount amount_any,
  threshold_period filing_period,
  reduction_ratio  rate,
  valid_from       date NOT NULL,
  valid_to         date,
  policy_ref       text
);

-- -----------------------------------------------------------------------------
-- 账户
-- -----------------------------------------------------------------------------
CREATE TABLE account (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         text NOT NULL UNIQUE,
  name         text NOT NULL UNIQUE,           -- 导入时按名称识别，必须唯一
  kind         account_kind NOT NULL,
  virtual_kind virtual_kind UNIQUE,
  entity_id    bigint REFERENCES entity(id),
  holder       text,
  bank         text,
  last4        text CHECK (last4 ~ '^\d{4}$'),
  trace        trace_mode NOT NULL,
  status       record_status NOT NULL DEFAULT 'ACTIVE',
  remark       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 0,
  CHECK ((kind = 'CORPORATE') = (entity_id IS NOT NULL)),
  CHECK ((kind = 'VIRTUAL') = (virtual_kind IS NOT NULL)),
  -- 公户、个人卡、现金逐笔强制溯源；外部账户可选；虚拟账户不溯源
  CHECK (kind NOT IN ('CORPORATE', 'INTERNAL_PERSONAL', 'CASH') OR trace = 'REQUIRED'),
  CHECK (kind <> 'EXTERNAL' OR trace = 'OPTIONAL'),
  CHECK (kind <> 'VIRTUAL' OR trace = 'NONE'),
  CHECK (kind NOT IN ('INTERNAL_PERSONAL', 'CASH') OR holder IS NOT NULL)
);
CREATE INDEX account_entity_idx ON account(entity_id);
CREATE TRIGGER touch_account BEFORE UPDATE ON account FOR EACH ROW EXECUTE FUNCTION touch_row();

-- 余额缓存：随分录同事务更新；每日自检 balance = Σ ledger_entry
CREATE TABLE account_balance (
  account_id bigint PRIMARY KEY REFERENCES account(id),
  balance    amount_any NOT NULL DEFAULT 0,
  as_of      timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 账目类型与项目
-- -----------------------------------------------------------------------------
CREATE TABLE category (
  id           text PRIMARY KEY,
  parent_id    text REFERENCES category(id),
  name         text NOT NULL,
  nature       category_nature NOT NULL,
  affects_pnl  boolean NOT NULL,             -- 内部划转 / 往来 = false，避免同一笔钱被重复计成本
  requires_tax boolean NOT NULL DEFAULT false, -- 缴税、社保须填税种与所属期
  sort         int NOT NULL DEFAULT 0,
  status       record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (parent_id, name),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE project (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id       bigint NOT NULL REFERENCES entity(id),
  code            text NOT NULL UNIQUE,
  name            text NOT NULL UNIQUE,
  kind            project_kind NOT NULL DEFAULT 'NORMAL',
  manager         text NOT NULL,
  customer        text,
  region          text,
  vat_method      vat_method NOT NULL DEFAULT 'GENERAL',
  contract_amount amount_any NOT NULL DEFAULT 0,
  start_date      date,
  status          project_status NOT NULL DEFAULT 'ACTIVE',
  closed_at       timestamptz,
  remark          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX project_common_uq ON project(entity_id) WHERE kind = 'COMMON';
CREATE TRIGGER touch_project BEFORE UPDATE ON project FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE TABLE project_budget (
  project_id  bigint NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  category_id text NOT NULL REFERENCES category(id),
  amount      amount_pos NOT NULL,
  PRIMARY KEY (project_id, category_id)
);

-- -----------------------------------------------------------------------------
-- 会计期间（按主体按月结账）
-- -----------------------------------------------------------------------------
CREATE TABLE accounting_period (
  entity_id  bigint NOT NULL REFERENCES entity(id),
  period     date NOT NULL CHECK (extract(day FROM period) = 1),
  status     period_status NOT NULL DEFAULT 'OPEN',
  closed_by  bigint REFERENCES app_user(id),
  closed_at  timestamptz,
  PRIMARY KEY (entity_id, period)
);

CREATE FUNCTION assert_period_open(p_entities bigint[], p_date date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_closed text;
BEGIN
  SELECT e.short_name INTO v_closed
    FROM accounting_period ap JOIN entity e ON e.id = ap.entity_id
   WHERE ap.entity_id = ANY(p_entities) AND ap.period = date_trunc('month', p_date)::date AND ap.status = 'CLOSED'
   LIMIT 1;
  IF v_closed IS NOT NULL THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: % % 已结账', v_closed, to_char(p_date, 'YYYY-MM') USING ERRCODE = 'P0001';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 附件与导入批次
-- -----------------------------------------------------------------------------
CREATE TABLE attachment (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  storage_key  text NOT NULL UNIQUE,         -- 附件目录下的相对路径
  file_name    text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL,
  sha256       char(64) NOT NULL,
  uploaded_by  bigint REFERENCES app_user(id),
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attachment_link (
  attachment_id bigint NOT NULL REFERENCES attachment(id) ON DELETE CASCADE,
  target_type   text NOT NULL CHECK (target_type IN ('FLOW', 'INVOICE', 'PROJECT', 'IMPORT')),
  target_id     bigint NOT NULL,
  PRIMARY KEY (attachment_id, target_type, target_id)
);
CREATE INDEX attachment_link_target_idx ON attachment_link(target_type, target_id);

CREATE TABLE import_batch (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_no       text NOT NULL UNIQUE,
  templates      text NOT NULL,
  file_names     text NOT NULL,
  parsed         jsonb NOT NULL,             -- 解析后的单元格数据，用于跳过某些行后重新校验
  skip_keys      jsonb NOT NULL DEFAULT '[]',
  result         jsonb,                      -- 最近一次校验 / 提交的逐行结果
  status         import_status NOT NULL DEFAULT 'VALIDATED',
  total_rows     int NOT NULL DEFAULT 0,
  committed_rows int NOT NULL DEFAULT 0,
  created_by     bigint NOT NULL REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  committed_at   timestamptz,
  rolled_back_at timestamptz,
  rolled_back_by bigint REFERENCES app_user(id)
);

-- -----------------------------------------------------------------------------
-- 资金流水（核心）
-- -----------------------------------------------------------------------------
CREATE SEQUENCE flow_no_seq;

CREATE TABLE flow (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flow_no          text NOT NULL UNIQUE,
  biz_date         date NOT NULL,
  amount           amount_pos NOT NULL,
  from_account_id  bigint NOT NULL REFERENCES account(id),
  to_account_id    bigint NOT NULL REFERENCES account(id),
  from_entity_id   bigint REFERENCES entity(id),   -- 由触发器根据账户带出
  to_entity_id     bigint REFERENCES entity(id),
  method           flow_method NOT NULL,
  book_summary     text,
  actual_purpose   text,
  purpose_mismatch boolean NOT NULL DEFAULT false,
  ic_nature        ic_nature,
  handler          text,
  bank_serial_no   text,
  invoice_nos      text[] NOT NULL DEFAULT '{}',
  status           flow_status NOT NULL DEFAULT 'CONFIRMED',
  reversal_reason  text,
  reversed_by      bigint REFERENCES app_user(id),
  reversed_at      timestamptz,
  import_batch_id  bigint REFERENCES import_batch(id),
  remark           text,
  created_by       bigint REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 0,
  CHECK (from_account_id <> to_account_id),
  CHECK ((status = 'CONFIRMED') = (reversed_at IS NULL))
);
CREATE INDEX flow_date_idx        ON flow(biz_date DESC, id DESC);
CREATE INDEX flow_from_idx        ON flow(from_account_id, biz_date);
CREATE INDEX flow_to_idx          ON flow(to_account_id, biz_date);
CREATE INDEX flow_batch_idx       ON flow(import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE UNIQUE INDEX flow_bank_serial_uq ON flow(from_account_id, bank_serial_no) WHERE bank_serial_no IS NOT NULL AND status = 'CONFIRMED';

CREATE TABLE flow_split (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flow_id     bigint NOT NULL REFERENCES flow(id),
  line_no     smallint NOT NULL,
  project_id  bigint NOT NULL REFERENCES project(id),
  category_id text NOT NULL REFERENCES category(id),
  amount      amount_pos NOT NULL,
  tax         tax_kind,
  tax_period  text CHECK (tax_period ~ '^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$'),
  UNIQUE (flow_id, line_no),
  CHECK ((tax IS NULL) = (tax_period IS NULL))
);
CREATE INDEX flow_split_project_idx ON flow_split(project_id);
CREATE TRIGGER flow_split_append_only BEFORE UPDATE OR DELETE ON flow_split FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- 分录：入账生成 2 条（转出 −、转入 +），冲销 / 撤销再生成相反 2 条；只追加
CREATE TABLE ledger_entry (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flow_id     bigint NOT NULL REFERENCES flow(id),
  account_id  bigint NOT NULL REFERENCES account(id),
  entry_date  date NOT NULL,
  amount      amount_any NOT NULL CHECK (amount <> 0),
  is_reversal boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entry_account_idx ON ledger_entry(account_id, entry_date);
CREATE INDEX ledger_entry_flow_idx ON ledger_entry(flow_id);
CREATE TRIGGER ledger_entry_append_only BEFORE UPDATE OR DELETE ON ledger_entry FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION ledger_entry_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO account_balance(account_id, balance, as_of) VALUES (NEW.account_id, NEW.amount, now())
  ON CONFLICT (account_id) DO UPDATE SET balance = account_balance.balance + EXCLUDED.balance, as_of = now();
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_entry_apply_trg AFTER INSERT ON ledger_entry FOR EACH ROW EXECUTE FUNCTION ledger_entry_apply();

-- 资金批次：流入溯源账户（REQUIRED / OPTIONAL）的每笔流水对应一个 lot，记录"这笔钱还剩多少没用"
CREATE TABLE fund_lot (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id       bigint NOT NULL REFERENCES account(id),
  source_flow_id   bigint NOT NULL UNIQUE REFERENCES flow(id),
  received_date    date NOT NULL,
  original_amount  amount_pos NOT NULL,
  remaining_amount amount_any NOT NULL,
  closed_at        timestamptz,
  CHECK (remaining_amount >= 0 AND remaining_amount <= original_amount)
);
CREATE INDEX fund_lot_open_idx ON fund_lot(account_id, received_date, id) WHERE remaining_amount > 0;

-- 出款的资金来源
CREATE TABLE flow_allocation (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  out_flow_id  bigint NOT NULL REFERENCES flow(id),
  lot_id       bigint NOT NULL REFERENCES fund_lot(id),
  amount       amount_pos NOT NULL,
  is_auto      boolean NOT NULL DEFAULT true,
  released_at  timestamptz,                   -- 出款冲销 / 撤销时释放，资金回到来源；不删除
  UNIQUE (out_flow_id, lot_id)
);
CREATE INDEX flow_allocation_lot_idx ON flow_allocation(lot_id) WHERE released_at IS NULL;
CREATE TRIGGER allocation_no_delete BEFORE DELETE ON flow_allocation FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- 外部账户（可选溯源）上无法追回的差额核销：不发生资金移动，只说明去向
CREATE TABLE lot_writeoff (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lot_id      bigint NOT NULL REFERENCES fund_lot(id),
  amount      amount_pos NOT NULL,
  category_id text NOT NULL REFERENCES category(id),
  reason      text NOT NULL,
  created_by  bigint REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER lot_writeoff_append_only BEFORE UPDATE OR DELETE ON lot_writeoff FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------- 流水触发器

CREATE FUNCTION flow_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT entity_id INTO NEW.from_entity_id FROM account WHERE id = NEW.from_account_id;
  SELECT entity_id INTO NEW.to_entity_id   FROM account WHERE id = NEW.to_account_id;
  IF NEW.status <> 'CONFIRMED' THEN RAISE EXCEPTION 'new flow must be CONFIRMED'; END IF;
  -- 两端是不同主体的对公账户 ⇔ 集团内往来，须标明性质
  IF (NEW.from_entity_id IS NOT NULL AND NEW.to_entity_id IS NOT NULL AND NEW.from_entity_id <> NEW.to_entity_id) <> (NEW.ic_nature IS NOT NULL) THEN
    RAISE EXCEPTION 'IC_NATURE: 集团内往来须且仅须填写往来性质（%）', NEW.flow_no;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER flow_before_insert_trg BEFORE INSERT ON flow FOR EACH ROW EXECUTE FUNCTION flow_before_insert();

-- 入账：生成分录；流入溯源账户时登记资金批次
CREATE FUNCTION flow_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ledger_entry(flow_id, account_id, entry_date, amount) VALUES
    (NEW.id, NEW.from_account_id, NEW.biz_date, -NEW.amount),
    (NEW.id, NEW.to_account_id,   NEW.biz_date,  NEW.amount);
  IF (SELECT trace FROM account WHERE id = NEW.to_account_id) <> 'NONE' THEN
    INSERT INTO fund_lot(account_id, source_flow_id, received_date, original_amount, remaining_amount)
    VALUES (NEW.to_account_id, NEW.id, NEW.biz_date, NEW.amount, NEW.amount);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER flow_after_insert_trg AFTER INSERT ON flow FOR EACH ROW EXECUTE FUNCTION flow_after_insert();

-- 已入账流水不可修改；只允许 CONFIRMED → REVERSED / VOIDED，以及备注、附件相关的非账务字段
CREATE FUNCTION flow_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'FLOW_IMMUTABLE: 流水 % 已%，不能再修改', OLD.flow_no, CASE OLD.status WHEN 'REVERSED' THEN '冲销' ELSE '撤销' END;
  END IF;
  IF (NEW.flow_no, NEW.biz_date, NEW.amount, NEW.from_account_id, NEW.to_account_id, NEW.method, NEW.ic_nature, NEW.import_batch_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.flow_no, OLD.biz_date, OLD.amount, OLD.from_account_id, OLD.to_account_id, OLD.method, OLD.ic_nature, OLD.import_batch_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'FLOW_IMMUTABLE: 流水 % 已入账，账务字段不能修改，请冲销后重录', OLD.flow_no;
  END IF;
  NEW.updated_at := now();
  NEW.version    := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER flow_guard_trg BEFORE UPDATE ON flow FOR EACH ROW EXECUTE FUNCTION flow_guard();
CREATE TRIGGER flow_no_delete BEFORE DELETE ON flow FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- 冲销 / 撤销：下游未处理时拒绝；释放本笔占用的来源；关闭本笔的资金批次；记反向分录（记在当天）
CREATE FUNCTION flow_after_unpost() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_used text;
  v_ents bigint[];
BEGIN
  SELECT string_agg(o.flow_no, '、') INTO v_used
    FROM fund_lot l
    JOIN flow_allocation a ON a.lot_id = l.id AND a.released_at IS NULL
    JOIN flow o ON o.id = a.out_flow_id
   WHERE l.source_flow_id = NEW.id AND o.id <> NEW.id;
  IF v_used IS NOT NULL THEN
    RAISE EXCEPTION 'HAS_DOWNSTREAM: 流水 % 已被 % 用作资金来源，请先冲销这些流水', NEW.flow_no, v_used;
  END IF;
  IF EXISTS (SELECT 1 FROM fund_lot l JOIN lot_writeoff w ON w.lot_id = l.id WHERE l.source_flow_id = NEW.id) THEN
    RAISE EXCEPTION 'HAS_DOWNSTREAM: 流水 % 已有差额核销记录，不能冲销', NEW.flow_no;
  END IF;

  SELECT array_agg(DISTINCT e) INTO v_ents FROM (
    SELECT NEW.from_entity_id AS e UNION SELECT NEW.to_entity_id
    UNION SELECT p.entity_id FROM flow_split s JOIN project p ON p.id = s.project_id WHERE s.flow_id = NEW.id) x WHERE e IS NOT NULL;
  PERFORM assert_period_open(v_ents, current_date);

  UPDATE flow_allocation SET released_at = now() WHERE out_flow_id = NEW.id AND released_at IS NULL;
  UPDATE fund_lot SET remaining_amount = 0, closed_at = now() WHERE source_flow_id = NEW.id;
  INSERT INTO ledger_entry(flow_id, account_id, entry_date, amount, is_reversal) VALUES
    (NEW.id, NEW.from_account_id, current_date,  NEW.amount, true),
    (NEW.id, NEW.to_account_id,   current_date, -NEW.amount, true);
  RETURN NULL;
END $$;
CREATE TRIGGER flow_after_unpost_trg AFTER UPDATE OF status ON flow
  FOR EACH ROW WHEN (OLD.status = 'CONFIRMED' AND NEW.status <> 'CONFIRMED') EXECUTE FUNCTION flow_after_unpost();

-- ---------- 分配触发器

CREATE FUNCTION allocation_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l fund_lot%ROWTYPE; f flow%ROWTYPE;
BEGIN
  SELECT * INTO l FROM fund_lot WHERE id = NEW.lot_id FOR UPDATE;
  SELECT * INTO f FROM flow WHERE id = NEW.out_flow_id;
  IF l.account_id <> f.from_account_id THEN
    RAISE EXCEPTION 'ALLOC_INVALID: 资金来源不是转入 % 转出账户的款项', f.flow_no;
  END IF;
  IF l.received_date > f.biz_date THEN
    RAISE EXCEPTION 'ALLOC_INVALID: % 的资金来源日期（%）晚于出款日期（%）', f.flow_no, l.received_date, f.biz_date;
  END IF;
  IF l.remaining_amount < NEW.amount THEN
    RAISE EXCEPTION 'ALLOC_INSUFFICIENT: % 的资金来源剩余 %，不足 %', f.flow_no, l.remaining_amount, NEW.amount;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER allocation_before_insert_trg BEFORE INSERT ON flow_allocation FOR EACH ROW EXECUTE FUNCTION allocation_before_insert();

CREATE FUNCTION allocation_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE fund_lot SET remaining_amount = remaining_amount - NEW.amount,
                        closed_at = CASE WHEN remaining_amount - NEW.amount = 0 THEN now() END
     WHERE id = NEW.lot_id;
  ELSE
    IF OLD.released_at IS NOT NULL OR NEW.amount <> OLD.amount OR NEW.lot_id <> OLD.lot_id OR NEW.out_flow_id <> OLD.out_flow_id OR NEW.released_at IS NULL THEN
      RAISE EXCEPTION 'allocation % can only be released once', OLD.id;
    END IF;
    UPDATE fund_lot SET remaining_amount = remaining_amount + OLD.amount, closed_at = NULL WHERE id = OLD.lot_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER allocation_apply_trg AFTER INSERT OR UPDATE ON flow_allocation FOR EACH ROW EXECUTE FUNCTION allocation_apply();

CREATE FUNCTION lot_writeoff_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_trace trace_mode;
BEGIN
  SELECT a.trace INTO v_trace FROM fund_lot l JOIN account a ON a.id = l.account_id WHERE l.id = NEW.lot_id;
  IF v_trace = 'REQUIRED' THEN
    -- 公户、个人卡、现金中的钱必须真实流出（如转入"损失核销"虚拟账户），不能凭空核销
    RAISE EXCEPTION 'WRITEOFF_INVALID: 公户、个人卡、现金中的余额不能直接核销，请录入一笔转出流水';
  END IF;
  UPDATE fund_lot SET remaining_amount = remaining_amount - NEW.amount,
                      closed_at = CASE WHEN remaining_amount - NEW.amount = 0 THEN now() END
   WHERE id = NEW.lot_id;
  RETURN NULL;
END $$;
CREATE TRIGGER lot_writeoff_apply_trg AFTER INSERT ON lot_writeoff FOR EACH ROW EXECUTE FUNCTION lot_writeoff_apply();

-- ---------- 提交前一致性校验（延迟约束触发器，应用层校验的最后防线）
--   1) 分摊合计 = 流水金额
--   2) 从强制溯源账户流出时，有效分配合计 = 流水金额
--   3) 流水涉及主体的期间未结账
CREATE FUNCTION flow_check_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  f       flow%ROWTYPE;
  v_id    bigint;
  v_split numeric;
  v_alloc numeric;
  v_trace trace_mode;
  v_ents  bigint[];
BEGIN
  v_id := COALESCE((to_jsonb(NEW) ->> 'flow_id')::bigint, (to_jsonb(NEW) ->> 'out_flow_id')::bigint, (to_jsonb(NEW) ->> 'id')::bigint);
  SELECT * INTO f FROM flow WHERE id = v_id;
  IF NOT FOUND OR f.status <> 'CONFIRMED' THEN RETURN NULL; END IF;

  SELECT COALESCE(sum(amount), 0) INTO v_split FROM flow_split WHERE flow_id = f.id;
  IF v_split <> f.amount THEN
    RAISE EXCEPTION 'SPLIT_MISMATCH: 流水 % 分摊合计 % 与金额 % 不一致', f.flow_no, v_split, f.amount;
  END IF;

  SELECT trace INTO v_trace FROM account WHERE id = f.from_account_id;
  IF v_trace = 'REQUIRED' THEN
    SELECT COALESCE(sum(amount), 0) INTO v_alloc FROM flow_allocation WHERE out_flow_id = f.id AND released_at IS NULL;
    IF v_alloc <> f.amount THEN
      RAISE EXCEPTION 'TRACE_REQUIRED: 流水 % 资金来源合计 % 与金额 % 不一致', f.flow_no, v_alloc, f.amount;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'flow' THEN
    SELECT array_agg(DISTINCT e) INTO v_ents FROM (
      SELECT f.from_entity_id AS e UNION SELECT f.to_entity_id
      UNION SELECT p.entity_id FROM flow_split s JOIN project p ON p.id = s.project_id WHERE s.flow_id = f.id) x WHERE e IS NOT NULL;
    PERFORM assert_period_open(v_ents, f.biz_date);
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER flow_consistency_on_flow AFTER INSERT ON flow
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION flow_check_consistency();
CREATE CONSTRAINT TRIGGER flow_consistency_on_split AFTER INSERT ON flow_split
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION flow_check_consistency();
CREATE CONSTRAINT TRIGGER flow_consistency_on_alloc AFTER INSERT ON flow_allocation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION flow_check_consistency();

-- -----------------------------------------------------------------------------
-- 发票
-- -----------------------------------------------------------------------------
CREATE TABLE invoice (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  direction       invoice_direction NOT NULL,
  type            invoice_type NOT NULL,
  invoice_no      text NOT NULL UNIQUE,
  issue_date      date NOT NULL,
  entity_id       bigint NOT NULL REFERENCES entity(id),
  project_id      bigint REFERENCES project(id),
  counterparty    text NOT NULL,
  amount_excl_tax amount_any NOT NULL,
  tax_rate        rate NOT NULL,
  tax_amount      amount_any NOT NULL,
  goods           text NOT NULL,
  remark          text,
  created_by      bigint REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 0
);
CREATE INDEX invoice_entity_idx ON invoice(entity_id, issue_date);
CREATE TRIGGER touch_invoice BEFORE UPDATE ON invoice FOR EACH ROW EXECUTE FUNCTION touch_row();

-- -----------------------------------------------------------------------------
-- 工资（个税由外部结算后导入，本系统只校验与记账）
-- -----------------------------------------------------------------------------
CREATE TABLE payroll_batch (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id       bigint NOT NULL REFERENCES entity(id),
  period          date NOT NULL CHECK (extract(day FROM period) = 1),
  seq             smallint NOT NULL,
  pay_account_id  bigint NOT NULL REFERENCES account(id),
  pay_date        date NOT NULL,
  import_batch_id bigint REFERENCES import_batch(id),
  created_by      bigint REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, period, seq)
);

CREATE TABLE payroll_item (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id         bigint NOT NULL REFERENCES payroll_batch(id),
  person           text NOT NULL,
  id_last4         text,
  gross            amount_any NOT NULL,
  si_personal      amount_any NOT NULL DEFAULT 0,
  hf_personal      amount_any NOT NULL DEFAULT 0,
  iit              amount_any NOT NULL DEFAULT 0,
  other_deduct     amount_any NOT NULL DEFAULT 0,
  net              amount_any NOT NULL,
  si_company       amount_any NOT NULL DEFAULT 0,
  hf_company       amount_any NOT NULL DEFAULT 0,
  payee_account_id bigint NOT NULL REFERENCES account(id),
  net_flow_id      bigint REFERENCES flow(id),
  CHECK (abs(gross - si_personal - hf_personal - iit - other_deduct - net) <= 0.01)
);
CREATE INDEX payroll_item_batch_idx ON payroll_item(batch_id);

-- -----------------------------------------------------------------------------
-- 审计
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  user_id     bigint REFERENCES app_user(id),
  username    text,
  ip          inet,
  action      text NOT NULL,
  target_type text NOT NULL,
  target_id   text,
  summary     text,
  detail      jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log(at DESC);
CREATE INDEX audit_log_target_idx ON audit_log(target_type, target_id);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- -----------------------------------------------------------------------------
-- 自检视图（结果应为空）
-- -----------------------------------------------------------------------------
CREATE VIEW v_check_balance AS
SELECT a.id AS account_id, a.name, COALESCE(b.balance, 0) AS cached, COALESCE(e.total, 0) AS ledger_total
  FROM account a
  LEFT JOIN account_balance b ON b.account_id = a.id
  LEFT JOIN (SELECT account_id, sum(amount) AS total FROM ledger_entry GROUP BY 1) e ON e.account_id = a.id
 WHERE COALESCE(b.balance, 0) <> COALESCE(e.total, 0);

CREATE VIEW v_check_lots AS
SELECT a.id AS account_id, a.name, COALESCE(b.balance, 0) AS balance, COALESCE(l.open_total, 0) AS lot_total
  FROM account a
  LEFT JOIN account_balance b ON b.account_id = a.id
  LEFT JOIN (SELECT account_id, sum(remaining_amount) AS open_total FROM fund_lot GROUP BY 1) l ON l.account_id = a.id
 WHERE a.trace = 'REQUIRED' AND COALESCE(b.balance, 0) <> COALESCE(l.open_total, 0);

CREATE VIEW v_check_allocation AS
SELECT f.id AS flow_id, f.flow_no, f.amount, COALESCE(sum(al.amount), 0) AS allocated
  FROM flow f
  JOIN account a ON a.id = f.from_account_id AND a.trace = 'REQUIRED'
  LEFT JOIN flow_allocation al ON al.out_flow_id = f.id AND al.released_at IS NULL
 WHERE f.status = 'CONFIRMED'
 GROUP BY f.id
HAVING COALESCE(sum(al.amount), 0) <> f.amount;
