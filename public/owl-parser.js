
(function(root){
'use strict';
var OWL='http://www.w3.org/2002/07/owl#',RDFS='http://www.w3.org/2000/01/rdf-schema#',RDF='http://www.w3.org/1999/02/22-rdf-syntax-ns#',XSD='http://www.w3.org/2001/XMLSchema#';
var DEFAULTS={owl:OWL,rdfs:RDFS,rdf:RDF,xsd:XSD,dc:'http://purl.org/dc/elements/1.1/',skos:'http://www.w3.org/2004/02/skos/core#'};
function dec(s){return String(s).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,function(m,n){return String.fromCharCode(+n)}).replace(/&amp;/g,'&')}
function expand(v,p){var i=String(v).indexOf(':');if(i<0)return v;var pre=v.slice(0,i),base=p[pre];return base?base+v.slice(i+1):v}
function localName(iri){var s=String(iri||'').split('#').pop();if(!s||s===iri)s=String(iri).split('/').pop();try{return decodeURIComponent(s||iri)}catch(e){return s||iri}}
function xmlTree(xml){
 var root={name:'#root',attrs:{},children:[],text:''},stack=[root];
 var re=/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/([^\s<>]+)\s*>|<([^\s<>\/]+)((?:\s+[^\s=<>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g,m;
 while((m=re.exec(xml))){
  if(m[0].slice(0,4)==='<!--'||m[0].slice(0,2)==='<?'||m[0].slice(0,2)==='<!')continue;
  if(m[1]){if(stack.length>1)stack.pop();continue}
  if(m[2]){var attrs={},ar=/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,a;
   while((a=ar.exec(m[3]||'')))attrs[a[1]]=dec(a[2]!==undefined?a[2]:a[3]||'');
   var node={name:m[2],attrs:attrs,children:[],text:''};stack[stack.length-1].children.push(node);if(!m[4])stack.push(node);continue}
  if(m[5]){var t=dec(m[5]);if(t.trim())stack[stack.length-1].text+=t}
 }
 return root;
}
function iriOf(node,p){
 if(!node)return '';
 if(node.attrs.IRI)return node.attrs.IRI;
 if(node.attrs.abbreviatedIRI)return expand(node.attrs.abbreviatedIRI,p);
 if(node.name==='IRI'&&node.text.trim())return node.text.trim();
 for(var i=0;i<node.children.length;i++){var r=iriOf(node.children[i],p);if(r)return r}
 return '';
}
function litOf(node){if(!node)return '';if(node.text)return node.text;return node.children.map(function(c){return c.text||''}).join('')}
function newModel(fmt){return {format:fmt,ontologyIRI:'',prefixes:Object.assign({},DEFAULTS),classes:new Map(),objectProperties:new Map(),dataProperties:new Map(),individuals:new Map(),annotations:new Map(),_domains:[],_ranges:[],axioms:0,notes:[]}}
function ensure(m,map,iri,kind){if(!iri)return null;if(!map.has(iri))map.set(iri,{iri:iri,localName:localName(iri),kind:kind,labels:[],comments:[],annotations:[],parents:[],children:[],domains:[],ranges:[],characteristics:[],types:[],dataAssertions:[],objectAssertions:[],functional:false});return map.get(iri)}
function annotate(m,subj,prop,val){
 if(!subj||val==null)return;var a=m.annotations.get(subj)||{label:'',comment:'',others:[]};
 if(prop===RDFS+'label'||/rdfs:label$/i.test(prop)||prop.endsWith('#label')){if(!a.label)a.label=String(val)}
 else if(prop===RDFS+'comment'||/rdfs:comment$/i.test(prop)||prop.endsWith('#comment'))a.comment=String(val);
 else a.others.push({property:prop,value:String(val)});
 m.annotations.set(subj,a);
}
function applyTriple(m,s,p,o){
 if(!s||!p||!o)return;m.axioms++;
 if(p===RDF+'type'){
  if(o.v===OWL+'Class'){ensure(m,m.classes,s,'class');return}
  if(o.v===OWL+'ObjectProperty'){ensure(m,m.objectProperties,s,'objectProperty');return}
  if(o.v===OWL+'DatatypeProperty'){ensure(m,m.dataProperties,s,'dataProperty');return}
  if(o.v===OWL+'NamedIndividual'){ensure(m,m.individuals,s,'individual');return}
  if(o.v===OWL+'Ontology'){m.ontologyIRI=s;return}
  if(o.v.indexOf(OWL)===0||o.v.indexOf(RDF)===0||o.v.indexOf(RDFS)===0||o.v.indexOf(XSD)===0)return;
  var ind=ensure(m,m.individuals,s,'individual');if(ind&&!ind.types.includes(o.v))ind.types.push(o.v);return;
 }
 if(p===RDFS+'subClassOf'){var c=ensure(m,m.classes,s,'class');if(c&&o.k==='iri'&&!c.parents.includes(o.v)){c.parents.push(o.v);ensure(m,m.classes,o.v,'class')}return}
 if(p===RDFS+'domain'){m._domains.push({s:s,o:o.v});return}
 if(p===RDFS+'range'){m._ranges.push({s:s,o:o.v});return}
 if(p===RDFS+'label'||p===RDFS+'comment'){annotate(m,s,p,o.v);return}
 if(p===OWL+'equivalentClass'||p===OWL+'disjointWith')return;
 var dp=m.dataProperties.get(p);if(dp){var i=ensure(m,m.individuals,s,'individual');if(i)i.dataAssertions.push({property:p,propertyName:dp.localName,value:o.v,datatype:o.dt||'',lang:o.lang||''});return}
 var op=m.objectProperties.get(p);if(op&&o.k==='iri'){var j=ensure(m,m.individuals,s,'individual');if(j)j.objectAssertions.push({property:p,propertyName:op.localName,target:o.v});return}
 annotate(m,s,p,o.v);
}
function finish(m){
 for(var i=0;i<m._domains.length;i++){var d=m._domains[i],t=m.objectProperties.get(d.s)||m.dataProperties.get(d.s);if(t&&!t.domains.includes(d.o))t.domains.push(d.o)}
 for(var j=0;j<m._ranges.length;j++){var r=m._ranges[j],u=m.objectProperties.get(r.s)||m.dataProperties.get(r.s);if(u&&!u.ranges.includes(r.o))u.ranges.push(r.o)}
 m.annotations.forEach(function(a,iri){
  var e=m.classes.get(iri)||m.objectProperties.get(iri)||m.dataProperties.get(iri)||m.individuals.get(iri);
  if(e){e.label=a.label;e.comment=a.comment;e.annotations=a.others}
 });
 m.classes.forEach(function(c){c.parents.forEach(function(p){var parent=m.classes.get(p);if(parent&&!parent.children.includes(c.iri))parent.children.push(c.iri)})});
 var plain=function(map){return Array.from(map.values())};
 return {format:m.format,ontologyIRI:m.ontologyIRI,prefixes:m.prefixes,classes:plain(m.classes),objectProperties:plain(m.objectProperties),dataProperties:plain(m.dataProperties),individuals:plain(m.individuals),
  stats:{classes:m.classes.size,objectProperties:m.objectProperties.size,dataProperties:m.dataProperties.size,individuals:m.individuals.size,axioms:m.axioms},notes:m.notes};
}
function parseOwlXml(text){
 var tree=xmlTree(text),r=tree.children.find(function(c){return /Ontology$/i.test(c.name)});
 if(!r)throw Error('未找到 owl:Ontology 根元素，可能不是 OWL/XML 格式');
 var m=newModel('OWL/XML');m.ontologyIRI=r.attrs.ontologyIRI||'';
 r.children.forEach(function(c){if(c.name==='Prefix'&&c.attrs.name)m.prefixes[c.attrs.name]=c.attrs.IRI||''});
 var P=m.prefixes;
 function decl(c){var t=c.children[0];if(!t)return;var iri=iriOf(t,P);if(!iri)return;
  if(t.name==='Class')ensure(m,m.classes,iri,'class');
  else if(t.name==='ObjectProperty')ensure(m,m.objectProperties,iri,'objectProperty');
  else if(t.name==='DataProperty')ensure(m,m.dataProperties,iri,'dataProperty');
  else if(t.name==='NamedIndividual')ensure(m,m.individuals,iri,'individual');}
 function ann(c){var ap=c.children.find(function(x){return x.name==='AnnotationProperty'}),sub=c.children.find(function(x){return x.name==='IRI'||x.name==='AbbreviatedIRI'}),lit=c.children.find(function(x){return x.name==='Literal'});
  var prop=ap?iriOf(ap,P):'',subj=sub?(sub.attrs.IRI||expand(sub.attrs.abbreviatedIRI||'',P)||sub.text.trim()):'';
  annotate(m,subj,prop,lit?litOf(lit):'');}
 function pair(c,a,b){var x=c.children.find(function(e){return e.name===a}),y=c.children.find(function(e){return e.name===b});return [x?iriOf(x,P):'',y?iriOf(y,P):'']}
 r.children.forEach(function(c){if(c.name!=='Prefix')m.axioms++;switch(c.name){
  case 'Declaration':decl(c);break;
  case 'AnnotationAssertion':ann(c);break;
  case 'SubClassOf':{var a=c.children[0],b=c.children[1],ci=iriOf(a,P),pi=iriOf(b,P);
   if(a&&a.name==='Class'&&b&&b.name==='Class'){var cl=ensure(m,m.classes,ci,'class');if(cl&&!cl.parents.includes(pi))cl.parents.push(pi)}
   else m.notes.push('类 '+(localName(ci)||'匿名')+' 上存在复杂类表达式（约束），已记录但不作层级连线');break}
  case 'ObjectPropertyDomain':case 'ObjectPropertyRange':{var v=pair(c,'ObjectProperty','Class');
   if(c.name.endsWith('Domain'))m._domains.push({s:v[0],o:v[1]});else m._ranges.push({s:v[0],o:v[1]});break}
  case 'DataPropertyDomain':case 'DataPropertyRange':{var w=pair(c,'DataProperty','Class');
   var rangeNode=c.children.find(function(e){return e.name==='Datatype'}),rv=rangeNode?iriOf(rangeNode,P):w[1];
   if(c.name.endsWith('Domain'))m._domains.push({s:w[0],o:w[1]});else m._ranges.push({s:w[0],o:rv});break}
  case 'FunctionalObjectProperty':case 'TransitiveObjectProperty':case 'SymmetricObjectProperty':case 'AsymmetricObjectProperty':case 'ReflexiveObjectProperty':case 'IrreflexiveObjectProperty':case 'InverseFunctionalObjectProperty':{
   var oi=iriOf(c.children[0],P),op=ensure(m,m.objectProperties,oi,'objectProperty');var ch=c.name.replace('ObjectProperty','').toLowerCase();if(op&&!op.characteristics.includes(ch))op.characteristics.push(ch);break}
  case 'FunctionalDataProperty':{var di=iriOf(c.children[0],P),dp=ensure(m,m.dataProperties,di,'dataProperty');if(dp)dp.functional=true;break}
  case 'ClassAssertion':{var cls=c.children.find(function(e){return e.name==='Class'}),ind=c.children.find(function(e){return e.name==='NamedIndividual'});
   var ci=iriOf(cls,P),ii=iriOf(ind,P);var e=ensure(m,m.individuals,ii,'individual');if(e&&ci&&!e.types.includes(ci))e.types.push(ci);break}
  case 'DataPropertyAssertion':{var dpr=c.children.find(function(e){return e.name==='DataProperty'}),ni=c.children.find(function(e){return e.name==='NamedIndividual'}),lv=c.children.find(function(e){return e.name==='Literal'});
   var pi=iriOf(dpr,P),ii2=iriOf(ni,P);var e2=ensure(m,m.individuals,ii2,'individual');var pd=ensure(m,m.dataProperties,pi,'dataProperty');
   if(e2)e2.dataAssertions.push({property:pi,propertyName:pd?pd.localName:localName(pi),value:litOf(lv),datatype:lv&&lv.attrs.datatypeIRI||'',lang:lv&&lv.attrs['xml:lang']||''});break}
  case 'ObjectPropertyAssertion':{var opr=c.children.find(function(e){return e.name==='ObjectProperty'}),inds=c.children.filter(function(e){return e.name==='NamedIndividual'});
   if(inds.length>=2){var pi2=iriOf(opr,P),from=iriOf(inds[0],P),to=iriOf(inds[1],P);var e3=ensure(m,m.individuals,from,'individual');var po=ensure(m,m.objectProperties,pi2,'objectProperty');
    if(e3)e3.objectAssertions.push({property:pi2,propertyName:po?po.localName:localName(pi2),target:to})}break}
  case 'SubObjectPropertyOf':case 'InverseObjectProperties':case 'EquivalentClasses':case 'DisjointClasses':case 'SameIndividual':case 'DifferentIndividuals':m.notes.push(c.name+' 公理已读取');break;
  default:break;
 }});
 return finish(m);
}
function splitTurtleStatements(s){
 var out=[],buf='',inIri=false,inLit=false,esc=false;
 for(var i=0;i<s.length;i++){var ch=s[i];
  if(inLit){buf+=ch;if(esc){esc=false;continue}if(ch==='\\'){esc=true;continue}if(ch==='"')inLit=false;continue}
  if(ch==='"'){inLit=true;buf+=ch;continue}
  if(ch==='<'){inIri=true;buf+=ch;continue}
  if(ch==='>'){inIri=false;buf+=ch;continue}
  if(!inIri&&ch==='.'&&(i===s.length-1||/[\s\r\n]/.test(s[i+1]))){if(buf.trim())out.push(buf.trim());buf='';continue}
  buf+=ch;
 }
 if(buf.trim())out.push(buf.trim());return out;
}
function turtleTokens(s,P){
 var out=[],i=0;
 while(i<s.length){var ch=s[i];
  if(/\s/.test(ch)){i++;continue}
  if(ch==='<'){var j=s.indexOf('>',i);if(j<0)break;out.push({k:'iri',v:s.slice(i+1,j)});i=j+1;continue}
  if(ch==='"'){var k=i+1,v='',esc=false;while(k<s.length){if(esc){v+=s[k];esc=false;k++;continue}if(s[k]==='\\'){esc=true;k++;continue}if(s[k]==='"')break;v+=s[k];k++}
   i=k+1;var lang='',dt='';
   if(s[i]==='@'){var q=i+1;while(q<s.length&&/[A-Za-z-]/.test(s[q]))q++;lang=s.slice(i+1,q);i=q}
   else if(s.slice(i,i+2)==='^^'){i+=2;if(s[i]==='<'){var e=s.indexOf('>',i);dt=s.slice(i+1,e);i=e+1}else{var e2=i;while(e2<s.length&&!/[\s;,.]/.test(s[e2]))e2++;dt=expand(s.slice(i,e2),P);i=e2}}
   out.push({k:'lit',v:v,lang:lang,dt:dt});continue}
  if(';,'.indexOf(ch)>=0){out.push({k:'p',v:ch});i++;continue}
  if('[]().'.indexOf(ch)>=0){out.push({k:'p',v:ch});i++;continue}
  var a=i;while(a<s.length&&!/[\s;,\[\]()<".]/.test(s[a]))a++;
  if(a===i){i++;continue}
  var w=s.slice(i,a);i=a;
  if(w==='a')out.push({k:'iri',v:RDF+'type'});
  else if(w.indexOf(':')>=0)out.push({k:'iri',v:expand(w,P)});
  else out.push({k:'word',v:w});
 }
 return out;
}
function parseTurtle(text){
 var m=newModel(/N-Triples|\.nt/i.test(text.slice(0,60))?'Turtle':'Turtle'),P=Object.assign({},DEFAULTS);
 var cleaned=text.replace(/@prefix\s+([\w-]*):\s*<([^>]*)>\s*\.?/gi,function(a,p,iri){P[p]=iri;return ''})
                 .replace(/PREFIX\s+([\w-]*):\s*<([^>]*)>/gi,function(a,p,iri){P[p]=iri;return ''});
 m.prefixes=P;
 cleaned=cleaned.split(/\r?\n/).map(function(l){return l.replace(/(^|\s)#.*$/,'$1')}).join('\n');
 var stmts=splitTurtleStatements(cleaned);
 for(var n=0;n<stmts.length;n++){
  var ts=turtleTokens(stmts[n],P);if(!ts.length)continue;
  var subj=ts[0],pred=null;
  for(var i=1;i<ts.length;i++){var t=ts[i];
   if(t.k==='p'){if(t.v===';')pred=null;continue}
   if(!pred){if(t.k==='iri')pred=t;continue}
   if(subj.k==='iri'&&pred.k==='iri')applyTriple(m,subj.v,pred.v,t);
  }
 }
 return finish(m);
}
function parseRdfXml(text){
 var tree=xmlTree(text),m=newModel('RDF/XML');
 var r=tree.children.find(function(c){return /(^|:)RDF$/i.test(c.name)})||tree;
 var P=Object.assign({},DEFAULTS);
 Object.keys(r.attrs).forEach(function(k){if(k.indexOf('xmlns:')===0)P[k.slice(6)]=r.attrs[k]});
 m.prefixes=P;
 function about(node){return node.attrs['rdf:about']||node.attrs.about||''}
 function walk(node,subj){
  var s=about(node)||subj;
  if(/^(owl:)?Class$/i.test(node.name))applyTriple(m,s,RDF+'type',{k:'iri',v:OWL+'Class'});
  if(/^(owl:)?ObjectProperty$/i.test(node.name))applyTriple(m,s,RDF+'type',{k:'iri',v:OWL+'ObjectProperty'});
  if(/^(owl:)?DatatypeProperty$/i.test(node.name))applyTriple(m,s,RDF+'type',{k:'iri',v:OWL+'DatatypeProperty'});
  if(/^(owl:)?NamedIndividual$/i.test(node.name))applyTriple(m,s,RDF+'type',{k:'iri',v:OWL+'NamedIndividual'});
  if(node.name.indexOf(':')>0){var pre=node.name.split(':')[0];if(['rdf','rdfs','owl','xsd','sh','skos','dc'].indexOf(pre)<0)applyTriple(m,s,RDF+'type',{k:'iri',v:expand(node.name,P)})}
  node.children.forEach(function(c){
   var res=c.attrs['rdf:resource']||c.attrs.resource||'';
   var pname=c.name.indexOf(':')>=0?c.name:c.name;
   var p=expand(pname,P);
   if(c.name==='rdf:type'||/:type$/i.test(c.name)){if(res)applyTriple(m,s,RDF+'type',{k:'iri',v:res});return}
   if(/subClassOf$/i.test(c.name)){if(res)applyTriple(m,s,RDFS+'subClassOf',{k:'iri',v:res});else walk(c,s);return}
   if(/label$/i.test(c.name)||/comment$/i.test(c.name)){applyTriple(m,s,p,{k:'lit',v:litOf(c),lang:c.attrs['xml:lang']||''});return}
   if(/domain$/i.test(c.name)){if(res)applyTriple(m,s,RDFS+'domain',{k:'iri',v:res});return}
   if(/range$/i.test(c.name)){if(res)applyTriple(m,s,RDFS+'range',{k:'iri',v:res});return}
   if(res){applyTriple(m,s,p,{k:'iri',v:res});return}
   if(c.children.length){walk(c,s);return}
   var v=litOf(c);if(v)applyTriple(m,s,p,{k:'lit',v:v,dt:c.attrs['rdf:datatype']||''});
  });
 }
 r.children.forEach(function(c){walk(c,'')});
 return finish(m);
}
function parseJson(text){
 var d=JSON.parse(text),m=newModel('本体 JSON');
 if(!d||!Array.isArray(d.classes))throw Error('JSON 缺少 classes 数组，不是 OwlOntology 结构');
 m.ontologyIRI=d.iri||'';(d.namespaces||[]).forEach(function(n){m.prefixes[n.prefix]=n.iri});
 function ann(a){return (a||[]).filter(function(x){return /label$/i.test(x.property)||x.property.endsWith('#label')}).map(function(x){return x.value})[0]||''}
 (d.classes||[]).forEach(function(c){var e=ensure(m,m.classes,c.iri,'class');e.localName=c.localName||e.localName;e.label=ann(c.annotations)||c.label||'';
  (c.superClassExpressions||[]).forEach(function(x){if(x.classIRI&&!e.parents.includes(x.classIRI))e.parents.push(x.classIRI)});
  (c.annotations||[]).forEach(function(a){if(!/label$/i.test(a.property))e.annotations.push({property:a.property,value:a.value})});m.axioms++});
 (d.objectProperties||[]).forEach(function(p){var e=ensure(m,m.objectProperties,p.iri,'objectProperty');e.localName=p.localName||e.localName;e.label=ann(p.annotations)||'';e.domains=p.domains||[];e.ranges=p.ranges||[];e.characteristics=p.characteristics||[];m.axioms++});
 (d.dataProperties||[]).forEach(function(p){var e=ensure(m,m.dataProperties,p.iri,'dataProperty');e.localName=p.localName||e.localName;e.label=ann(p.annotations)||'';e.domains=p.domains||[];e.ranges=p.ranges||[];e.functional=!!p.functional;m.axioms++});
 (d.individuals||[]).forEach(function(i){var e=ensure(m,m.individuals,i.iri,'individual');e.localName=i.localName||e.localName;e.label=ann(i.annotations)||'';e.types=i.types||[];
  (i.dataPropertyAssertions||[]).forEach(function(a){e.dataAssertions.push({property:a.propertyIRI,propertyName:localName(a.propertyIRI),value:a.value,datatype:a.datatype||''})});
  (i.objectPropertyAssertions||[]).forEach(function(a){e.objectAssertions.push({property:a.propertyIRI,propertyName:localName(a.propertyIRI),target:a.targetIndividualIRI})});m.axioms++});
 return finish(m);
}
function detect(text,filename){
 var t=text.trim();
 if(t.charAt(0)==='{')return 'json';
 if(t.charAt(0)==='<'){
  if(/<rdf:RDF|<rdf:Description|xmlns:rdf=/i.test(t.slice(0,3000)))return 'rdfxml';
  return 'owlxml';
 }
 return 'turtle';
}
function parse(text,filename){
 var kind=detect(text,filename),model;
 if(kind==='json')model=parseJson(text);
 else if(kind==='owlxml')model=parseOwlXml(text);
 else if(kind==='rdfxml')model=parseRdfXml(text);
 else model=parseTurtle(text);
 if(!model.classes.length&&!model.objectProperties.length&&!model.individuals.length)throw Error('未解析出任何类或个体，请确认文件格式或换一种导出格式');
 return model;
}
root.OwlParser={parse:parse,detect:detect,localName:localName};
})(typeof window!=='undefined'?window:globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = (typeof window !== 'undefined' ? window : globalThis).OwlParser;
