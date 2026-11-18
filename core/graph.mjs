const CSV_ESC = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const csv = (headers, rows) => [headers.join(','), ...rows.map(r => r.map(CSV_ESC).join(','))].join('\n') + '\n';

/* 草稿图谱：理解稿一出稿就画出来，不经过 OWL。
   节点是业务对象，边是业务关系（「订单 包含 物料」），不是字段映射。
   边带 status：candidate 待确认 / confirmed 已保留 / rejected 已删除（不画）。 */
export function draftGraph(model, understanding) {
  const nodes = (model.classes || []).filter(c => c.status !== 'rejected').map(c => ({
    data: {
      id: c.id, label: c.localName, kind: 'class', draft: true,
      role: c.role || '', meaning: c.businessMeaning || c.description || '',
      table: c.sourceTable
    },
    classes: 'class-node draft-node'
  }));
  const byTable = new Map((model.classes || []).map(c => [c.sourceTable, c]));
  const edges = (understanding?.relations || [])
    .filter(r => r.status !== 'rejected')
    .map(r => {
      const from = byTable.get(r.subject), to = byTable.get(r.object);
      if (!from || !to) return null;
      return {
        data: {
          id: 'ea:' + r.id, relationId: r.id, source: from.id, target: to.id,
          label: r.predicate, status: r.status || 'candidate',
          via: r.via || [], basis: r.basis || '', confidence: r.confidence || 'medium',
          draft: true
        },
        classes: 'relation-edge draft-edge' + (r.status === 'candidate' ? ' pending-edge' : '')
      };
    })
    .filter(Boolean);
  return {
    mode: 'draft',
    elements: [...nodes, ...edges],
    stats: {
      nodes: nodes.length, edges: edges.length,
      pending: edges.filter(e => e.data.status === 'candidate').length,
      confirmed: edges.filter(e => e.data.status === 'confirmed').length
    }
  };
}

export function schemaGraph(owl) {
  const nodes = owl.classes.map(c => ({
    data: { id: c.iri, label: c.localName, kind: 'class', iri: c.iri },
    classes: 'class-node'
  }));
  const edges = owl.objectProperties.filter(p => p.domains[0] && p.ranges[0]).map(p => ({
    data: { id: 'edge:' + p.id, source: p.domains[0], target: p.ranges[0], label: p.localName, iri: p.iri },
    classes: 'relation-edge'
  }));
  return { elements: [...nodes, ...edges], stats: { nodes: nodes.length, edges: edges.length, pending: 0 } };
}

/** 编译后的逻辑图要带得出「这条关系算不算数」。
    两件事一起干：
    1. 已经进 OWL 的边标成 objectProperty + 各自状态（不然编译完一片灰，看不出哪条是自己认过的）；
    2. 没进 OWL 的候选关系补画成虚线——候选不该进发布产物，但也不该从图上消失，
       用户要靠这些虚线看见该改哪条、改成业务动作再回写。以前编译一次边就全没了，
       看着像「关系丢了」，其实是画不出来。 */
export function decorateSchemaEdges(graph, canonical, understanding) {
  const statusByIri = new Map((canonical?.objectProperties || []).map(p => [p.iri, p.status || 'confirmed']));
  for (const e of graph.elements) {
    if (!e.data?.source || !e.data?.target) continue;
    e.data.kind = 'objectProperty';
    e.data.status = statusByIri.get(e.data.iri) || 'confirmed';
  }
  const rels = (understanding?.relations || []).filter(r => r && r.status !== 'rejected' && r.status !== 'confirmed');
  if (!rels.length) return graph;
  const iriByTable = new Map((canonical?.classes || []).filter(c => c.sourceTable && c.iri).map(c => [c.sourceTable, c.iri]));
  const nodeIds = new Set(graph.elements.filter(e => !e.data?.source).map(e => e.data.id));
  const drawn = new Set(graph.elements.filter(e => e.data?.source && e.data?.target).map(e => e.data.source + '|' + e.data.target));
  for (const r of rels) {
    const from = iriByTable.get(r.subject), to = iriByTable.get(r.object);
    if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to)) continue;
    if (drawn.has(from + '|' + to)) continue;
    drawn.add(from + '|' + to);
    graph.elements.push({
      data: {
        id: 'pend:' + r.id, relationId: r.id, source: from, target: to,
        kind: 'objectProperty', label: r.predicate, status: 'candidate', pending: true,
        via: r.via || [], basis: r.basis || '', meaning: r.meaning || ''
      },
      classes: 'relation-edge pending-edge'
    });
    graph.stats.edges += 1;
    graph.stats.pending = (graph.stats.pending || 0) + 1;
  }
  return graph;
}

export function instanceGraph(owl) {
  const nodes = owl.individuals.map(i => ({
    data: {
      id: i.iri, label: i.localName, kind: 'instance',
      type: owl.classes.find(c => c.iri === i.types[0])?.localName || '实例',
      fields: i.dataPropertyAssertions.length
    }, classes: 'instance-node'
  }));
  const known = new Set(nodes.map(n => n.data.id));
  const edges = owl.individuals.flatMap(i => i.objectPropertyAssertions.filter(a => known.has(a.targetIndividualIRI)).map(a => ({
    data: {
      id: 'edge:' + a.id, source: i.iri, target: a.targetIndividualIRI,
      label: owl.objectProperties.find(p => p.iri === a.propertyIRI)?.localName || '关联'
    }, classes: 'instance-edge'
  })));
  return { elements: [...nodes, ...edges], stats: { nodes: nodes.length, edges: edges.length } };
}

export function toTriples(owl) {
  const I = v => '<' + v + '>';
  const lit = v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const T = [];
  const rdfType = I('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
  const owlClass = I('http://www.w3.org/2002/07/owl#Class');
  const objProp = I('http://www.w3.org/2002/07/owl#ObjectProperty');
  const dataProp = I('http://www.w3.org/2002/07/owl#DatatypeProperty');
  const namedInd = I('http://www.w3.org/2002/07/owl#NamedIndividual');
  const label = I('http://www.w3.org/2000/01/rdf-schema#label');
  for (const c of owl.classes) { T.push(`${I(c.iri)} ${rdfType} ${owlClass} .`); T.push(`${I(c.iri)} ${label} ${lit(c.localName)}@zh .`); }
  for (const p of owl.objectProperties) {
    T.push(`${I(p.iri)} ${rdfType} ${objProp} .`);
    if (p.domains[0]) T.push(`${I(p.iri)} ${I('http://www.w3.org/2000/01/rdf-schema#domain')} ${I(p.domains[0])} .`);
    if (p.ranges[0]) T.push(`${I(p.iri)} ${I('http://www.w3.org/2000/01/rdf-schema#range')} ${I(p.ranges[0])} .`);
  }
  for (const p of owl.dataProperties) {
    T.push(`${I(p.iri)} ${rdfType} ${dataProp} .`);
    if (p.domains[0]) T.push(`${I(p.iri)} ${I('http://www.w3.org/2000/01/rdf-schema#domain')} ${I(p.domains[0])} .`);
    T.push(`${I(p.iri)} ${I('http://www.w3.org/2000/01/rdf-schema#range')} ${I(p.ranges[0])} .`);
  }
  for (const i of owl.individuals) {
    T.push(`${I(i.iri)} ${rdfType} ${I(i.types[0])} .`);
    T.push(`${I(i.iri)} ${rdfType} ${namedInd} .`);
    for (const a of i.dataPropertyAssertions) T.push(`${I(i.iri)} ${I(a.propertyIRI)} ${lit(a.value)} .`);
    for (const a of i.objectPropertyAssertions) T.push(`${I(i.iri)} ${I(a.propertyIRI)} ${I(a.targetIndividualIRI)} .`);
  }
  return T.join('\n') + '\n';
}

export function platformPackage(owl) {
  const classId = new Map(owl.classes.map(c => [c.iri, c.id]));
  const entityTypes = csv(['type_id', 'label', 'iri', 'annotation'], owl.classes.map(c => [c.id, c.localName, c.iri, c.annotations.find(a => a.property.endsWith('comment'))?.value || '']));
  const relationTypes = csv(['relation_id', 'label', 'from_type', 'to_type', 'iri'],
    owl.objectProperties.map(p => [p.id, p.localName, classId.get(p.domains[0]) || '', classId.get(p.ranges[0]) || '', p.iri]));
  const entities = csv(['entity_id', 'type', 'label', 'properties_json', 'iri'],
    owl.individuals.map(i => [i.id.split('/').pop(), classId.get(i.types[0]) || '', i.localName,
      JSON.stringify(Object.fromEntries(i.dataPropertyAssertions.map(a => [a.propertyIRI.split('#').pop(), a.value]))), i.iri]));
  const relations = csv(['relation_id', 'from_entity', 'to_entity', 'relation_iri'],
    owl.individuals.flatMap(i => i.objectPropertyAssertions.map(a => [a.id, i.iri, a.targetIndividualIRI, a.propertyIRI])));
  return {
    'platform-entity_types.csv': entityTypes, 'platform-relation_types.csv': relationTypes,
    'platform-entities.csv': entities, 'platform-relations.csv': relations,
    'platform-manifest.json': JSON.stringify({
      format: 'omw.property-graph/1.0', ontologyIRI: owl.iri, versionIRI: owl.versionIRI,
      counts: { entityTypes: owl.classes.length, relationTypes: owl.objectProperties.length, entities: owl.individuals.length, relations: owl.individuals.reduce((n, i) => n + i.objectPropertyAssertions.length, 0) },
      note: '属性图平台适配输出。OWL/XML 与 Turtle 为权威本体源，本目录只用于导入展示。'
    }, null, 2)
  };
}

export function buildGraphBundle(model, owl) {
  const schema = schemaGraph(owl), instance = instanceGraph(owl), pkg = platformPackage(owl);
  return {
    graph: { schema, instance },
    files: { 'graph.json': JSON.stringify({ schema, instance }, null, 2), 'triples.nt': toTriples(owl), ...pkg },
    platformFileCount: Object.keys(pkg).length,
    stats: {
      schemaNodes: schema.stats.nodes, schemaEdges: schema.stats.edges,
      instanceNodes: instance.stats.nodes, instanceEdges: instance.stats.edges,
      triples: toTriples(owl).trim().split('\n').length,
      platformFiles: Object.keys(pkg).length
    }
  };
}
