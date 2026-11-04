import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLookAt, VRMLookAtBoneApplier, VRMLookAtRangeMap } from '@pixiv/three-vrm';
import { createAvatar } from '../src/avatar.js';
import { createRoomActivities } from '../src/room-activities.js';
import { stepReadingGaze } from '../src/activity-rig.js';
import { ROOM_BOOK } from '../src/book-observation.js';
import { localModelSkip, loadLocalVrmFixture } from './vrm-fixture.js';

const options={enabled:true,phase:'reading',lineCount:4,pageKey:'page-1',episodeKey:1};
test('a page gets one short gaze episode; looking away consumes it and only a new page or reading entry restarts it',()=>{
  let state;
  for(let i=0;i<20*60;i++)state=stepReadingGaze(state,1/60,options);
  assert.equal(state.active,true);assert.equal(state.scanning,false);assert.equal(state.fixation,.5);
  const held={line:state.line,fixation:state.fixation};
  for(let i=0;i<30*60;i++)state=stepReadingGaze(state,1/60,options);
  assert.deepEqual({line:state.line,fixation:state.fixation},held);
  state=stepReadingGaze(state,1/60,{...options,pageKey:'page-2'});assert.equal(state.scanning,true);
  state=stepReadingGaze(state,0,{...options,pageKey:'page-2',enabled:false});assert.equal(state.active,false);
  state=stepReadingGaze(state,1/60,{...options,pageKey:'page-2'});assert.equal(state.scanning,false);
  state=stepReadingGaze(state,1/60,{...options,pageKey:'page-2',episodeKey:2});assert.equal(state.scanning,true);
  state=stepReadingGaze(state,0,{...options,pageKey:'page-2',episodeKey:2,phase:'turning-page'});assert.equal(state.active,false);
  state=stepReadingGaze(state,1/60,{...options,pageKey:'page-2',episodeKey:2});assert.equal(state.scanning,false,'an unconfirmed/aborted turn does not start a fresh scan');
  state=stepReadingGaze(state,1/60,{...options,pageKey:'page-3',episodeKey:2});assert.equal(state.scanning,true);
  state=stepReadingGaze(state,0,{...options,pageKey:'page-3',episodeKey:2,cancelling:true});assert.equal(state.active,false);
});

test('gaze targets lie on the actual tilted right print plane and inside its drawn body lines',()=>{
  const previous=globalThis.document,canvases=[];
  globalThis.document={createElement(){
    const calls=[],ctx={font:'',fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},
      measureText(text){return {width:Array.from(text).length*(Number(this.font.match(/(\d+)px/)?.[1])||29)};},
      fillText(text,x,y){calls.push({text,x,y,font:this.font,width:this.measureText(text).width});}};
    const canvas={width:0,height:0,getContext:()=>ctx};canvases.push({canvas,calls});return canvas;
  }};
  let props;
  try{props=createRoomActivities(new THREE.Scene());props.setBookSpread(ROOM_BOOK,0);}finally{globalThis.document=previous;}
  const layout=props.getReadingGazeLayout(),surface=props.book.getObjectByName('RightPrintSurface');
  const lines=canvases[1].calls.filter(c=>c.font==='29px sans-serif');
  assert.ok(lines.length>=2);assert.equal(layout.lineCount,lines.length);
  assert.equal(props.getReadingGazeTarget({}),null,'closed pages do not expose an eye target');
  props.updateBook(1,0);const before=props.getState();
  for(let line=0;line<lines.length;line++){
    const endpoints=[];
    for(const fixation of[0,.5,1]){
      const world=props.getReadingGazeTarget({line,fixation}),local=surface.worldToLocal(world.clone());
      const x=(local.x/.141+.5)*384,y=(.5-local.y/.208)*560;
      assert.ok(Math.abs(local.z)<1e-9);
      assert.ok(x>=lines[line].x&&x<=lines[line].x+lines[line].width);
      assert.ok(y>=lines[line].y-29&&y<=lines[line].y);
      endpoints.push(world);
    }
    assert.ok(endpoints[0].distanceTo(endpoints[2])<=.070001);
  }
  assert.deepEqual(props.getState(),before,'reading target queries cannot move or credit the book');
  props.updateBook(1,.5);assert.equal(props.getReadingGazeTarget({}),null);
});

async function fixture(){
  const bytes=readFileSync(new URL('../public/assets/deepseek-chibi.vrm',import.meta.url));
  const definition=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12))).extensions.VRMC_vrm.lookAt;
  const original=GLTFLoader.prototype.loadAsync,random=Math.random;
  GLTFLoader.prototype.loadAsync=async()=>{
    const gltf=loadLocalVrmFixture(),v=gltf.userData.vrm,map=n=>new VRMLookAtRangeMap(definition[n].inputMaxValue,definition[n].outputScale);
    v.scene.updateMatrixWorld(true);v.lookAt=new VRMLookAt(v.humanoid,new VRMLookAtBoneApplier(v.humanoid,map('rangeMapHorizontalInner'),map('rangeMapHorizontalOuter'),map('rangeMapVerticalDown'),map('rangeMapVerticalUp')));
    v.lookAt.offsetFromHeadBone.fromArray(definition.offsetFromHeadBone);v.update=dt=>{v.humanoid.update();v.lookAt.update(dt);v.expressionManager.update();};return gltf;
  };Math.random=()=>.5;
  let avatar;try{avatar=await createAvatar(new THREE.Scene());}finally{GLTFLoader.prototype.loadAsync=original;Math.random=random;}
  const props=createRoomActivities(avatar.root.parent),s=props.stations.read;
  avatar.root.position.set(s.x,0,s.z);avatar.root.rotation.y=s.yaw;
  for(let i=0;i<120;i++)avatar.update(1/60,{lookTarget:props.lookTargets.book});
  const handle=avatar.setActivity('read',{props});return{avatar,props,handle};
}
const q=(avatar,name)=>avatar.vrm.humanoid.getRawBoneNode(name).getWorldQuaternion(new THREE.Quaternion()).normalize();

test('real gaze scan changes only eyes while preserving supported hands, face channels and book phase', {skip:localModelSkip},async t=>{
  const records=[];
  for(const dt of[1/60,.05]){
    const base=await fixture(),scan=await fixture();let peakEye=0,peakHead=0,peakHand=0,peakEyeFrame=0,previous=null;
    const context=f=>({lookTarget:f.props.lookTargets.book,pageTurnAllowed:false});
    for(let frame=0;frame<Math.ceil(12/dt);frame++){
      base.avatar.update(dt,context(base));scan.avatar.update(dt,{...context(scan),readAlongPage:true});
      const a=base.avatar.getState(),b=scan.avatar.getState();
      assert.deepEqual(base.props.getState(),scan.props.getState());assert.equal(a.activity?.phase,b.activity?.phase);
      assert.equal(a.blink,b.blink);assert.deepEqual(a.channels,b.channels);
      peakHead=Math.max(peakHead,q(base.avatar,'head').angleTo(q(scan.avatar,'head')));
      const eyes=['leftEye','rightEye'].map(n=>scan.avatar.vrm.humanoid.getRawBoneNode(n).quaternion.clone().normalize());
      for(let i=0;i<2;i++)peakEye=Math.max(peakEye,eyes[i].angleTo(base.avatar.vrm.humanoid.getRawBoneNode(i?'rightEye':'leftEye').quaternion.clone().normalize()));
      if(previous)peakEyeFrame=Math.max(peakEyeFrame,...eyes.map((e,i)=>e.angleTo(previous[i])));previous=eyes;
      for(const side of['left','right'])peakHand=Math.max(peakHand,base.avatar.vrm.humanoid.getRawBoneNode(side+'Hand').getWorldPosition(new THREE.Vector3()).distanceTo(scan.avatar.vrm.humanoid.getRawBoneNode(side+'Hand').getWorldPosition(new THREE.Vector3())));
      if(b.activity.elapsed<3)assert.equal(b.readingGaze.active,false);
      if(b.activity.elapsed>8)assert.equal(b.readingGaze.scanning,false);
    }
    assert.ok(peakEye>.005&&peakEye<.06);assert.ok(peakHead<1e-7);assert.ok(peakHand<1e-8);assert.ok(peakEyeFrame<.02);
    const user=scan.avatar.root.localToWorld(new THREE.Vector3(.6,1,2));
    for(let i=0;i<Math.ceil(1/dt);i++){
      base.avatar.update(dt,{...context(base),lookTarget:user});scan.avatar.update(dt,{...context(scan),lookTarget:user,readAlongPage:true});
      assert.equal(scan.avatar.getState().readingGaze.active,false,'explicit user target wins even if the caller accidentally leaves the opt-in true');
    }
    assert.ok(q(base.avatar,'leftEye').angleTo(q(scan.avatar,'leftEye'))<1e-6);
    records.push({dt,eyeDegrees:peakEye*180/Math.PI,headDegrees:peakHead*180/Math.PI,handMeters:peakHand,eyeFrameDegrees:peakEyeFrame*180/Math.PI});
    base.avatar.dispose();scan.avatar.dispose();
  }
  t.diagnostic(JSON.stringify(records));
});

test('real page turn, hidden frame, and cancellation stop scanning without replay on the same page', {skip:localModelSkip},async()=>{
  const {avatar,props}=await fixture();
  for(let i=0;i<250;i++)avatar.update(1/60,{lookTarget:props.lookTargets.book,readAlongPage:true});
  assert.equal(avatar.getState().readingGaze.scanning,true);
  avatar.update(0,{lookTarget:props.lookTargets.book,readAlongPage:true,renderVisible:false});
  assert.equal(avatar.getState().readingGaze.active,false);
  avatar.update(1/60,{lookTarget:props.lookTargets.book,readAlongPage:true});
  assert.equal(avatar.getState().readingGaze.scanning,false);
  while(avatar.getState().activity.elapsed<7.5)avatar.update(1/60,{lookTarget:props.lookTargets.book,readAlongPage:true});
  assert.equal(avatar.getState().activity.phase,'turning-page');assert.equal(avatar.getState().readingGaze.active,false);
  const done=avatar.cancelActivity();
  for(let i=0;i<80;i++){avatar.update(1/60,{lookTarget:props.lookTargets.book,readAlongPage:true});assert.equal(avatar.getState().readingGaze.active,false);}
  assert.equal((await done).status,'cancelled');assert.equal(props.getState().bookOpen,0);
  avatar.setActivity('read',{props});
  for(let i=0;i<240;i++)avatar.update(1/60,{lookTarget:props.lookTargets.book,readAlongPage:true,pageTurnAllowed:false});
  assert.equal(avatar.getState().readingGaze.scanning,true,'a genuinely new reading activity gets one new episode');
  avatar.dispose();
});
