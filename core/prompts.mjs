/* 大模型位置一：理解业务链路。只描述材料里读到的东西，不写「标准流程应该是什么」。 */
const UNDERSTANDING_RULES = [
  '严格区分「材料明示」与「模型推断」；推断单列进 uncertainties，标 low 置信度并写明依据。',
  '每张表必须给出业务角色（master / event / bridge / evidence / result / snapshot）、一句话业务含义、背后的业务逻辑、所属链路阶段。',
  '链路阶段按材料里能读到的顺序排列；不要把倒序、并行、跳过纠正成常识里的标准流程，差异写进 uncertainties。',
  '链路还原依赖哪些组件关联，必须写明源表、目标表、关联字段；字段必须来自已上传材料。',
  'relations 里每条边必须是业务关系：主语宾语是业务对象，predicate 必须写成能读出业务动作的短语（如 按订单收货 / 按发票结算 / 由供应商履约 / 按批次质检）。',
  '禁止用 属于 / 包含 / 关联 / 依据 / 对应 这类通用词单独当关系名——它读不出业务上在做什么事；通用词后面必须补上具体动作或业务条件。',
  '每条关系的 meaning 必须写清业务含义：什么动作、在什么条件下成立、约束了什么（一句话，≤60 字）。例如「入库按采购订单的到货批次逐批验收，累计入库量不得超过订单未入库量」。',
  '禁止把字段映射当成关系：不要输出「物料编码 → 物料编码」「fk_xxx」「表名_字段名」这类名字；字段对应关系放进 via 数组，作为该业务关系的支撑字段。',
  'relations 不能为空：只要两张表之间存在材料能证明的业务依赖，就必须在 relations 里给出一条边，写不出业务动作时 predicate 写「待确认关系」并标 confidence=low，交给业务用户在图谱上改。',
  'idDependencies 只是字段级依赖的备查记录，不能用它替代 relations：每条 idDependencies 都应该有一条对应的 relations 边。',
  '只画业务上真实存在的关系；确实怀疑但不确信的关系，写进 relations 并标 low、同时在 uncertainties 里说明理由。不要用同名字段硬凑出一条业务关系。',
  '缺口分三类上报：该补字段 / 该补表 / 该补来源；不自行补业务概念。',
  '只输出规定的 JSON；不得生成 OWL/XML、Turtle、SQL 或平台导入格式；格式与规则由确定性代码编译。',
  '所有结论带 sourceRefs，只能引用「可引用的材料片段」里的 id 或原文定位；无法定位时标 verified=false。',
  '提示词与输出中不得出现任何示例业务表名、字段名或行业术语；示例一律用「表 A / 字段 x」。'
].join('\n');

const COMMON = [
  '只输出规定的 JSON，不输出解释文字、Markdown 或代码围栏。',
  '每条结论必须带 sourceRefs，引用材料片段 id 或原文定位；无法定位时标 verified=false，禁止编造出处。',
  '每条结论带 confidence（high/medium/low）；依据不足一律标 low 并写入 notes。',
  '禁止用常识补全材料中不存在的业务对象、字段或关系；禁止输出实例数据。',
  '两份材料说法不一致时写入 conflicts 上报，禁止自行挑选一个口径。',
  '不得生成 OWL/XML、Turtle 或平台导入格式；格式生成由确定性代码完成。'
].join('\n');

export const PROMPTS = {
  contract: {
    classes: [{ table: '表名', label: '业务对象名', parent: '父类表名或空', description: '业务定义', sourceRefs: ['片段id'], confidence: 'high|medium|low' }],
    relations: [{ from: '源表或对象', to: '目标表或对象', label: '业务关系动词', cardinality: '可选', description: '', sourceRefs: [], confidence: '' }],
    constraints: [{ kind: 'businessRule', target: '适用对象', text: '原文规则描述', sourceRefs: [] }],
    glossary: [{ term: '业务术语', definition: '口径', sourceRefs: [] }],
    conflicts: [{ subject: '冲突对象', claims: ['口径A', '口径B'], note: '差异说明' }]
  },
  understandingRules: UNDERSTANDING_RULES,
  understandingSystem: [
    '你是企业业务链路理解助手。根据上传的表结构、字段说明、少量样例行与业务描述，',
    '还原「这批表在讲什么业务、业务链路分几个阶段、阶段靠哪些字段串起来、还缺什么」，输出一张供业务用户整稿确认的理解稿。',
    UNDERSTANDING_RULES
  ].join('\n'),
  workstations: [
    { id: 'ws-schema', name: '表结构解析', goal: '把表结构映射为业务对象与属性，区分实体表与关联表，识别主键口径' },
    { id: 'ws-process', name: '业务流程解析', goal: '从业务描述抽取事件、角色、状态流转、判断规则与例外条件' },
    { id: 'ws-timing', name: '流程时序解析', goal: '抽取事件时间锚点、观测顺序与基线差异，禁止按常识纠正顺序' },
    { id: 'ws-align', name: '对齐与去重', goal: '跨材料合并同义概念，识别命名与粒度差异，产出冲突清单' },
    { id: 'ws-selfcheck', name: '自检', goal: '核查覆盖与缺项，只输出缺项，不重复生成结论' }
  ],
  commonRules: COMMON,
  /* 时序工位独立规约：模型只描述材料里观测到的东西，不写「标准流程应该是什么」 */
  timingRules: [
    '严格区分「材料明示」与「模型推断」：推断必须单列、标 low 置信度、写明依据，不得混入事实。',
    '每个事件必须给出时间锚点字段与状态字段（来自已上传表结构），不允许只写自然语言描述。',
    '输出「观测顺序与基线顺序不一致之处」，而不是输出常识里的标准流程。禁止把倒序、并行、跳过、回头补录纠正成常规顺序。',
    '对每处差异给出材料证据（原文定位、时间字段原始值、状态枚举），并给出「系统理解」候选解释，标注这不是事实认定。',
    '差异只上报，不自行择一；不输出可执行规则表达式、OWL 或平台格式，格式与规则由确定性代码编译。',
    '时间精度不足以判断先后时，必须列为资料不足，不得落入相等或不等的二值结论。'
  ].join('\n'),
  system: [
    '你是企业本体建模助手。根据上传的表结构、样例数据与业务描述，提出精简的类、类层级、业务关系与业务规则。',
    '输出一个 JSON 对象，顶层只允许 classes、relations、constraints、glossary、conflicts 五个数组；字段形状见「输出契约」示例。',
    'classes.table 必须来自已上传的表名；relations.from / relations.to 必须是已上传表名或 classes.label；sourceRefs 只能引用「可引用的流程片段」里的 id。',
    '自然语言规则只写进 constraints.text，不要伪造可执行公理；不要在关系上编造 cardinality 或 characteristics，除非原文明确写出。',
    COMMON
  ].join('\n')
};

/** 理解稿的输入：表结构 + 少量样例值摘要 + 可引用片段，全部领域无关 */
export function buildUnderstandingMessages({ description = '', tables = [], samples = {}, segments = [], contract }) {
  return [
    { role: 'system', content: PROMPTS.understandingSystem },
    {
      role: 'user', content: JSON.stringify({
        业务描述: description || '',
        表结构: tables.map(t => ({
          name: t.name, label: t.label, description: t.description || '',
          fields: (t.fields || []).map(f => ({ name: f.name, label: f.label || '', type: f.type, required: !!f.required, description: f.description || '' })),
          primaryKey: t.primaryKey || [], foreignKeys: t.foreignKeys || []
        })),
        样例值摘要: samples,
        可引用的材料片段: segments.map(s => ({ id: s.id, heading: s.heading, text: String(s.text || '').slice(0, 800) })),
        输出契约: contract
      })
    }
  ];
}

/* ---- 分批生成用的两个子契约 ----
   表多的时候一次性写完理解稿会超出输出上限，拆成「逐表写含义」+「整体画关系」两段。
   两段都只用领域无关的通用表名，输出体积各自可控。 */
export const TABLES_ONLY_CONTRACT = {
  tables: [{ table: '表名（必须是本轮给定表之一）', role: 'master|event|bridge|evidence|result|snapshot', meaning: '一句话业务含义', logic: '背后的业务逻辑', stage: '所属链路阶段', sourceRefs: ['片段id'], confidence: 'high|medium|low' }]
};

export const GRAPH_ONLY_CONTRACT = {
  stages: [{ order: 1, name: '阶段名', events: ['事件'], tableRefs: ['表名'], sourceRefs: ['片段id'] }],
  relations: [{
    subject: '源业务对象（表名）',
    predicate: '业务动作短语（动宾，如 按订单收货 / 按发票结算 / 由供应商履约），禁止只写 属于/包含/关联/依据',
    object: '目标业务对象（表名）',
    meaning: '这条关系的业务含义：什么动作、什么条件下成立、约束了什么（一句话，≤60 字）',
    via: ['支撑字段'], cardinality: '1:1|1:N|N:1|N:N', basis: '依据', confidence: 'high|medium|low'
  }],
  idDependencies: [{ from: '源表', to: '目标表', fields: ['关联字段'], status: 'candidate' }],
  gaps: [{ subject: '缺口对象', kind: 'field|table|source', note: '说明' }],
  uncertainties: [{ subject: '对象', text: '推断内容与依据' }]
};

/** 第一段：只给表含义。part/total 用于告诉模型这是第几批，避免它去写别的表 */
export function buildUnderstandingTablesMessages({ description = '', tables = [], samples = {}, segments = [], part = 1, total = 1 }) {
  return [
    { role: 'system', content: PROMPTS.understandingSystem },
    {
      role: 'user', content: JSON.stringify({
        说明: total > 1 ? `本批是第 ${part}/${total} 批。只为本批给定的这几张表写理解，不要写其它表。` : '为给定的表写理解。',
        业务描述: description || '',
        本批表结构: tables.map(t => ({
          name: t.name, label: t.label, description: t.description || '',
          fields: (t.fields || []).map(f => ({ name: f.name, label: f.label || '', type: f.type, required: !!f.required, description: f.description || '' })),
          primaryKey: t.primaryKey || [], foreignKeys: t.foreignKeys || []
        })),
        样例值摘要: samples,
        可引用的材料片段: segments.map(s => ({ id: s.id, heading: s.heading, text: String(s.text || '').slice(0, 500) })),
        输出契约: TABLES_ONLY_CONTRACT
      })
    }
  ];
}

/** 第二段：只画链路与业务关系。表结构压成摘要（名称+含义+主外键），输出体积小一个量级 */
export function buildUnderstandingGraphMessages({ description = '', tables = [], segments = [] }) {
  return [
    { role: 'system', content: PROMPTS.understandingSystem },
    {
      role: 'user', content: JSON.stringify({
        说明: '这次只要链路阶段、业务关系、ID 依赖与缺口，不要重复写表的含义。',
        业务描述: description || '',
        表摘要: tables.map(t => ({
          name: t.name, label: t.label, meaning: t.meaning || '', stage: t.stage || '',
          primaryKey: t.primaryKey || [], foreignKeys: t.foreignKeys || []
        })),
        可引用的材料片段: segments.map(s => ({ id: s.id, heading: s.heading, text: String(s.text || '').slice(0, 500) })),
        输出契约: GRAPH_ONLY_CONTRACT
      })
    }
  ];
}

export function buildMessages({ description, tables, segments, contract }) {
  return [
    { role: 'system', content: PROMPTS.system },
    {
      role: 'user', content: JSON.stringify({
        业务描述: description || '',
        表结构: tables.map(t => ({ name: t.name, label: t.label, columns: t.fields.map(f => f.name), primaryKey: t.primaryKey, foreignKeys: t.foreignKeys })),
        可引用的流程片段: segments.map(s => ({ id: s.id, heading: s.heading, text: String(s.text || '').slice(0, 1200) })),
        输出契约: contract
      })
    }
  ];
}

/* 大模型位置三：规则设立。输入是「客户文档 + 图谱口径」，输出是规则语义，不是 SQL。 */
/* 大模型位置三：规则设立。输入是「客户文档 + 图谱口径」，输出是规则语义，不是 SQL。
   exclude：已经生成过的审查点。规则条数一多，一次写不完（输出上限），
   续写时把这些名字带上，模型就只补没覆盖的审查点，不会把整份清单重写一遍。 */
export function buildRuleMessages({ document = '', graph = {}, contract, rules, exclude = [] }) {
  const done = (Array.isArray(exclude) ? exclude : []).filter(Boolean);
  return [
    {
      role: 'system', content: [
        '你是企业业务审查规则的分析助手。根据客户提供的制度/条款文档，以及已经确认的业务本体图谱口径，',
        '把文档里的审查要求翻译成机器可判定的规则语义：查哪个业务对象的哪些字段、和谁比、什么情况算命中。',
        rules,
        done.length ? '这是一次续写：只输出文档里尚未被覆盖的审查点，已覆盖的不要重复输出。' : ''
      ].filter(Boolean).join('\n')
    },
    {
      role: 'user', content: JSON.stringify({
        审查依据文档: String(document || '').slice(0, 12000),
        ...(done.length ? { 已覆盖的审查点: done.slice(0, 80) } : {}),
        图谱口径: {
          业务对象: (graph.tables || []).map(t => ({
            table: t.table, label: t.label, role: t.role || '', meaning: t.meaning || '',
            fields: (t.fields || []).map(f => ({ column: f.column, label: f.label, type: f.type || '' }))
          })),
          业务关系: (graph.relations || []).map(r => ({ subject: r.subject, predicate: r.predicate, object: r.object, via: r.via || [] }))
        },
        输出契约: contract
      })
    }
  ];
}
