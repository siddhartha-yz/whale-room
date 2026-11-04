import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createRoomActivities } from './room-activities.js';
import { SIDE_TABLE } from './navigation.js';

const mat = (color, roughness = .85) => new THREE.MeshStandardMaterial({ color, roughness });

// The decorative books repeat four exact sizes/materials. Keep one geometry per
// size (including its original UVs), and move copies with translation only.
export function createBookcaseBooks(parent) {
  const colors = ['#c8c3a1', '#809585', '#bd927a', '#d8c9a6'];
  const transform = new THREE.Matrix4();
  return colors.map((color, variant) => {
    const height = .23 + variant * .045;
    const indices = Array.from({ length: Math.ceil((17 - variant) / 4) }, (_, index) => variant + index * 4);
    const books = new THREE.InstancedMesh(new THREE.BoxGeometry(.3, height, .068), mat(color), indices.length);
    books.name = `BookcaseBooks${variant}`;
    indices.forEach((index, instance) => books.setMatrixAt(instance,
      transform.makeTranslation(3.12, .22 + height / 2, -1.38 + index * .105)));
    books.instanceMatrix.needsUpdate = true;
    books.castShadow = true; books.receiveShadow = true;
    // Instances are static. Compute aggregate bounds once so camera and shadow
    // culling include every book in the group, including the end books.
    books.computeBoundingBox(); books.computeBoundingSphere();
    parent.add(books);
    return books;
  });
}

export function createRoom(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e9e5da');
  scene.fog = new THREE.Fog('#e9e5da', 19, 35);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.16;
  container.prepend(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(38, 1, .05, 80);
  camera.position.set(7.2, 5.2, 9.7);
  // Keep the orbit the user asked for separate from the camera actually used
  // to render. Obstacle avoidance must not permanently shorten their orbit.
  const orbitCamera = camera.clone();
  const controls = new OrbitControls(orbitCamera, renderer.domElement);
  controls.target.set(-.15, .75, -.2);
  controls.enableDamping = true;
  controls.dampingFactor = .07;
  controls.minDistance = 2.1;
  controls.maxDistance = 17;
  controls.maxPolarAngle = Math.PI * .485;
  controls.minPolarAngle = .18;
  controls.enablePan = false;
  camera.lookAt(controls.target);
  scene.add(new THREE.HemisphereLight(0xfff7e9, 0x9aa381, 2.25));
  const sun = new THREE.DirectionalLight(0xffedd0, 3.2);
  sun.position.set(-4, 7, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -7; sun.shadow.camera.right = 7;
  sun.shadow.camera.top = 7; sun.shadow.camera.bottom = -7;
  sun.shadow.normalBias = .035; sun.shadow.bias = -.00015;
  sun.shadow.radius = 3;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xeaf0ff, 1.1);
  fill.position.set(5, 3, 5); scene.add(fill);
  const wood = mat('#a88762');
  const walnut = mat('#796149');
  const wall = mat('#e6e4d6');
  const cream = mat('#eeecdd');
  const metal = mat('#756c56', .4);
  const fabric = (color) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#eeeeee'; ctx.fillRect(0, 0, 128, 128);
    for (let x = 0; x < 128; x += 2) { ctx.fillStyle = x % 4 ? '#d5d5d5' : '#e3e3e3'; ctx.fillRect(x, 0, 1, 128); }
    for (let y = 0; y < 128; y += 3) { ctx.fillStyle = '#ffffff3b'; ctx.fillRect(0, y, 128, 1); }
    const map = new THREE.CanvasTexture(canvas); map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set(5, 5); map.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ color, map, roughness: 1 });
  };
  function box(w, h, d, material, x, y, z, radius = 0) {
    const mesh = new THREE.Mesh(radius ? new RoundedBoxGeometry(w, h, d, 3, radius) : new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; scene.add(mesh); return mesh;
  }
  function cylinder(rt, rb, h, material, x, y, z, n = 32) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, n), material);
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; scene.add(mesh); return mesh;
  }
  function instances(geometry, material, positions) {
    const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
    const transform = new THREE.Matrix4();
    positions.forEach(([x, y, z], index) => mesh.setMatrixAt(index, transform.makeTranslation(x, y, z)));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }
  box(8.05, .19, 6.65, mat('#c9c2ad'), 0, -.13, 0, .06);
  // Individual pale oak boards, with a fine grain drawn in the material.
  const grain = document.createElement('canvas'); grain.width = 512; grain.height = 64;
  const gc = grain.getContext('2d'); gc.fillStyle = '#c9ae86'; gc.fillRect(0, 0, 512, 64);
  for (let i = 0; i < 65; i++) { gc.strokeStyle = i % 3 ? '#8e795918' : '#fff9e31b'; gc.beginPath(); gc.moveTo(0, i); gc.bezierCurveTo(150, i - Math.sin(i)*3, 340, i + Math.cos(i)*2, 512, i); gc.stroke(); }
  const woodMap = new THREE.CanvasTexture(grain); woodMap.colorSpace = THREE.SRGBColorSpace;
  const floorMats = ['#f1e3c9', '#f4e6ce', '#ecddc3', '#efe1c8'].map(color => new THREE.MeshStandardMaterial({ color, map:woodMap, roughness:.77 }));
  const floorPositions = floorMats.map(() => []);
  for (let row = 0; row < 22; row++) for (let col = 0; col < 4; col++) {
    floorPositions[(row + col*3) % 4].push([-3 + col*2, -.015, -3.15 + row*.3]);
  }
  const floorGeometry = new THREE.BoxGeometry(1.985, .035, .296);
  floorMats.forEach((material, index) => instances(floorGeometry, material, floorPositions[index]));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(7.8, 6.4), new THREE.MeshBasicMaterial({ visible:false }));
  ground.rotation.x = -Math.PI/2; ground.position.y = .008; scene.add(ground);
  box(8.05, 2.9, .14, wall, 0, 1.42, -3.3);
  box(.14, 2.9, 6.6, wall, -4, 1.42, 0);
  box(8, .11, .055, cream, 0, .055, -3.19);
  box(.055, .11, 6.5, cream, -3.89, .055, 0);
  // A large inset window, soft sky and a quiet green landscape.
  const skyCanvas = document.createElement('canvas'); skyCanvas.width=256; skyCanvas.height=256;
  const sc = skyCanvas.getContext('2d'), gradient=sc.createLinearGradient(0,0,0,256);
  gradient.addColorStop(0,'#b8d7db'); gradient.addColorStop(.68,'#e9e8cf'); gradient.addColorStop(1,'#a5b387'); sc.fillStyle=gradient; sc.fillRect(0,0,256,256);
  for(let i=0;i<10;i++){sc.fillStyle=i%2?'#99ad85':'#b1bd98';sc.beginPath();sc.ellipse(i*33,225+(i%3)*12,45,32,0,0,Math.PI*2);sc.fill();}
  const skyTexture=new THREE.CanvasTexture(skyCanvas);skyTexture.colorSpace=THREE.SRGBColorSpace;
  const sky=new THREE.Mesh(new THREE.PlaneGeometry(3.6,1.82),new THREE.MeshBasicMaterial({map:skyTexture})); sky.position.set(-3.91,1.69,-.72);sky.rotation.y=Math.PI/2;scene.add(sky);
  for (const z of [-2.56, -.72, 1.12]) box(.14,1.98,.06,cream,-3.82,1.68,z);
  for (const y of [.72, 1.7, 2.65]) box(.14,.065,3.75,cream,-3.82,y,-.72);
  box(.42,.085,3.96,cream,-3.76,.68,-.72,.025);
  const curtain = new THREE.MeshStandardMaterial({ color:'#f6f2df', side:THREE.DoubleSide, roughness:1 });
  for(const side of [-2.78,1.35]) for(let j=0;j<6;j++) {
    const part=box(.07,2.22,.09,curtain,-3.65+Math.sin(j*1.4)*.07,1.48,side+j*.045,.035);part.castShadow=false;
  }
  // A light pool falling through the window.
  const lightPool = new THREE.Mesh(new THREE.PlaneGeometry(2.1,2.1),new THREE.MeshBasicMaterial({color:'#fff9db',transparent:true,opacity:.14,depthWrite:false}));
  lightPool.rotation.x=-Math.PI/2;lightPool.rotation.z=.3;lightPool.position.set(-2,.012,.4);scene.add(lightPool);
  const sofaFabric = fabric('#8b9a79');
  const sofa = new THREE.Group();scene.add(sofa);
  // Seat top at .50m, matching the companion's folded leg geometry.
  for(const x of [-2.2,.6]) for(const z of [-2.65,-1.86]) sofa.add(cylinder(.035,.028,.2,walnut,x,.1,z));
  sofa.add(box(3.25,.24,1.06,sofaFabric,-.8,.23,-2.24,.09));
  for(const x of [-1.6,0]) sofa.add(box(1.52,.18,.91,sofaFabric,x,.41,-2.16,.07));
  sofa.add(box(3.2,.66,.24,sofaFabric,-.8,.76,-2.72,.09));
  for(const x of [-2.4,.8])sofa.add(box(.22,.57,1.1,sofaFabric,x,.52,-2.25,.075));
  const pillow1=box(.5,.49,.15,fabric('#d2bf8d'),-1.96,.75,-2.52,.09);pillow1.rotation.z=.15;pillow1.rotation.x=-.2;
  const pillow2=box(.48,.43,.17,fabric('#d7d8bc'),.35,.72,-2.51,.09);pillow2.rotation.z=-.19;pillow2.rotation.x=-.25;
  sofa.add(pillow1,pillow2);
  const rugSize = { width: 3.65, height: .025, depth: 2.75 };
  const rug = box(rugSize.width,rugSize.height,rugSize.depth,fabric('#ded5b9'),-.1,.016,.4,.09);rug.castShadow=false;
  function groundHeightAt(x,z) {
    return Math.abs(x-rug.position.x)<=rugSize.width/2&&Math.abs(z-rug.position.z)<=rugSize.depth/2
      ? rug.position.y+rugSize.height/2 : .0025;
  }
  const fringePositions = [];
  for(let z=-.8;z<1.7;z+=.1){fringePositions.push([-1.97,.032,z],[1.77,.032,z]);}
  instances(new THREE.BoxGeometry(.11,.01,.025), cream, fringePositions);
  for (const x of [-.63,.63])for(const z of [.17,.83]){const leg=cylinder(.036,.026,.38,walnut,x,.2,z);leg.rotation.z=x*.12;}
  const tableTop=box(1.65,.085,1,wood,0,.425,.5,.13);
  const activities = createRoomActivities(scene);
  // Low bookcase and an articulated table lamp.
  const cabinet=box(.68,.85,2.25,walnut,3.42,.47,-.45,.025);
  for(const z of [-1.15,-.43,.29])box(.025,.61,.54,mat('#403f32'),3.057,.48,z);
  createBookcaseBooks(scene);
  const cabinetTop=box(.8,.065,2.4,wood,3.4,.94,-.45,.025);
  cylinder(.16,.17,.035,metal,3.37,1,-1.15);
  cylinder(.016,.016,.5,metal,3.37,1.25,-1.15);
  cylinder(.13,.23,.23,cream,3.37,1.53,-1.15);
  const lampLight=new THREE.PointLight(0xffdc9d,.55,3);lampLight.position.set(3.35,1.45,-1.15);scene.add(lampLight);
  for(let i=0;i<3;i++){box(.31,.04,.42,mat(['#d5bd90','#7f927b','#e3d6b4'][i]),3.4,1.0+i*.045,.25).rotation.y=i*.08;}
  // Tall plant; broad, curved-looking leaves.
  cylinder(.24,.17,.43,mat('#c2a586'),3.03,.24,-2.47);
  cylinder(.205,.205,.012,mat('#554a36'),3.03,.46,-2.47);
  const stemMat=mat('#687c4e');
  for(let i=0;i<11;i++){
    const angle=i*2.4, height=.7+(i%4)*.21;
    const stem=cylinder(.012,.018,height,stemMat,3.03+Math.cos(angle)*.07,.42+height/2,-2.47+Math.sin(angle)*.06,8);
    stem.rotation.z=Math.cos(angle)*.14;stem.rotation.x=Math.sin(angle)*.14;
    const leaf=new THREE.Mesh(new THREE.SphereGeometry(1,16,12),mat(i%2?'#7c9565':'#5c7c4e'));
    leaf.scale.set(.13,.29,.04);leaf.position.set(3.03+Math.cos(angle)*.25,.6+height,-2.47+Math.sin(angle)*.25);leaf.rotation.set(.5+Math.sin(angle)*.8,angle,Math.cos(angle)*.8);leaf.castShadow=true;scene.add(leaf);
  }
  // Original minimal wall art.
  function art(x,y,z,w,h,variant){
    box(w+.1,h+.1,.055,walnut,x,y,z);
    const cv=document.createElement('canvas');cv.width=300;cv.height=380;const c=cv.getContext('2d');c.fillStyle='#eee8d7';c.fillRect(0,0,300,380);
    c.fillStyle=variant?'#a8b38f':'#b5a57b';c.beginPath();c.arc(165,145,77,0,Math.PI*2);c.fill();
    c.fillStyle=variant?'#536c57':'#73856a';c.beginPath();c.ellipse(90,300,105,150,-.3,0,Math.PI*2);c.fill();
    c.fillStyle='#cbbb96';c.beginPath();c.ellipse(260,340,140,98,.3,0,Math.PI*2);c.fill();
    const tex=new THREE.CanvasTexture(cv);tex.colorSpace=THREE.SRGBColorSpace;
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshStandardMaterial({map:tex,roughness:1}));mesh.position.set(x,y,z+.032);scene.add(mesh);
  }
  art(-1.22,1.99,-3.19,.71,.94,0);art(-.19,1.99,-3.19,.71,.94,1);
  // Side table and vase; share the tabletop footprint with navigation.
  const {x:sideX,z:sideZ,radius:sideRadius}=SIDE_TABLE;
  const sideTableTop=cylinder(sideRadius,.31,.065,wood,sideX,.53,sideZ);
  for(let i=0;i<3;i++){const angle=i*Math.PI*2/3;cylinder(.023,.018,.5,walnut,sideX+Math.cos(angle)*.23,.25,sideZ+Math.sin(angle)*.23);}
  cylinder(.07,.11,.22,mat('#e1d4bc'),sideX,.67,sideZ);
  for(let i=0;i<3;i++){const st=cylinder(.006,.007,.4,stemMat,sideX+i*.03,.92,sideZ,8);st.rotation.z=(i-1)*.2;}
  // Movement marker, shown only for the active destination.
  const marker=new THREE.Mesh(new THREE.RingGeometry(.13,.18,48),new THREE.MeshBasicMaterial({color:'#91a773',transparent:true,opacity:.7,side:THREE.DoubleSide,depthWrite:false}));
  marker.rotation.x=-Math.PI/2;marker.position.y=.045;marker.visible=false;scene.add(marker);
  const pickable=new Map([[ground,'floor'],[sofa,'sit'],[activities.book,'read'],[activities.cup,'drink'],[tableTop,'blocked'],[sideTableTop,'blocked'],[cabinet,'blocked']]);
  const pickObjects=[...pickable.keys()];
  function pick(ray,actor){
    for(const hit of ray.intersectObjects(actor?[...pickObjects,actor]:pickObjects,true)){
      let node=hit.object;
      while(node?.visible&&!pickable.has(node)&&node!==actor)node=node.parent;
      if(!node?.visible)continue;
      if(node===actor)return null;
      const kind=pickable.get(node);
      if(kind==='floor')return {kind,point:{x:hit.point.x,z:hit.point.z}};
      if(kind==='blocked')return {kind};
      if(kind==='drink'&&activities.isCupHeld())return null;
      return {kind:'action',action:kind};
    }
    return null;
  }
  const cameraObstacles=[...sofa.children,tableTop,sideTableTop,cabinet,cabinetTop].map(object=>{
    const {min,max}=new THREE.Box3().setFromObject(object);
    return {minX:min.x,maxX:max.x,minY:min.y,maxY:max.y,minZ:min.z,maxZ:max.z};
  }).filter(box=>box.maxY>.21);
  function resize(){const w=Math.max(1,container.clientWidth),h=Math.max(1,container.clientHeight);renderer.setSize(w,h,false);for(const view of [camera,orbitCamera]){view.aspect=w/h;view.updateProjectionMatrix();}}
  const observer=new ResizeObserver(resize);observer.observe(container);resize();
  return {scene,camera,orbitCamera,renderer,controls,ground,marker,activities,resize,groundHeightAt,pick,cameraObstacles};
}
