import { sha } from './store.mjs';

const OWL = 'http://www.w3.org/2002/07/owl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const OMW = 'urn:omw:provenance:';
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ttlLiteral = s => '"' + String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '') + '"';
const iriAttr = v => /^https?:|^urn:/.test(v) ? `IRI="${esc(v)}"` : `abbreviatedIRI="${esc(v)}"`;
const shortXsd = v => 'xsd:' + String(v).split('#').pop();

/* 实例的身份靠主键。表结构里没声明主键时，旧写法拿「第一列」当键：
   明细表的第一个字段往往就是所属单据号，一单四条明细会全并成一个实例，
   看起来像「照片只读出一行」。现在的规则是——先找一列能唯一区分每行的
   当事实主键（通常就是单据号），一列都找不到就按整行哈希区分，
   宁可多出几个实例，也不把几行明细悄悄并成一条。 */
export function effectiveKeyColumns(cls, rows) {
  const declared = (cls?.primaryKey || []).filter(Boolean);
  if (declared.length) return declared;
  const cols = Object.keys((rows && rows[0]) || {});
  for (const c of cols) {
    const vals = (rows || []).map(r => String(r?.[c] ?? ''));
    if (vals.length && vals.every(v => v !== '') && new Set(vals).size === vals.length) return [c];
  }
  return [];
}

export function instanceKey(table, row, pk) {
  const cols = (pk || []).filter(Boolean);
  if (!cols.length) return sha(row).slice(0, 12);
  const parts = cols.map(k => row?.[k]);
  return String(parts.every(p => p != null) ? parts.join('~') : sha(row).slice(0, 12));
}

export function buildIndividuals(model) {
  const ns = model.namespace;
  const classByTable = new Map(model.classes.map(c => [c.sourceTable, c]));
  /* 每张表用哪几列当实例键，先算一遍：所有地方（建个体、连关系的两端）必须用同一套，
     否则主单能找到、明细找不到，边就悬空。 */
  const keyCols = new Map();
  const keysOf = table => {
    if (!keyCols.has(table)) {
      keyCols.set(table, effectiveKeyColumns(classByTable.get(table), model.rowsByTable[table] || []));
    }
    return keyCols.get(table);
  };
  const individuals = [];
  const individualByKey = new Map();
  for (const [table, rows] of Object.entries(model.rowsByTable)) {
    const cls = classByTable.get(table);
    if (!cls) continue;
    const cols = keysOf(table);
    for (const row of rows) {
      const key = instanceKey(table, row, cols);
      const id = 'instance/' + table + '/' + key;
      const iri = ns + encodeURIComponent(id);
      individualByKey.set(table + '|' + key, iri);
      individuals.push({
        id, iri, localName: String(row[cols[0]] || key), table, row,
        annotations: [],
        types: [cls.iri], sameAs: [], differentFrom: [],
        dataPropertyAssertions: model.dataProperties.filter(p => p.sourceTable === table && row[p.sourceColumn] != null && typeof row[p.sourceColumn] !== 'object')
          .map(p => ({ id: id + '::' + p.sourceColumn, propertyIRI: p.iri, value: String(row[p.sourceColumn]), datatype: p.range })),
        objectPropertyAssertions: []
      });
    }
  }
  for (const p of model.objectProperties) {
    /* 只有进本体的关系才能出现在实例断言里：未确认 / 已删除的关系不产出断言，
       否则实例层会引用一个没声明的属性（校验会报悬空引用）。 */
    if (p.status === 'rejected' || p.status === 'candidate') continue;
    if (!p.sourceTable || !p.refTable || !p.sourceColumns?.length) continue;
    const sourceRows = model.rowsByTable[p.sourceTable] || [];
    const targetCls = classByTable.get(p.refTable);
    const targetRows = model.rowsByTable[p.refTable] || [];
    const refCols = p.refColumns?.length ? p.refColumns : (targetCls?.primaryKey || []);
    if (!targetCls || !refCols.length) continue;
    const matchCache = new Map();
    for (const row of sourceRows) {
      const fromKey = instanceKey(p.sourceTable, row, keysOf(p.sourceTable));
      const fromIRI = individualByKey.get(p.sourceTable + '|' + fromKey);
      if (!fromIRI) continue;
      const wanted = p.sourceColumns.map(c => String(row[c] ?? ''));
      const cacheKey = wanted.join('~');
      let targetIRI = matchCache.get(cacheKey);
      if (targetIRI === undefined) {
        const hit = targetRows.find(t => refCols.every((c, i) => String(t[c] ?? '') === wanted[i]));
        targetIRI = hit ? individualByKey.get(p.refTable + '|' + instanceKey(p.refTable, hit, keysOf(p.refTable))) || null : null;
        matchCache.set(cacheKey, targetIRI);
      }
      if (!targetIRI) continue;
      const ind = individuals.find(x => x.iri === fromIRI);
      if (ind) ind.objectPropertyAssertions.push({ id: ind.id + '::' + p.id, propertyIRI: p.iri, targetIndividualIRI: targetIRI });
    }
  }
  return individuals;
}

export function toOwlJson(model, version) {
  const ns = model.namespace;
  /* 字段依据跟着关系进本体注释，读它的是人：把 t5_05236a.t5_05236a_f2 换成「结算表.合同编号」。
     认不出来的写法原样保留，不硬猜。 */
  const colName = new Map((model.dataProperties || []).map(d => [`${d.sourceTable}.${d.sourceColumn}`, d.localName]));
  const tblName = new Map((model.classes || []).map(c => [c.sourceTable, c.localName]));
  const humanFieldRef = ref => String(ref ?? '').replace(
    /([A-Za-z0-9_\u4e00-\u9fa5]+)[.．]([A-Za-z0-9_\u4e00-\u9fa5]+)/g,
    (whole, t, c) => { const label = colName.get(`${t}.${c}`); return label ? `${tblName.get(t) || t}.${label}` : whole; }
  );
  const annotations = c => [
    { id: c.id + '-label', property: 'rdfs:label', value: c.localName, language: 'zh' },
    ...(c.description ? [{ id: c.id + '-comment', property: 'rdfs:comment', value: c.description, language: 'zh' }] : []),
    ...(c.sourceRefs || []).map((r, i) => ({ id: c.id + '-src-' + i, property: OMW + 'sourceRef', value: [r.sourceName, r.locator].filter(Boolean).join(' · ') })),
    ...(c.notes ? [{ id: c.id + '-note', property: OMW + 'note', value: String(c.notes) }] : [])
  ];
  const individuals = buildIndividuals(model);
  return {
    id: model.id, iri: ns.slice(0, -1), versionIRI: ns + 'version/' + (version || model.version),
    annotations: [{ id: 'ont-name', property: 'rdfs:label', value: model.name, language: 'zh' }],
    namespaces: [{ prefix: 'omw', iri: ns }, { prefix: 'xsd', iri: XSD }, { prefix: 'rdfs', iri: RDFS }],
    classes: model.classes.filter(c => c.status !== 'rejected').map(c => ({
      id: c.id, iri: c.iri, localName: c.localName, annotations: annotations(c),
      superClassExpressions: c.parent ? [{ id: c.id + '-sup', type: 'namedClass', classIRI: ns + encodeURIComponent(c.parent) }] : [],
      equivalentClassExpressions: [], disjointWith: []
    })),
    /* 只有确认过的业务关系进本体；候选（如未被理解稿采纳的字段同名关系）不编译 */
    objectProperties: model.objectProperties
      .filter(p => p.status !== 'rejected' && p.status !== 'candidate')
      .map(p => ({
        id: p.id, iri: p.iri, localName: p.localName,
        annotations: [
          ...annotations(p),
          /* 业务含义单独留一条机器可读的注释：边名是「按订单收货」这种短语，
             一句话的业务解释放在这里，导出给别人时不用靠猜。 */
          ...(p.relationMeaning ? [{ id: p.id + '-means', property: OMW + 'businessMeaning', value: String(p.relationMeaning) }] : []),
          ...(p.relationBasis ? [{ id: p.id + '-basis', property: OMW + 'relationBasis', value: String(p.relationBasis) }] : []),
          ...(Array.isArray(p.relationVia) && p.relationVia.length
            ? [{ id: p.id + '-via', property: OMW + 'fieldMapping', value: p.relationVia.map(humanFieldRef).join('；') }] : [])
        ],
        superProperties: [], domains: p.domain ? [p.domain] : [], ranges: p.range ? [p.range] : [],
        characteristics: p.characteristics || [], inverseOf: null
      })),
    dataProperties: model.dataProperties.filter(p => p.status !== 'rejected').map(p => ({
      id: p.id, iri: p.iri, localName: p.localName, annotations: annotations(p),
      superProperties: [], domains: p.domain ? [p.domain] : [], ranges: [p.range],
      functional: !!p.isKey || !!p.required
    })),
    individuals: individuals.map(i => ({ ...i, annotations: [], dataPropertyAssertions: i.dataPropertyAssertions, objectPropertyAssertions: i.objectPropertyAssertions }))
  };
}

export function toOwlXml(o) {
  const ns = o.iri + '#';
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<Ontology xmlns="${OWL}" ontologyIRI="${esc(o.iri)}"${o.versionIRI ? ` versionIRI="${esc(o.versionIRI)}"` : ''}>`);
  for (const p of o.namespaces) out.push(`    <Prefix name="${esc(p.prefix)}" IRI="${esc(p.iri)}"/>`);
  out.push(`    <Prefix name="owl" IRI="${OWL}"/>`, `    <Prefix name="rdf" IRI="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>`);
  for (const a of o.annotations || []) out.push(annotationXml(o.iri, a));
  for (const c of o.classes) {
    out.push(`    <Declaration><Class IRI="${esc(c.iri)}"/></Declaration>`);
    for (const a of c.annotations) out.push(annotationXml(c.iri, a));
    for (const sup of c.superClassExpressions || []) out.push(`    <SubClassOf><Class IRI="${esc(c.iri)}"/><Class ${iriAttr(sup.classIRI || '')}/></SubClassOf>`);
  }
  for (const p of o.objectProperties) {
    out.push(`    <Declaration><ObjectProperty IRI="${esc(p.iri)}"/></Declaration>`);
    for (const a of p.annotations) out.push(annotationXml(p.iri, a));
    for (const d of p.domains) out.push(`    <ObjectPropertyDomain><ObjectProperty IRI="${esc(p.iri)}"/><Class ${iriAttr(d)}/></ObjectPropertyDomain>`);
    for (const r of p.ranges) out.push(`    <ObjectPropertyRange><ObjectProperty IRI="${esc(p.iri)}"/><Class ${iriAttr(r)}/></ObjectPropertyRange>`);
    for (const ch of p.characteristics || []) out.push(`    <${ch[0].toUpperCase() + ch.slice(1)}ObjectProperty><ObjectProperty IRI="${esc(p.iri)}"/></${ch[0].toUpperCase() + ch.slice(1)}ObjectProperty>`);
  }
  for (const p of o.dataProperties) {
    out.push(`    <Declaration><DataProperty IRI="${esc(p.iri)}"/></Declaration>`);
    for (const a of p.annotations) out.push(annotationXml(p.iri, a));
    for (const d of p.domains) out.push(`    <DataPropertyDomain><DataProperty IRI="${esc(p.iri)}"/><Class ${iriAttr(d)}/></DataPropertyDomain>`);
    for (const r of p.ranges) out.push(`    <DataPropertyRange><DataProperty IRI="${esc(p.iri)}"/><Datatype ${iriAttr(shortXsd(r))}/></DataPropertyRange>`);
    if (p.functional) out.push(`    <FunctionalDataProperty><DataProperty IRI="${esc(p.iri)}"/></FunctionalDataProperty>`);
  }
  for (const i of o.individuals) {
    out.push(`    <Declaration><NamedIndividual IRI="${esc(i.iri)}"/></Declaration>`);
    out.push(`    <ClassAssertion><Class ${iriAttr(i.types[0])}/><NamedIndividual IRI="${esc(i.iri)}"/></ClassAssertion>`);
    for (const a of i.dataPropertyAssertions) out.push(`    <DataPropertyAssertion><DataProperty IRI="${esc(a.propertyIRI)}"/><NamedIndividual IRI="${esc(i.iri)}"/><Literal datatypeIRI="${esc(a.datatype)}">${esc(a.value)}</Literal></DataPropertyAssertion>`);
    for (const a of i.objectPropertyAssertions) out.push(`    <ObjectPropertyAssertion><ObjectProperty IRI="${esc(a.propertyIRI)}"/><NamedIndividual IRI="${esc(i.iri)}"/><NamedIndividual IRI="${esc(a.targetIndividualIRI)}"/></ObjectPropertyAssertion>`);
  }
  out.push('</Ontology>');
  return out.join('\n') + '\n';
}
function annotationXml(subject, a) {
  const lang = a.language ? ` xml:lang="${esc(a.language)}"` : '';
  return `    <AnnotationAssertion><AnnotationProperty ${iriAttr(a.property)}/><IRI>${esc(subject)}</IRI><Literal${lang}>${esc(a.value)}</Literal></AnnotationAssertion>`;
}

export function toTurtle(o) {
  const I = v => '<' + v + '>';
  const L = [];
  L.push('@prefix omw: <' + o.iri + '#> .');
  L.push('@prefix owl: <' + OWL + '> .');
  L.push('@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .');
  L.push('@prefix rdfs: <' + RDFS + '> .');
  L.push('@prefix xsd: <' + XSD + '> .');
  L.push('@prefix prov: <' + OMW + '> .');
  L.push('', I(o.iri) + ' a owl:Ontology' + (o.versionIRI ? ' ; owl:versionIRI ' + I(o.versionIRI) : '') + ' .');
  L.push('', '# 类（对象类型）');
  for (const c of o.classes) {
    L.push(I(c.iri) + ' a owl:Class ; rdfs:label ' + ttlLiteral(c.localName) + '@zh' +
      (c.annotations.find(a => a.property.endsWith('comment')) ? ' ; rdfs:comment ' + ttlLiteral(c.annotations.find(a => a.property.endsWith('comment')).value) + '@zh' : '') +
      (c.superClassExpressions?.length ? ' ; rdfs:subClassOf ' + I(c.superClassExpressions[0].classIRI) : '') + ' .');
    for (const a of c.annotations.filter(a => a.property.startsWith('urn:omw'))) L.push(I(c.iri) + ' ' + I(a.property) + ' ' + ttlLiteral(a.value) + ' .');
  }
  L.push('', '# 对象属性（关系）');
  for (const p of o.objectProperties) L.push(I(p.iri) + ' a owl:ObjectProperty ; rdfs:label ' + ttlLiteral(p.localName) + '@zh' +
    (p.domains[0] ? ' ; rdfs:domain ' + I(p.domains[0]) : '') + (p.ranges[0] ? ' ; rdfs:range ' + I(p.ranges[0]) : '') + ' .');
  L.push('', '# 数据属性（字段）');
  for (const p of o.dataProperties) L.push(I(p.iri) + ' a owl:DatatypeProperty ; rdfs:label ' + ttlLiteral(p.localName) + '@zh' +
    (p.domains[0] ? ' ; rdfs:domain ' + I(p.domains[0]) : '') + ' ; rdfs:range ' + I(p.ranges[0]) +
    (p.functional ? ' ; a owl:FunctionalProperty' : '') + ' .');
  L.push('', '# 实例（来自样例数据，与本体定义分通道管理）');
  for (const i of o.individuals) {
    const parts = ['a ' + I(i.types[0])];
    for (const a of i.dataPropertyAssertions) parts.push(I(a.propertyIRI) + ' ' + ttlLiteral(a.value));
    for (const a of i.objectPropertyAssertions) parts.push(I(a.propertyIRI) + ' ' + I(a.targetIndividualIRI));
    L.push(I(i.iri) + ' ' + parts.join(' ; ') + ' .');
  }
  return L.join('\n') + '\n';
}
