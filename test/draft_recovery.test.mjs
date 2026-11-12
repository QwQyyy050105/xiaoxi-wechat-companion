import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveryOutbox,recoveryRequest} from '../src/draft_recovery.mjs';

const T='mmui::ChatTextItemView', V='mmui::ChatVoiceItemView';
function fixture(){
  const target={id:'room',name:'Example group',quarantined:true,windowBinding:'bound'};
  const out={id:'out',sessionId:'s',text:'43',status:'unknown',requestIds:['in']};
  const state={outbox:[out],inbox:[{id:'in',sessionId:'s',key:'100/18/room/old/'+V+'/问一下',event:{id:'old',text:'问一下',inputModality:{kind:'platform_transcript',durationSeconds:3}}}]};
  const snapshot={group:target.name,pid:7,hwnd:18,created:100,windowBinding:'bound',draft:true,messages:[
    {id:'new',nativeId:'1.4',klass:V,text:'语音3″秒问一下'}]};
  return {target,out,state,snapshot};
}
test('prior receiver voice can be uniquely anchored to original window',()=>{
  const {target,out,state,snapshot}=fixture();
  assert.equal(recoveryOutbox(state,target,'s','out').id,'out');
  assert.equal(recoveryRequest(state,target,out,snapshot).anchorId,'1.4');
});
test('later matching bubble and identical voice with ambiguous identity are refused',()=>{
  const {target,out,state,snapshot}=fixture();
  snapshot.messages.push({id:'t',nativeId:'1.5',klass:T,text:'43'});
  assert.throws(()=>recoveryRequest(state,target,out,snapshot),/相同文字/);
  snapshot.messages[1]={...snapshot.messages[0],id:'duplicate',nativeId:'1.6'};
  assert.throws(()=>recoveryRequest(state,target,out,snapshot),/唯一|同文/);
});
test('different process generation, window, target, unread gap and missing request do not permit cleanup',()=>{
  const {target,out,state,snapshot}=fixture();
  for(const patch of [{created:201},{hwnd:20},{group:'Other'},{windowBinding:'reused'},{continuity:{unreadBeyondViewport:true}},{draft:false}])
    assert.throws(()=>recoveryRequest(state,target,out,{...snapshot,...patch}));
  assert.throws(()=>recoveryRequest(state,target,{...out,requestIds:[]},snapshot));
});
test('only the exact latest unknown after the last receipt can be recovered',()=>{
  const {state,target,out}=fixture();
  for(const id of ['old',undefined])assert.throws(()=>recoveryOutbox(state,target,'s',id));
  state.outbox.unshift({...out,id:'another'});
  assert.throws(()=>recoveryOutbox(state,target,'s','out'),/多条/);
  state.outbox[0].ownerReviewedAt='earlier';
  assert.equal(recoveryOutbox(state,target,'s','out'),out);
  state.outbox.push({...out,id:'new',status:'local_echo'});
  assert.throws(()=>recoveryOutbox(state,target,'s','out'));
});
