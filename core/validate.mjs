import { sha } from './store.mjs';

const XSD_TYPES = new Set(['string', 'integer', 'decimal', 'date', 'dateTime', 'boolean', 'float', 'double', 'int', 'long']);
const check = (name, ok, detail, severity = 'error') => ({ name, status: ok ? 'pass' : 'fail', severity, detail });

export function validateXml(xml) {
  const stack = [];
  const results = [];
  const tagRe = /<\/?([A-Za-z][\w:.-]*)([^>]*?)(\/?)>/g;
  let m, count = 0;
  while ((m = tagRe.exec(xml))) {
    const [full, name, attrs, selfClose] = m;
    count++;
    if (full.startsWith('<?') || full.startsWith('<!')) continue;
    if (full.startsWith('</')) {
      const top = stack.pop();
      if (top !== name) { results.push(check('xml_wellformed', false, `标签闭合不匹配：期望 </${top}>，实际 </${name}>`)); break; }
    } else if (!selfClose) stack.push(name);
  }
  results.push(check('xml_wellformed', stack.length === 0 && !results.length, stack.length ? '存在未闭合标签：' + stack.join(',') : `${count} 个标签配对通过`));
  results.push(check('xml_root', /<Ontology[\s>]/.test(xml) && /<\/Ontology>\s*$/.test(xml), /<Ontology[\s>]/.test(xml) ? '根元素为 owl:Ontology' : '缺少 owl:Ontology 根元素'));
  return results;
}

export function validateModel(model, owl) {
  const r = [];
  const declared = new Set([...owl.classes, ...owl.objectProperties, ...owl.dataProperties].map(x => x.iri));
  const ids = [...model.classes, ...model.objectProperties, ...model.dataProperties].map(x => x.id);
  r.push(check('class_count', owl.classes.length > 0, `类 ${owl.classes.length} 个`));
  r.push(check('id_unique', new Set(ids).size === ids.length, `${ids.length} 个标识，${ids.length - new Set(ids).size} 处重复`));
  r.push(check('iri_unique', declared.size === owl.classes.length + owl.objectProperties.length + owl.dataProperties.length, 'IRI 全局唯一'));
  r.push(check('blocker_conflicts', (model.conflicts || []).filter(c => c.severity === 'blocker' && c.status === 'open').length === 0,
    (model.conflicts || []).filter(c => c.severity === 'blocker' && c.status === 'open').length + ' 项未裁决的口径冲突'));
  const badDomain = [...owl.objectProperties, ...owl.dataProperties].flatMap(p => [...(p.domains || []), ...(p.ranges || [])])
    .filter(iri => iri.startsWith(model.namespace) && !declared.has(iri));
  r.push(check('domain_range_refs', badDomain.length === 0, badDomain.length ? '悬空引用：' + badDomain.slice(0, 3).join(', ') : '所有定义域/值域均能解析到已声明的类'));
  const badTypes = owl.dataProperties.filter(p => !XSD_TYPES.has(String(p.ranges?.[0] || '').split('#').pop()));
  r.push(check('datatype', badTypes.length === 0, badTypes.length ? '不支持的数据类型：' + badTypes.slice(0, 3).map(p => p.localName).join(', ') : `${owl.dataProperties.length} 个数据属性类型合法`));
  const orphan = owl.individuals.filter(i => !declared.has(i.types[0]));
  r.push(check('instance_types', orphan.length === 0, orphan.length ? '实例引用了未声明类型' : `${owl.individuals.length} 个实例类型可解析`));
  const badAssertions = owl.individuals.flatMap(i => [...i.dataPropertyAssertions.map(a => a.propertyIRI), ...i.objectPropertyAssertions.map(a => a.propertyIRI)])
    .filter(iri => !declared.has(iri));
  r.push(check('assertion_refs', badAssertions.length === 0, badAssertions.length ? '实例断言引用了未声明属性' : '实例断言引用完整'));
  return r;
}

export function toShacl(owl) {
  const L = ['@prefix sh: <http://www.w3.org/ns/shacl#> .', '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .', '@prefix omw: <' + owl.iri + '#> .', ''];
  for (const c of owl.classes) {
    L.push(`omw:Shape_${c.id.replace(/[^\w]/g, '_')} a sh:NodeShape ; sh:targetClass <${c.iri}> ;`);
    const props = owl.dataProperties.filter(p => (p.domains || []).includes(c.iri));
    const lines = props.map(p => {
      const dt = String(p.ranges[0]).split('#').pop();
      return `  sh:property [ sh:path <${p.iri}> ; sh:datatype xsd:${dt} ; ${p.functional ? 'sh:maxCount 1 ; ' : ''}sh:minCount ${p.functional ? 1 : 0} ; sh:message "${p.localName} 缺失或类型不符"@zh ]`;
    });
    const objs = owl.objectProperties.filter(p => (p.domains || []).includes(c.iri));
    for (const p of objs) lines.push(`  sh:property [ sh:path <${p.iri}> ; sh:class <${p.ranges[0]}> ; sh:message "${p.localName} 关系端点类型不符"@zh ]`);
    if (!lines.length) { L[L.length - 1] = L[L.length - 1].replace(/ ;\s*$/, ' .'); continue; }
    L.push(lines.join(' ;\n').replace(/ ;\n/g, ' ;\n') + ' .', '');
  }
  return L.join('\n') + '\n';
}

export function buildReport(model, owl, xml, turtle) {
  const checks = [...validateModel(model, owl), ...validateXml(xml),
    check('turtle_prefix', turtle.startsWith('@prefix omw:'), 'Turtle 命名空间声明完整'),
    check('owl_declaration', /<Declaration><Class /.test(xml), 'OWL/XML 含类声明')];
  const failures = checks.filter(c => c.status === 'fail');
  return {
    passed: failures.length === 0, at: new Date().toISOString(),
    fingerprint: sha({ owl, checks: checks.map(c => c.name + c.status) }).slice(0, 16),
    summary: { total: checks.length, passed: checks.length - failures.length, failed: failures.length },
    checks,
    note: '校验覆盖语法良构、IRI 唯一、定义域/值域引用、数据类型与实例断言。描述逻辑一致性推理（HermiT/Pellet）与平台侧 SHACL 校验需在接入目标平台后执行。'
  };
}
