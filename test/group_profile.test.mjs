import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {loadGroupProfile,addressingEvidence,familyTree} from '../src/group_profile.mjs';
import {modelMessages,promptDiagnostics} from '../src/model.mjs';
const family={id:'family_fixture',channel:'desktop_wechat',peerId:'group_family',title:'Example Group B',accountId:'Example Account'};
const abao={...family,id:'abao_fixture',peerId:'group_abao',title:'Example Group A'};
const packet=(messages,type)=>messages.map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).find(x=>x?.type===type);
test('canonical family graph preserves owner-provided relationships and cross-links',()=>{
  const profile=loadGroupProfile(path.resolve('test/fixtures'),family),names=new Map(profile.people.map(p=>[p.id,p.displayName]));
  assert.equal(profile.people.length,6);assert.equal(new Set(profile.people.map(x=>x.id)).size,6);
  assert.deepEqual(profile.relationships.map(r=>[names.get(r.from),r.label,names.get(r.to)]),[['设计人','维护者','Member E'],['设计人','审阅者','Member A'],['设计人','开发者','Member B'],['设计人','测试者','Member C'],['设计人','贡献者','Member D'],['Member A','协作者','Member D']]);
  const tree=familyTree(profile);assert.equal(tree.displayName,'设计人');assert.equal(tree.children.find(x=>x.relationship==='审阅者').person.children[0].person.displayName,'Member D');
  assert.equal(tree.children.find(x=>x.relationship==='贡献者').person.reference,true);
});
test('family profile never enters the other authorized group or local owner chat',()=>{
  assert.equal(loadGroupProfile(path.resolve('test/fixtures'),abao),null);assert.equal(loadGroupProfile(path.resolve('test/fixtures'),{channel:'local'}),null);
  const profile=loadGroupProfile(path.resolve('test/fixtures'),family);
  for(const session of [{...abao,groupProfile:profile},{channel:'local',groupProfile:profile,messages:[]}])assert.equal(packet(modelMessages({},session,[]),'owner_confirmed_group_profile'),undefined);
  assert.equal(packet(modelMessages({},{...family,groupProfile:profile},[]),'owner_confirmed_group_profile').people.length,6);
  const diagnostics=promptDiagnostics({},modelMessages({},{...family,groupProfile:profile},[]));
  assert.equal(diagnostics.groupProfile.people,6);assert.equal(diagnostics.groupProfile.relationships,6);
  assert.ok(!/Member A|设计人|Member C/.test(JSON.stringify(diagnostics)));
});
test('mentioning grandma never identifies the unknown current speaker',()=>{
  const profile=loadGroupProfile(path.resolve('test/fixtures'),family),request={text:'给Member A准备小学生食谱',sender:{evidence:'unknown'}};
  assert.deepEqual(addressingEvidence(request,profile),{speakerLabel:null,relationshipToOwner:null,source:'unavailable',mayUseNamedAddress:false,mayInferSpeakerFromMention:false});
  const messages=modelMessages({},{...family,groupProfile:profile,request},[]);
  assert.equal(packet(messages,'current_request').addressing.mayUseNamedAddress,false);
  assert.match(messages[0].content,/发言者、被谈论的人、请求接收者和实际使用者/);
});
test('observed display labels give a scoped relationship but never authentication or stable identity',()=>{
  const profile=loadGroupProfile(path.resolve('test/fixtures'),family);
  const value=addressingEvidence({sender:{label:'Member A',evidence:'display_name'}},profile);
  assert.equal(value.relationshipToOwner,'审阅者');assert.equal(value.source,'message_sender_label');assert.equal(value.id,undefined);assert.equal(value.isOwner,undefined);
  assert.equal(addressingEvidence({sender:{label:'路人',evidence:'display_name'}},profile).relationshipToOwner,null);
});
test('malformed graph references fail before model projection; cyclic rendering stays bounded',t=>{
  const parent=path.resolve('temp');const root=fs.mkdtempSync(path.join(parent,'family_graph_test_'));
  t.after(()=>{assert.ok(root.startsWith(parent+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  const data=JSON.parse(fs.readFileSync('test/fixtures/group_profiles.json','utf8'));data.groups.group_family.relationships[0].to='missing';
  fs.writeFileSync(path.join(root,'group_profiles.json'),JSON.stringify(data));assert.throws(()=>loadGroupProfile(root,family),/引用无效/);
  const profile=loadGroupProfile(path.resolve('test/fixtures'),family);profile.relationships.push({from:'member_e',to:'person_designer',label:'交叉引用'});
  assert.equal(familyTree(profile).children[0].person.children[0].person.reference,true);
});
