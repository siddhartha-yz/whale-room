import './style.css';
import * as THREE from 'three';
import { createRoom } from './room.js';
import { createAvatar } from './avatar.js';
import { findPath, isWalkable } from './navigation.js';
import { createAutonomyController } from './autonomy.js';
import { angleDelta, stepRoute, createPostureMotion, samplePosture, createGestureCompletion } from './motion.js';
import { installDiagnostics } from './diagnostics.js';
import { createMemoryStore, proactivePreference } from './memory.js';
import { installMemoryControls } from './memory-ui.js';
import { createActivityJournal } from './activity-journal.js';
import { createAutonomyOwner } from './autonomy-owner.js';
import { createConversation } from './conversation.js';
import { createConversationScope } from './conversation-scope.js';
import { constrainRoomCamera, sampleCameraOrbit } from './camera.js';
import { captureChatReadingResult, tryAdoptChatReading } from './chat-activity.js';
import { createRenderPresence } from './render-presence.js';

const $ = selector => document.querySelector(selector);
const room = createRoom($('#room'));
const {scene,camera,renderer,controls,ground,marker}=room;
const places = {
  center:{x:0,z:1.65,label:'房间中央'},
  window:{x:-3,z:-.5,label:'窗边'},
  plant:{x:2.15,z:-1.6,label:'绿植旁'},
  sofa:{x:-.85,z:-1.25,label:'沙发前'},
  user:{x:.6,z:2.25,label:'你这边'},
};
// Looking targets are points on the objects, not the empty floor positions used by navigation.
const gazeTargets = {
  window:new THREE.Vector3(-3.85,1.45,-.72),
  plant:new THREE.Vector3(3.03,1.12,-2.47),
  sofa:new THREE.Vector3(-.8,.78,-2.42),
  center:new THREE.Vector3(0,.65,.5),
  book:new THREE.Vector3(-.36,.525,.90),
  cup:new THREE.Vector3(.42,.60,.90),
};
const seat = {x:-.85,z:-1.97};
const expressionNames={neutral:'平静',happy:'开心',sad:'难过',surprised:'惊讶',relaxed:'放松'};
const inspectionMode=new URLSearchParams(location.search).get('inspect')==='1';
const storeKey=inspectionMode?'room-companion-inspection-history-v1':'room-companion-history-v1';
const autonomyStoreKey=inspectionMode?'room-inspection-autonomy-enabled':'room-autonomy-enabled';
const activityClearKey=inspectionMode?'room-inspection-clear-activities':'room-clear-activities';
let avatar;
let state={mode:'idle',expression:'neutral',place:'房间里',sitBlend:0,speed:0};
let movement=null, brakingMotion=null, transition=null, gestureWait=null, actionVersion=0, cameraTween=null, activeRequest=null;
let turning=null, activityRun=null, activityExit=null, nextActivityId=0;
let interactionStation=null;
const TABLE_STAGING_Z=1.62;
const settleWaiters=[];
let currentLook='user', activityLookLease=null, speechTimer=null, speechVersion=0, initialized=false, busy=false, closeView=false;
let autonomy=null, actionOwner=null, providerAvailable=false;
let autonomyOwner=null, pendingUserEvent=false, pendingConversation=false, pendingSpeech=false, pendingActivityClear=false;
let manualAction=null;
let cameraManuallyAdjusted=false;
let inspectionPaused=false;
let lastInputAt=0, feedbackSequence=0;
let autonomyEnabled=!inspectionMode;
try {const saved=localStorage.getItem(autonomyStoreKey);if(saved!==null)autonomyEnabled=saved!=='false';} catch{}
const followAnchor=new THREE.Vector3();
let feedback=[];
let conversation=createConversation({storage:null}), conversationScope=null, conversationReady=false;
let conversationEpoch=0, conversationOpening=Promise.resolve(), conversationRelease=Promise.resolve();
let activeDelivery=null, pageLeaving=false, conversationRendered=false;
let toastTimer;
let memoryControls;
const renderPresence=createRenderPresence({onChange:({active})=>{
  if(!active){autonomy?.pauseForHidden();stopSpeech();avatar?.setAttention?.('idle');}
  refreshAutonomyOwnership();
}});
function roomIsActive(){return !document.hidden&&!inspectionPaused&&renderPresence.getState().active;}
setInterval(()=>renderPresence.check(),250);
const memory = createMemoryStore({
  key:inspectionMode?'room-companion-inspection-memory-v1':'room-companion-memory-v1',
  onChange:snapshot=>memoryControls?.render(snapshot),
});
const activityJournal = createActivityJournal({
  storage:(()=>{try{return localStorage;}catch{return null;}})(),
  key:inspectionMode?'room-companion-inspection-activities-v1':'room-companion-activities-v1',
});

function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4200);}
function message(role,content,type=''){
  $('.welcome')?.remove();
  const el=document.createElement('div');el.className='message '+role+' '+type;
  if(type!=='event'){const who=document.createElement('div');who.className='who';who.textContent=role==='user'?'你':type==='error'?'连接提示':'鲸鱼娘';el.append(who);}
  const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=content;el.append(bubble);$('#messages').append(el);$('#messages').scrollTop=$('#messages').scrollHeight;
}
const deliveryLabels={cancelled:'这次回复已取消。',interrupted:'上次回复未完成。',failed:'这次回复未完成。'};
function openConversation(){
  const epoch=++conversationEpoch;
  conversationOpening=(async()=>{
    await conversationRelease;
    const scope=await createConversationScope({key:storeKey});
    if(pageLeaving||epoch!==conversationEpoch){await scope.dispose();return;}
    conversationScope=scope;
    conversation=createConversation({storage:scope.storage,key:scope.key});
    const entries=conversation.snapshot();
    if(conversationRendered||entries.length)$('#messages').replaceChildren();
    for(const entry of entries){
      message(entry.role,entry.content);
      if(deliveryLabels[entry.status])message('assistant',deliveryLabels[entry.status],'event');
    }
    conversationRendered=true;conversationReady=true;
    $('#send').disabled=busy||!initialized;
  })();
  return conversationOpening;
}
function remember(role,content,options){return conversation.append(role,content,options);}
function record(action,status,detail,source=actionOwner||'user'){feedback.push({id:++feedbackSequence,action,status,detail,source,position:avatar?{x:+avatar.root.position.x.toFixed(2),z:+avatar.root.position.z.toFixed(2)}:null});feedback=feedback.slice(-8);}
function lookAt(target){currentLook=target;activityLookLease=null;}
function lookAtProp(target){currentLook=target;return activityLookLease={target};}
function releasePropLook(lease){if(lease&&activityLookLease===lease){currentLook='user';activityLookLease=null;}}
function setExpression(name,options={}){if(!avatar?.setExpression(name,options))return;state.expression=name;document.querySelectorAll('[data-expression]').forEach(b=>b.classList.toggle('selected',b.dataset.expression===name));}
function presence(){
  const labels={idle:'站着',walking:'走动中',sitting:'正在坐下',seated:'坐着',standing_up:'正在起身'};
  const activity=avatar?.getState().activity;
  const activityLabels={read:'看书',drink:'喝水',stretch:'伸展'};
  $('#presence').textContent=activity
    ? activity.cancelling?'停下来':activityLabels[activity.name]||'活动中'
    : labels[state.mode]||'在这里';
}
function flushSettleWaiters(){
  for(let i=settleWaiters.length-1;i>=0;i--){
    const waiter=settleWaiters[i];
    if(waiter.token!==actionVersion||(!brakingMotion&&!transition&&!activityExit)){
      settleWaiters.splice(i,1);waiter.resolve(waiter.token===actionVersion);
    }
  }
}
function waitForRest(token){
  if(token!==actionVersion)return Promise.resolve(false);
  if(!brakingMotion&&!transition&&!activityExit)return Promise.resolve(true);
  return new Promise(resolve=>settleWaiters.push({token,resolve}));
}
function cancelActions({activityEnding=false}={}){
  actionVersion++;
  if(turning){turning.resolve(false);turning=null;}
  const activeActivity=avatar?.getState().activity;
  if(activeActivity){
    if(!activeActivity.cancelling)record(activeActivity.name,activityEnding?'completed':'cancelled',activityEnding?'结束这段活动，正在收好东西':'活动被打断，正在收回动作',activityRun?.source||actionOwner||'user');
    const exit=avatar.cancelActivity();activityExit=exit;
    exit.finally(()=>{if(activityExit===exit){activityExit=null;flushSettleWaiters();presence();}});
  }else releasePropLook(activityLookLease);
  if(movement){
    const previous=movement;
    movement=null;previous.resolve(false);state.place='房间里';
    record('move_to','cancelled','移动被打断了');
    if(state.speed>.005)brakingMotion={path:previous.path,index:previous.index,facingYaw:previous.facingYaw,maxSpeed:previous.maxSpeed};
  }
  if(transition){
    const previous=transition;
    previous.resolve(false);
    if(!previous.recovery)record('posture','cancelled','姿态过渡被打断了');
    transition=null;
    if(state.sitBlend>0&&state.sitBlend<1){
      const to=previous.recovery?previous.to:(state.sitBlend>=.5?1:0);
      const target=to?seat:places.sofa;
      transition={...createPostureMotion({from:state.sitBlend,to,fromPosition:avatar.root.position,toPosition:target,fromYaw:avatar.root.rotation.y,recovery:true}),resolve:()=>{}};
    }
  }
  gestureWait?.cancel();gestureWait=null;
  avatar?.setGesture('none');marker.visible=false;
  if(transition)state.mode=transition.to?'sitting':'standing_up';
  else if(state.sitBlend===1){state.mode='seated';state.place='沙发上';}
  else state.mode=brakingMotion?'walking':'idle';
  if(!brakingMotion)state.speed=0;
  presence();actionOwner=null;flushSettleWaiters();
}
function stopSpeech(){speechVersion++;window.speechSynthesis?.cancel();clearTimeout(speechTimer);avatar?.setSpeaking(false);}
function userActivity({conversation=false,listening=false}={}){
  if(listening)avatar?.setAttention?.('listening');
  lookAt('user');
  stopSpeech();
  if(actionOwner==='autonomy'||activityRun?.source==='autonomy')cancelActions();
  if(autonomy)autonomy.notifyUser({conversation});
  else {pendingUserEvent=true;pendingConversation ||= conversation;}
}
function interrupt(){userActivity();activeRequest?.abort();activeRequest=null;cancelActions();stopSpeech();avatar?.setAttention?.('idle');}
function posture(to){
  if((to===1&&state.sitBlend===1)||(to===0&&state.sitBlend===0))return Promise.resolve(true);
  return new Promise(resolve=>{
    const target=to?seat:places.sofa;
    transition={...createPostureMotion({from:state.sitBlend,to,fromPosition:avatar.root.position,toPosition:target,fromYaw:avatar.root.rotation.y}),resolve};
    state.mode=to?'sitting':'standing_up';state.speed=0;presence();
  });
}
function isAtInteractionEdge(){
  return interactionStation&&avatar.root.position.z<TABLE_STAGING_Z-.001;
}
async function leaveInteractionStation(token){
  if(!interactionStation)return true;
  if(isAtInteractionEdge()){
    const away={x:avatar.root.position.x,z:TABLE_STAGING_Z,label:'茶几前'};
    if(!await walkTo(away,token,{facingYaw:Math.PI,clearance:'body',maxSpeed:.22,interaction:true}))return false;
  }
  if(token!==actionVersion)return false;
  interactionStation=null;
  return true;
}
async function walkTo(point,token,{facingYaw,clearance,maxSpeed,interaction=false}={}){
  if(!interaction&&!await leaveInteractionStation(token))return false;
  if(state.sitBlend>0){if(!await posture(0)||token!==actionVersion)return false;}
  const path=findPath({x:avatar.root.position.x,z:avatar.root.position.z},point,{clearance});
  if(path===null){toast('这里有家具挡着，换一个位置吧。');return false;}
  if(!path.length){state.place=point.label||'你选择的位置';return true;}
  return new Promise(resolve=>{movement={path,index:0,resolve,point,facingYaw,maxSpeed};state.mode='walking';marker.position.set(point.x,.045,point.z);marker.visible=!interaction;presence();});
}
function turnTo(yaw,token){
  if(token!==actionVersion)return Promise.resolve(false);
  const delta=angleDelta(avatar.root.rotation.y,yaw);
  if(Math.abs(delta)<.005)return Promise.resolve(true);
  return new Promise(resolve=>{
    turning={from:avatar.root.rotation.y,delta,elapsed:0,duration:Math.max(.25,Math.abs(delta)/3.2),resolve};
  });
}
function activityState(){
  const actual=avatar?.getState().activity;
  if(!actual)return null;
  return {id:activityRun?.activityId||actual.id,kind:actual.name,phase:actual.phase,
    cancelling:actual.cancelling,heldObject:actual.holdingProp?'cup':null};
}
async function performActivity(name,token,{source='user',activityId}={}){
  if(!avatar.supportedActivities.includes(name))return false;
  const current=avatar.getState().activity;
  if(name==='read'&&current?.name==='read'&&!current.cancelling)return true;
  const station=room.activities?.stations?.[name];
  let lookLease=null;
  if(station){
    if(!await walkTo({x:station.x,z:TABLE_STAGING_Z,label:'茶几前'},token)||token!==actionVersion)return false;
    lookLease=lookAtProp(name==='read'?'book':'cup');
    if(!await turnTo(station.yaw,token)||token!==actionVersion){releasePropLook(lookLease);return false;}
    interactionStation=station;
    if(!await walkTo({...station,label:'茶几前'},token,{facingYaw:station.yaw,clearance:'body',maxSpeed:.22,interaction:true})||token!==actionVersion){releasePropLook(lookLease);return false;}
  }else if(name==='stretch'){
    if(state.sitBlend>0&&(!await posture(0)||token!==actionVersion))return false;
  }else return false;
  const handle=avatar.setActivity(name,{props:room.activities,durationSeconds:name==='read'?null:undefined});
  if(!handle){releasePropLook(lookLease);return false;}
  const run={...handle,name,source,activityId:activityId||`manual-${Date.now()}-${++nextActivityId}`};
  activityRun=run;presence();
  if(closeView&&!cameraManuallyAdjusted)switchView(true);
  handle.finished.then(()=>{
    releasePropLook(lookLease);
    if(activityRun===run){activityRun=null;presence();flushSettleWaiters();}
  });
  if(name==='read')return Boolean(await handle.started)&&token===actionVersion;
  const result=await handle.finished;
  return result.status==='completed'&&token===actionVersion;
}
async function runActions(actions,{replace=true,announce=false,source='user',activityId=null}={}){
  if(!avatar)return;
  if(replace)cancelActions({activityEnding:source==='autonomy'});const token=actionVersion,startFeedback=feedbackSequence;
  actionOwner=source;
  try{
  if(!await waitForRest(token))return {status:'cancelled'};
  if(!actions.length&&replace&&!await leaveInteractionStation(token))return {status:'cancelled'};
  for(const action of actions){
    if(token!==actionVersion)return {status:'cancelled'};
    const activeActivity=avatar.getState().activity;
    const continuingRead=action.type==='read'&&activeActivity?.name==='read'&&!activeActivity.cancelling;
    if(activeActivity&&action.type!=='look_at'&&!continuingRead){
      await avatar.cancelActivity();
      if(token!==actionVersion)return {status:'cancelled'};
    }
    if(!continuingRead&&action.type!=='look_at'&&!['read','drink'].includes(action.type)){
      if(!await leaveInteractionStation(token))return {status:'cancelled'};
    }
    let ok=true,detail='';
    if(action.type==='move_to'){
      const p=action.point||places[action.target];if(!p){ok=false;detail='没有这个目的地';}else{ok=await walkTo(p,token);detail=ok?'走到了'+(p.label||'指定位置'):'未能到达目的地，路径被挡住或移动被打断';}
    }else if(action.type==='sit'){
      if(state.sitBlend<1){ok=await walkTo(places.sofa,token);if(ok&&token===actionVersion)ok=await posture(1);}
      if(ok&&token===actionVersion)state.place='沙发上';detail=ok?'在沙发上坐下了':'未能坐下';
    }else if(action.type==='stand'){
      const wasSeated=state.sitBlend>0;ok=await posture(0);if(ok&&token===actionVersion&&wasSeated)state.place='沙发前';detail=wasSeated?'站起来了':'已经站着了';
    }else if(action.type==='wave'||action.type==='nod'){
      const completion=createGestureCompletion(action.type);gestureWait=completion;
      avatar.setGesture(action.type);completion.update(avatar.getState().gesture,!document.hidden);
      ok=await completion.promise;
      if(gestureWait===completion)gestureWait=null;
      detail=action.type==='wave'?'挥了挥手':'轻轻点了点头';
    }else if(action.type==='look_at'){
      lookAt(action.target);detail='看向了'+(places[action.target]?.label||'你');
    }else if(['read','drink','stretch'].includes(action.type)){
      ok=await performActivity(action.type,token,{source,activityId});
      const descriptions={read:'在桌边打开书，开始看书',drink:'拿起杯子喝了一口水，并把杯子放回',stretch:'做了一次肩背伸展'};
      detail=ok?descriptions[action.type]:'这次活动没有完成';
    }else{ok=false;detail='暂时不会这个动作';}
    if(token!==actionVersion)return {status:'cancelled'};
    record(action.type,ok?'completed':'failed',detail);
    if(ok&&closeView&&!cameraManuallyAdjusted&&action.type!=='look_at')switchView(true);
    if(announce)message('assistant',ok?'· '+detail:'· 动作没有完成：'+detail,'event');
    if(!ok)break;
  }
  return {status:feedback.some(f=>f.id>startFeedback&&f.status==='failed')?'failed':'completed',feedback:feedback.filter(f=>f.id>startFeedback),activity:activityState()};
  }finally{if(token===actionVersion)actionOwner=null;}
}
function worldState(){return {position:{x:+avatar.root.position.x.toFixed(2),z:+avatar.root.position.z.toFixed(2)},posture:state.mode,expression:state.expression,location:state.place,gaze:currentLook,activity:activityState(),availableTargets:Object.entries(places).map(([id,p])=>({id,name:p.label,x:p.x,z:p.z})),availableActivities:[...avatar.supportedActivities],avatarModel:avatar.usingFallback?'pixiv 示例角色，普通比例；书杯触达未适配':'本地鲸鱼角色',room:'客厅，有沙发、茶几、窗户、绿植和书柜。可用活动严格以 availableActivities 为准；没有室外移动、做饭或任意拿取物品技能。'};}
function chatWorldState(){
  const world=worldState();
  let clearing=pendingActivityClear;
  try{clearing ||= Boolean(localStorage.getItem(activityClearKey));}catch{}
  const journal=clearing?null:activityJournal.load();
  world.activityHistory=(journal?.recentActivities||[]).slice(-6).map(entry=>({
    activity:entry.activity,outcome:entry.outcome,endReason:entry.endReason,
    at:entry.at,elapsedVisibleSeconds:entry.elapsedVisibleSeconds,feedback:entry.feedback.slice(-3),
  }));
  if(journal?.currentActivity)world.lastSavedActivity={
    activity:journal.currentActivity.activity,phase:journal.currentActivity.phase,
    elapsedVisibleSeconds:journal.currentActivity.elapsedVisibleSeconds,
    savedAt:journal.savedAt,status:'仅是上次保存的观测，不能据此断言已经完成；当前身体状态以 world.activity 为准。',
  };
  return world;
}
function setBusy(value){busy=value;if(value)avatar?.setAttention?.('thinking');else if(avatar?.getState().attention==='thinking')avatar.setAttention?.('idle');$('#thinking').hidden=!value;$('#send').disabled=value||!initialized||!conversationReady;$('#message-input').setAttribute('aria-busy',String(value));if(autonomy)renderAutonomyStatus(autonomy.getState());}
function speak(text){
  stopSpeech();if(!roomIsActive()||!$('#voice').checked)return;
  if(!window.speechSynthesis){toast('当前浏览器不支持朗读，文字陪聊仍然可用。');return;}
  const voices=window.speechSynthesis.getVoices();
  const voice=voices.find(v=>v.localService&&v.lang.toLowerCase().startsWith('zh'));
  if(!voice){toast('浏览器没有可用的本地中文语音，暂时使用文字回复。');$('#voice').checked=false;return;}
  const utterance=new SpeechSynthesisUtterance(text),version=speechVersion;utterance.lang='zh-CN';utterance.voice=voice;utterance.rate=.96;
  utterance.onstart=()=>{if(version===speechVersion)avatar.setSpeaking(true);};
  utterance.onend=utterance.onerror=()=>{if(version===speechVersion)avatar.setSpeaking(false);};
  window.speechSynthesis.speak(utterance);
}
async function send(text){
  text=text.trim();if(!text||!avatar||busy||!conversationReady||pageLeaving)return;
  userActivity({conversation:true});lookAt('user');
  cancelActions();stopSpeech();
  const requestConversation=conversation;
  const previous=requestConversation.modelHistory();message('user',text);const requestEntry=remember('user',text,{status:'pending'});$('#message-input').value='';
  const remembered=memory.snapshot();
  const controller=new AbortController();activeRequest=controller;setBusy(true);
  const delivery={controller,conversation:requestConversation,entryId:requestEntry.id,interrupted:false};activeDelivery=delivery;
  try{
    const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,history:previous,world:chatWorldState(),feedback,memory:remembered}),signal:controller.signal});
    const body=await response.json();if(!response.ok)throw new Error(typeof body.error==='string'?body.error:(body.message||'暂时没有连接上 Astra，请稍后再试。'));
    if(controller.signal.aborted||activeRequest!==controller)throw new DOMException('回复已取消','AbortError');
    if(!requestConversation.mark(requestEntry.id,'answered'))return;
    if(body.memoryPatch&&(body.memoryPatch.set?.length||body.memoryPatch.forget?.length)){
      const saved=memory.applyPatch(body.memoryPatch,{message:text,expectedRevision:remembered.revision});
      if(saved.applied)toast('记忆已更新');
      else if(saved.reason==='storage')toast('回复已收到，但记忆暂时没能保存。');
      else if(saved.reason==='full')toast('记忆已满，可以在设置里删掉不再需要的内容。');
      else if(saved.reason==='invalid')toast('回复已收到，但这条记忆没有保存成功。');
    }
    providerAvailable=true;$('#connection-dot').className='dot connected';$('#connection-label').textContent='Astra';
    if(body.reply){message('assistant',body.reply);remember('assistant',body.reply);if(autonomy)autonomy.noteSpeech();else pendingSpeech=true;if(!document.hidden)avatar.setAttention?.('responding');}
    setExpression(document.hidden?'neutral':body.expression||'neutral');speak(body.reply||'');
    void runActions(body.actions||[],{source:'chat'}).then(result=>{
      if(captureChatReadingResult(activityRun,result))adoptChatReading();
    });
  }catch(error){
    if(delivery.interrupted)return;
    if(error.name==='AbortError'){
      if(requestConversation.mark(requestEntry.id,'cancelled'))message('assistant',deliveryLabels.cancelled,'event');
    }else{
      if(requestConversation.mark(requestEntry.id,'failed'))message('assistant',error.message,'error');
      $('#connection-dot').className='dot error';$('#connection-label').textContent='连接暂时不可用';
    }
  }
  finally{if(activeDelivery===delivery){activeDelivery=null;if(activeRequest===controller)activeRequest=null;setBusy(false);if(!pageLeaving)$('#message-input').focus();}}
}
memoryControls=installMemoryControls({container:$('.settings-content'),store:memory,
  onMutate:()=>{userActivity();activeRequest?.abort();},onError:toast});
$('#chat-form').addEventListener('submit',e=>{e.preventDefault();send($('#message-input').value);});
$('#message-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send(e.currentTarget.value);}});
$('#message-input').addEventListener('input',()=>{lastInputAt=Date.now();userActivity({listening:true});});
$('#stop').addEventListener('click',async()=>{
  interrupt();const token=actionVersion;
  if(activityExit||brakingMotion||transition)toast('正在停下');
  if(await waitForRest(token))toast('已停止');
});
$('#cancel-reply').addEventListener('click',()=>{userActivity();activeRequest?.abort();});
$('#voice').addEventListener('change',()=>{if(!$('#voice').checked)stopSpeech();});
$('#clear-chat').addEventListener('click',()=>{
  interrupt();pendingActivityClear=true;
  try{localStorage.setItem(activityClearKey,crypto.randomUUID());pendingActivityClear=false;}catch{}
  flushActivityClear();
  conversation.clear();feedback=[];$('#messages').replaceChildren();message('assistant','已清空','event');
});
for(const b of document.querySelectorAll('[data-prompt]'))b.addEventListener('click',()=>send(b.dataset.prompt));
for(const b of document.querySelectorAll('[data-expression]'))b.addEventListener('click',()=>{userActivity();setExpression(b.dataset.expression,{source:'manual'});});
for(const b of document.querySelectorAll('[data-action]'))b.addEventListener('click',()=>{
  $('.activity-picker').open=false;
  const type=b.dataset.action;
  if(['sit','stand'].includes(type)&&manualAction?.type===type&&actionOwner==='user')return;
  if(type==='read'&&activityRun?.source==='user'&&avatar?.getState().activity?.name==='read'&&!avatar.getState().activity.cancelling)return;
  userActivity();activeRequest?.abort();stopSpeech();
  const run={type};manualAction=run;
  runActions([{type:type==='window'?'move_to':type,target:type==='window'?'window':type==='sit'?'sofa':'none'}]).finally(()=>{if(manualAction===run)manualAction=null;});
});
function closeAnchor(){
  const eyeHeight=avatar.eyeHeight ?? avatar.headHeight ?? 1.2;
  return avatar.root.position.clone().add(new THREE.Vector3(0,eyeHeight-.12-avatar.sitDrop*state.sitBlend,0));
}
function switchView(close){
  if(!avatar)return;
  closeView=close;cameraManuallyAdjusted=false;followAnchor.copy(closeAnchor());
  const target=close?closeAnchor():new THREE.Vector3(-.15,.75,-.2);
  const offset=new THREE.Vector3(.72,.32,2.45).applyAxisAngle(new THREE.Vector3(0,1,0),avatar.root.rotation.y);
  const position=close?target.clone().add(offset):new THREE.Vector3(7.2,5.2,9.7);
  cameraTween={from:camera.position.clone(),to:position,fromTarget:controls.target.clone(),toTarget:target,time:0,orbit:close};
  cameraTween.duration=.85;
  if(close){
    let previous=sampleCameraOrbit(cameraTween,0),distance=0,rotation=0;
    for(let i=1;i<=20;i++){
      const sample=sampleCameraOrbit(cameraTween,i/20);
      distance+=Math.hypot(sample.position.x-previous.position.x,sample.position.y-previous.position.y,sample.position.z-previous.position.z);
      const a=Math.atan2(previous.position.x-previous.target.x,previous.position.z-previous.target.z),b=Math.atan2(sample.position.x-sample.target.x,sample.position.z-sample.target.z);
      rotation+=Math.abs(angleDelta(a,b));previous=sample;
    }
    cameraTween.duration=Math.max(.85,distance/12,rotation/2);
  }
  // A user can still inspect the room while body animation is suspended.
  // Do not leave a camera-button change waiting on a throttled animation clock.
  if(inspectionPaused||!renderPresence.getState().active){
    const view=close?sampleCameraOrbit(cameraTween,1):{position:cameraTween.to,target:cameraTween.toTarget};
    camera.position.set(view.position.x,view.position.y,view.position.z);
    controls.target.set(view.target.x,view.target.y,view.target.z);
    camera.lookAt(controls.target);cameraTween=null;renderer.render(scene,camera);
  }
  $('#view-close').classList.toggle('active',close);$('#view-room').classList.toggle('active',!close);
}
$('#view-room').addEventListener('click',()=>switchView(false));$('#view-close').addEventListener('click',()=>switchView(true));
for(const b of document.querySelectorAll('[data-expression]'))b.addEventListener('click',()=>{$('.expression-picker').open=false;});
document.addEventListener('pointerdown',event=>{for(const menu of document.querySelectorAll('.settings,.expression-picker,.activity-picker,.room-help'))if(!menu.contains(event.target))menu.open=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape')document.querySelectorAll('.settings,.expression-picker,.activity-picker,.room-help').forEach(menu=>menu.open=false);});
function fitSettings(){
  const menu=$('.settings'),panel=$('.settings-content');
  if(!menu.open)return;
  panel.style.top='35px';panel.style.bottom='auto';
  const viewport=window.visualViewport;
  const top=viewport?.offsetTop||0,bottom=top+(viewport?.height||window.innerHeight);
  const available=bottom-panel.getBoundingClientRect().top-12;
  if(available>=180)panel.style.maxHeight=`${Math.floor(available)}px`;
  else{
    panel.style.top='auto';panel.style.bottom='calc(100% + 8px)';
    panel.style.maxHeight=`${Math.max(120,Math.floor(menu.getBoundingClientRect().top-top-20))}px`;
  }
}
$('.settings').addEventListener('toggle',fitSettings);
window.addEventListener('resize',fitSettings);
window.addEventListener('scroll',fitSettings,{passive:true});
window.visualViewport?.addEventListener('resize',fitSettings);

let pointerDown=null;
renderer.domElement.addEventListener('pointerdown',e=>{pointerDown={x:e.clientX,y:e.clientY,time:performance.now()};cameraTween=null;});
renderer.domElement.addEventListener('pointermove',e=>{if(pointerDown&&e.buttons&&Math.hypot(e.clientX-pointerDown.x,e.clientY-pointerDown.y)>6)cameraManuallyAdjusted=true;});
renderer.domElement.addEventListener('wheel',()=>{cameraManuallyAdjusted=true;cameraTween=null;},{passive:true});
renderer.domElement.addEventListener('pointerup',e=>{
  if(!avatar||!pointerDown||Math.hypot(e.clientX-pointerDown.x,e.clientY-pointerDown.y)>6||performance.now()-pointerDown.time>500)return;
  const rect=renderer.domElement.getBoundingClientRect(),mouse=new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);
  const ray=new THREE.Raycaster();ray.setFromCamera(mouse,camera);const hits=ray.intersectObject(ground);if(!hits.length)return;
  const point={x:hits[0].point.x,z:hits[0].point.z};
  if(!isWalkable(point)){toast('这里放着家具，请选一处空地。');return;}
  userActivity();activeRequest?.abort();runActions([{type:'move_to',point}]);
});
let elapsed=0;
function frame(now){
  requestAnimationFrame(frame);
  const presence=renderPresence.frame(now);
  // All local animation and completion checks share the visible animation clock.
  if(document.hidden||inspectionPaused)return;
  // Keep a still image after loading/resizing even if this embedded browser
  // throttles RAF without reporting document.hidden. Do not advance the body.
  if(!presence.active){renderer.render(scene,camera);return;}
  advanceFrame(presence.deltaSeconds);
}
function advanceFrame(dt){
  elapsed+=dt;
  if(avatar){
    let animationSpeed=0,walkDirection=1;
    const route=movement||brakingMotion;
    if(route){
      const step=stepRoute({position:avatar.root.position,path:route.path,index:route.index,yaw:avatar.root.rotation.y,speed:state.speed},dt,{maxSpeed:route.maxSpeed??avatar.preferredWalkSpeed??.45,facingYaw:route.facingYaw,stopping:!movement});
      if(dt>0)animationSpeed=Math.hypot(step.position.x-avatar.root.position.x,step.position.z-avatar.root.position.z)/dt;
      if(Number.isFinite(route.facingYaw)){
        const along=(step.position.x-avatar.root.position.x)*Math.sin(step.yaw)+(step.position.z-avatar.root.position.z)*Math.cos(step.yaw);
        walkDirection=along<0?-1:1;
      }
      avatar.root.position.set(step.position.x,0,step.position.z);avatar.root.rotation.y=step.yaw;
      state.speed=step.speed;route.index=step.index;
      if(step.done){
        if(movement){const done=movement;movement=null;state.place=done.point.label||'指定位置';marker.visible=false;done.resolve(true);}
        else brakingMotion=null;
        state.mode='idle';presence();
      }
    }else{
      state.speed=0;
      if(!transition&&!turning&&!avatar.getState().activity&&!isAtInteractionEdge()&&state.sitBlend===0){
        const facing=gazeTargets[currentLook]||camera.position;
        const dx=facing.x-avatar.root.position.x,dz=facing.z-avatar.root.position.z;
        if(Math.hypot(dx,dz)>.05){
          const delta=angleDelta(avatar.root.rotation.y,Math.atan2(dx,dz));
          // Small glances belong to the eyes/head; turn the body only when needed.
          if(Math.abs(delta)>.32)avatar.root.rotation.y+=(delta-Math.sign(delta)*.16)*(1-Math.exp(-2.8*dt));
        }
      }
    }
    if(transition){
      const tr=transition;tr.elapsed+=dt;
      const pose=samplePosture(tr,tr.elapsed);
      state.sitBlend=pose.blend;avatar.root.position.set(pose.position.x,0,pose.position.z);avatar.root.rotation.y=pose.yaw;
      if(pose.done){
        transition=null;state.sitBlend=tr.to;state.mode=tr.to?'seated':'idle';state.place=tr.to?'沙发上':'沙发前';tr.resolve(true);presence();
      }
    }
    if(turning){
      const motion=turning;motion.elapsed+=dt;
      const t=Math.min(1,motion.elapsed/motion.duration),blend=t*t*(3-2*t);
      avatar.root.rotation.y=motion.from+motion.delta*blend;
      if(t>=1){turning=null;motion.resolve(true);}
    }
    let lookTarget=gazeTargets[currentLook]||camera.position;
    if(movement||brakingMotion){
      const route=movement||brakingMotion,p=route.path[Math.min(route.index,route.path.length-1)];
      const dx=p.x-avatar.root.position.x,dz=p.z-avatar.root.position.z,distance=Math.hypot(dx,dz);
      const eyeHeight=(avatar.eyeHeight??1.2)-avatar.sitDrop*state.sitBlend;
      const fixed=Number.isFinite(route.facingYaw);
      lookTarget=new THREE.Vector3(avatar.root.position.x+(fixed?Math.sin(route.facingYaw):distance>.01?dx/distance:Math.sin(avatar.root.rotation.y))*1.5,eyeHeight+.02,avatar.root.position.z+(fixed?Math.cos(route.facingYaw):distance>.01?dz/distance:Math.cos(avatar.root.rotation.y))*1.5);
    }
    avatar.update(dt,{time:elapsed,speed:animationSpeed,walkDirection,seated:state.mode==='seated',sitBlend:state.sitBlend,lookTarget});
    const actual=avatar.getState();
    if(actual.activity||activityRun)presence();
    if(activityRun?.source==='chat')adoptChatReading();
    gestureWait?.update(actual.gesture,true);
    if(actual.expression!==state.expression){
      state.expression=actual.expression;
      document.querySelectorAll('[data-expression]').forEach(button=>button.classList.toggle('selected',button.dataset.expression===actual.expression));
    }
    marker.material.opacity=.45+Math.sin(elapsed*3)*.18;
    flushSettleWaiters();
  }
  if(closeView&&avatar){
    const anchor=closeAnchor(),delta=anchor.clone().sub(followAnchor);
    if(cameraTween){for(const key of ['from','to','fromTarget','toTarget'])cameraTween[key].add(delta);}
    else{camera.position.add(delta);controls.target.add(delta);}
    followAnchor.copy(anchor);
  }
  if(cameraTween){
    const tw=cameraTween;tw.time+=dt;const t=Math.min(1,tw.time/tw.duration),s=t*t*(3-2*t);
    if(tw.orbit){const view=sampleCameraOrbit(tw,s);camera.position.set(view.position.x,view.position.y,view.position.z);controls.target.set(view.target.x,view.target.y,view.target.z);}
    else{camera.position.lerpVectors(tw.from,tw.to,s);controls.target.lerpVectors(tw.fromTarget,tw.toTarget,s);}
    if(t>=1)cameraTween=null;
  }
  controls.update();
  if(closeView){
    const safe=constrainRoomCamera(camera.position,controls.target);
    camera.position.set(safe.x,safe.y,safe.z);camera.lookAt(controls.target);
  }
  renderer.render(scene,camera);
}
requestAnimationFrame(frame);
function renderAutonomyStatus(value){
  const labels={off:'已关闭',waiting:'待机',thinking:'思考中',acting:'活动中',resting:'休息中',paused:'已暂停',other:'另一页在活动',error:'暂不可用'};
  $('#autonomy-status').textContent=labels[value.status]||'待机';
  $('#autonomy-status').title=value.activity||'';
  $('#autonomy-reason').textContent=value.status==='off'?'自主活动已关闭。':[value.activity,value.reason].filter(Boolean).join(' · ')||'暂无活动。';
  $('#autonomy-dot').dataset.state=value.status;
  $('#autonomy-now').disabled=!value.enabled||!autonomy||['thinking','acting'].includes(value.status)||busy||!initialized;
}
function isTyping(){return Boolean($('#message-input').value.trim())||Date.now()-lastInputAt<5000;}
function adoptChatReading(){
  return tryAdoptChatReading({
    run:activityRun,actual:avatar?.getState().activity,autonomy,
    idle:!movement&&!brakingMotion&&!transition&&!turning&&!activityExit&&!actionOwner,
    visible:roomIsActive(),typing:isTyping(),chatBusy:busy,
  });
}
function startOwnedAutonomy(){
  const owned=createAutonomyController({
    initialEnabled:true,
    journal:activityJournal,
    getSnapshot:()=>({
      ready:initialized&&providerAvailable,
      idle:!movement&&!brakingMotion&&!transition&&!turning&&!activityExit&&!actionOwner&&(!activityRun||activityRun.source==='autonomy'),
      visible:roomIsActive(),renderActive:renderPresence.getState().active,
      typing:isTyping(),
      chatBusy:busy,
      history:conversation.modelHistory(),world:avatar?worldState():{},feedback:[...feedback],
      memory:memory.snapshot(),canSpeak:proactivePreference(memory.snapshot())!=='quiet',
    }),
    onStatus:value=>{if(autonomy===owned)renderAutonomyStatus(value);},
    onError:error=>{ $('#autonomy-reason').textContent=error.message||'连接失败，请稍后重试。'; },
    onPlan:async plan=>{
      setExpression(plan.expression);
      if(plan.reply){message('assistant',plan.reply,'proactive');remember('assistant',plan.reply);avatar.setAttention?.('responding');speak(plan.reply);}
      if(plan.continuationOf&&plan.actions.length===0)return {status:'completed',feedback:[],activity:activityState()};
      return await runActions(plan.actions,{source:'autonomy',activityId:plan.activityId,replace:!plan.continuationOf});
    },
  });
  autonomy=owned;
  flushActivityClear();
  if(pendingUserEvent){owned.notifyUser({conversation:pendingConversation});pendingUserEvent=false;pendingConversation=false;}
  if(pendingSpeech){owned.noteSpeech();pendingSpeech=false;}
  adoptChatReading();
  owned.start();renderAutonomyStatus(owned.getState());
  return ()=>{
    if(autonomy===owned){
      if(actionOwner==='autonomy'||activityRun?.source==='autonomy')cancelActions();
      stopSpeech();owned.dispose();autonomy=null;
    }else owned.dispose();
  };
}
function flushActivityClear(){
  if(!autonomy)return;
  let request;
  try{request=localStorage.getItem(activityClearKey);}catch{}
  if(!request&&!pendingActivityClear)return;
  if(actionOwner==='autonomy'||activityRun?.source==='autonomy'){cancelActions();stopSpeech();}
  autonomy.clearMemory();pendingActivityClear=false;
  try{if(localStorage.getItem(activityClearKey)===request)localStorage.removeItem(activityClearKey);}catch{}
}
function refreshAutonomyOwnership(){
  autonomyOwner?.setEnabled(autonomyEnabled&&initialized&&conversationReady&&!pageLeaving&&roomIsActive());
}
function setupAutonomy(){
  autonomyOwner=createAutonomyOwner({
    onAcquire:startOwnedAutonomy,
    onStatus:value=>{
      if(value.status==='owner'&&autonomy)return;
      const status=!autonomyEnabled?'off':value.status==='waiting'?'other':value.status==='unsupported'||value.status==='error'?'error':'paused';
      const reason=value.status==='unsupported'?'当前浏览器不支持自主活动。':value.status==='error'?'自主活动暂时不可用，请重新打开页面。':status==='other'?'另一页正在安排活动。':status==='paused'?'页面返回后继续安排。':'';
      renderAutonomyStatus({enabled:autonomyEnabled,status,reason,activity:''});
    },
  });
  $('#autonomy-enabled').checked=autonomyEnabled;
  $('#autonomy-enabled').disabled=!initialized;
  refreshAutonomyOwnership();
}
$('#autonomy-enabled').addEventListener('change',()=>{
  autonomyEnabled=$('#autonomy-enabled').checked;
  try{localStorage.setItem(autonomyStoreKey,String(autonomyEnabled));}catch{}
  if(!autonomyEnabled){if(actionOwner==='autonomy'||activityRun?.source==='autonomy')cancelActions();stopSpeech();}
  refreshAutonomyOwnership();
});
window.addEventListener('storage',event=>{
  if(event.key===activityClearKey){if(event.newValue)flushActivityClear();return;}
  if(event.key!==autonomyStoreKey)return;
  autonomyEnabled=event.newValue!=='false';$('#autonomy-enabled').checked=autonomyEnabled;
  refreshAutonomyOwnership();
});
$('#autonomy-now').addEventListener('click',async()=>{
  if(activityRun?.source==='user'&&activityRun.name==='read'){
    cancelActions();
    const token=actionVersion;
    if(!await waitForRest(token))return;
  }
  const result=autonomy?.requestNow();
  if(result&&!result.ok)toast(result.reason||'当前活动尚未结束。');
});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){
    stopSpeech();
    avatar?.setExpression('neutral');avatar?.setAttention?.('idle');
  }else{if(busy)avatar?.setAttention?.('thinking');}
  refreshAutonomyOwnership();
});
window.addEventListener('pagehide',event=>{
  pageLeaving=true;conversationReady=false;conversationEpoch++;
  if(activeDelivery){
    activeDelivery.interrupted=true;
    activeDelivery.conversation.mark(activeDelivery.entryId,'interrupted');
    activeDelivery.controller.abort();activeDelivery=null;
  }
  activeRequest?.abort();activeRequest=null;setBusy(false);
  const scope=conversationScope;conversationScope=null;
  conversationRelease=Promise.all([conversationOpening,scope?.dispose()]);
  if(event.persisted)autonomyOwner?.setEnabled(false);else void autonomyOwner?.dispose();
});
window.addEventListener('pageshow',async event=>{
  if(event.persisted){pageLeaving=false;await openConversation();refreshAutonomyOwnership();}
});
async function init(){
  $('#send').disabled=true;
  const conversationPromise=openConversation();
  const statusPromise=fetch('/api/status').then(r=>r.json()).then(status=>{
    providerAvailable=status.available;
    $('#connection-dot').className='dot '+(status.available?'connected':'error');
    $('#connection-label').textContent=status.available?'Astra':status.offline?'离线场景':'需要登录 Codex';
    if(!status.available){$('#provider-note').textContent=status.reason||'请在终端运行 codex login 登录 ChatGPT';}
  }).catch(()=>{$('#connection-label').textContent='本地服务未连接';});
  try{
    avatar=await createAvatar(scene);
    $('#avatar-note').textContent=avatar.usingFallback?'当前为 pixiv 示例角色；看书和喝水需要本地适配模型。':'当前为本地鲸鱼角色；该模型未随公开仓库分发。';
    for(const button of document.querySelectorAll('[data-action="read"], [data-action="drink"], [data-action="stretch"]')){
      button.disabled=!avatar.supportedActivities.includes(button.dataset.action);
      if(button.disabled)button.title='当前模型尚未适配此活动';
    }
    if(avatar.usingFallback)toast('已加载公开的 pixiv 示例角色');
    await conversationPromise;
    // Keep the chibi's short thighs on the cushion, with knees past its front.
    seat.z=-1.60-(avatar.thighLength ?? .37);
    avatar.root.position.set(1.5,0,1.6);avatar.root.rotation.y=.3;
    initialized=true;$('#loading').hidden=true;$('#send').disabled=!conversationReady;presence();
    installDiagnostics({avatar,renderer,scene,camera,getWorldState:worldState,getAutonomyState:()=>autonomy?.getState(),getFeedback:()=>feedback,
      getSimulationTime:()=>elapsed,
      getRenderPresence:()=>renderPresence.getState(),
      setPaused:value=>{inspectionPaused=value;refreshAutonomyOwnership();},
      step:async seconds=>{if(!inspectionPaused)return;for(let left=seconds;left>1e-6;left-=1/60){advanceFrame(Math.min(left,1/60));await Promise.resolve();}},
    });
    // Read-only diagnostics for local rendering acceptance; no privileged controls.
    Object.defineProperty(window,'companionDebug',{value:{getState:()=>({...worldState(),avatar:avatar.getState(),seatHeight:avatar.seatHeight,feedback:[...feedback]}),getRendererInfo:()=>({drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles}),getBonePositions:()=>Object.fromEntries(['hips','head','leftFoot','rightFoot','leftHand','rightHand'].map(n=>[n,avatar.vrm.humanoid.getNormalizedBoneNode(n)?.getWorldPosition(new THREE.Vector3()).toArray()]))}});
  }catch(error){console.error(error);$('#loading').hidden=true;$('#room-error').hidden=false;$('#room-error').textContent='角色加载失败：'+error.message;}
  await statusPromise;
  setupAutonomy();
}
init();
