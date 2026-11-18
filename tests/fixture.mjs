/* 仅测试用的领域无关最小夹具：在脚本内临时构造，不预置任何业务数据、不进产品运行逻辑。
   用户提供的真实表格只通过外部路径参数 TEST_FIXTURE_XLSX 追加回归，不复制进工程。 */
import { readFileSync } from 'node:fs';

export function makeFixture() {
  const dictionary = {
    purpose: '测试夹具（脚本内生成，非业务数据）',
    tables: [
      {
        name: 'entity_master', label: '对象主表', description: '测试用主数据',
        fields: [
          { name: 'entity_id', type: 'TEXT', required: true, key: 'PK', description: '对象标识' },
          { name: 'entity_name', type: 'TEXT', required: true, description: '名称' },
          { name: 'category', type: 'TEXT', description: '类别' },
          { name: 'status', type: 'TEXT', description: '状态' },
          { name: 'created_on', type: 'DATE', description: '创建日期' }
        ],
        primary_key: ['entity_id'], foreign_keys: [],
        rows: [
          { entity_id: 'E001', entity_name: '对象甲', category: 'A', status: 'ACTIVE', created_on: '2026-01-01' },
          { entity_id: 'E002', entity_name: '对象乙', category: 'B', status: 'ACTIVE', created_on: '2026-01-02' }
        ]
      },
      {
        name: 'event_log', label: '事件表', description: '测试用事件',
        fields: [
          { name: 'event_id', type: 'TEXT', required: true, key: 'PK', description: '事件号' },
          { name: 'entity_id', type: 'TEXT', required: true, description: '对象标识' },
          { name: 'occurred_at', type: 'DATETIME', description: '发生时间' },
          { name: 'amount', type: 'DECIMAL', description: '数值' },
          { name: 'state', type: 'TEXT', description: '状态' }
        ],
        primary_key: ['event_id'],
        foreign_keys: [['entity_id', 'entity_master', 'entity_id']],
        rows: [
          { event_id: 'V001', entity_id: 'E001', occurred_at: '2026-02-01T09:00:00+08:00', amount: '100.00', state: 'DONE' },
          { event_id: 'V002', entity_id: 'E002', occurred_at: '2026-02-02T09:00:00+08:00', amount: '200.00', state: 'DONE' }
        ]
      },
      {
        name: 'detail_line', label: '明细表', description: '测试用明细',
        fields: [
          { name: 'line_id', type: 'TEXT', required: true, key: 'PK', description: '明细号' },
          { name: 'event_id', type: 'TEXT', required: true, description: '事件号' },
          { name: 'entity_id', type: 'TEXT', description: '对象标识' },
          { name: 'code', type: 'TEXT', description: '编码' },
          { name: 'value', type: 'DECIMAL', description: '值' }
        ],
        primary_key: ['line_id'],
        foreign_keys: [['event_id', 'event_log', 'event_id'], ['entity_id', 'entity_master', 'entity_id']],
        rows: [
          { line_id: 'L001', event_id: 'V001', entity_id: 'E001', code: 'X1', value: '10.5' },
          { line_id: 'L002', event_id: 'V002', entity_id: 'E002', code: 'X2', value: '20.5' }
        ]
      }
    ]
  };
  const ddl = [
    'CREATE TABLE "entity_master" (',
    '  "entity_id" TEXT NOT NULL,',
    '  "entity_name" TEXT NOT NULL,',
    '  "category" TEXT,',
    '  "status" TEXT,',
    '  "created_on" DATE,',
    '  PRIMARY KEY ("entity_id")',
    ');',
    'CREATE TABLE "event_log" (',
    '  "event_id" TEXT NOT NULL,',
    '  "entity_id" TEXT NOT NULL,',
    '  "occurred_at" DATETIME,',
    '  "amount" DECIMAL,',
    '  "state" TEXT,',
    '  PRIMARY KEY ("event_id"),',
    '  FOREIGN KEY ("entity_id") REFERENCES "entity_master" ("entity_id")',
    ');',
    'CREATE TABLE "detail_line" (',
    '  "line_id" TEXT NOT NULL,',
    '  "event_id" TEXT NOT NULL,',
    '  "entity_id" TEXT,',
    '  "code" TEXT,',
    '  "value" DECIMAL,',
    '  PRIMARY KEY ("line_id"),',
    '  FOREIGN KEY ("event_id") REFERENCES "event_log" ("event_id"),',
    '  FOREIGN KEY ("entity_id") REFERENCES "entity_master" ("entity_id")',
    ');'
  ].join('\n');
  const description = [
    '案例对象：对象主表、事件表、明细表。',
    '案例属性：对象主表的对象标识、名称、创建日期；事件表的事件号、发生时间、数值、状态。',
    '判断条件：事件发生时间应晚于对象创建日期。',
    '资料不足：对象标识未核验或关联不唯一时列为资料不足。'
  ].join('\n');
  return {
    files: [
      { name: 'fixture-dictionary.json', content: JSON.stringify(dictionary), type: 'dictionary' },
      { name: 'fixture-schema.sql', content: ddl, type: 'ddl' },
      { name: 'fixture-description.txt', content: description, type: 'process' }
    ],
    description
  };
}

/** B 批测试用的手工建模输入（领域无关，模拟业务用户在表单里逐表填写） */
export function manualUnderstandingInput() {
  return {
    tables: [
      { table: 'entity_master', role: 'master', meaning: '被反复引用的基础对象', logic: '作为其他记录的主数据来源', stage: '准备' },
      { table: 'event_log', role: 'event', meaning: '业务发生的一次事件', logic: '记录发生时间、数值与状态', stage: '发生' },
      { table: 'detail_line', role: 'bridge', meaning: '事件的明细行', logic: '把事件与主数据关联起来', stage: '发生' }
    ],
    stages: [
      { order: 1, name: '准备', tableRefs: ['entity_master'] },
      { order: 2, name: '发生', tableRefs: ['event_log', 'detail_line'] }
    ]
  };
}

/** 外部测试夹具：只按环境变量读取，不写死路径、不复制文件 */
export function externalWorkbookFiles() {
  const p = process.env.TEST_FIXTURE_XLSX;
  if (!p) return null;
  try { return [{ name: '外部测试夹具.xlsx', content: readFileSync(p).toString('base64'), encoding: 'base64' }]; }
  catch { return null; }
}
