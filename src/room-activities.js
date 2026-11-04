import * as THREE from 'three';
import { createCupTransfer, CUP_TRANSFER_STATION } from './cup-transfer.js';

const material = (color, roughness = 0.8) => new THREE.MeshStandardMaterial({ color, roughness });
function mesh(geometry, mat, parent, position = [0, 0, 0]) {
  const object = new THREE.Mesh(geometry, mat);
  object.position.fromArray(position); object.castShadow = true; object.receiveShadow = true;
  parent.add(object); return object;
}

function printedPaper(parent, side) {
  // The numerical rig fixture deliberately has no DOM or texture loading.
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 384; canvas.height = 560;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const surface = mesh(new THREE.PlaneGeometry(0.141, 0.208),
    new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }), parent, [side * 0.074, 0.0116, 0]);
  surface.name = side < 0 ? 'LeftPrintSurface' : 'RightPrintSurface';
  surface.rotation.x = -Math.PI / 2;
  surface.castShadow = false;
  const readingLines = [];
  const draw = ({ title, text = '', pageNumber = '' }) => {
    readingLines.length = 0;
    ctx.fillStyle = '#eee8cf'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#59644e'; ctx.font = '600 36px sans-serif';
    ctx.fillText(title, 32, 83, 320);
    ctx.strokeStyle = '#aab094'; ctx.beginPath(); ctx.moveTo(32, 104); ctx.lineTo(352, 104); ctx.stroke();
    ctx.font = '29px sans-serif';
    let y = 154, line = '';
    const drawLine = () => {
      ctx.fillText(line, 32, y);
      readingLines.push({ left: 32, width: ctx.measureText(line).width, y: y - 13 });
    };
    for (const character of text) {
      if (ctx.measureText(line + character).width > 318) {
        drawLine(); line = ''; y += 45;
      }
      line += character;
    }
    if (line) drawLine();
    ctx.font = '22px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(pageNumber, 352, 523); ctx.textAlign = 'left';
    texture.needsUpdate = true;
  };
  draw.readingLayout = { surface, lines: readingLines, width: canvas.width, height: canvas.height };
  return draw;
}

/** Movable props only. The room owns its lights, furniture and navigation. */
export function createRoomActivities(scene) {
  const root = new THREE.Group(); root.name = 'RoomActivities'; scene.add(root);
  const paper = material('#eee8cf', 1), cover = material('#7f927b'), trim = material('#ceb98e'), ink = material('#69725b', 1);
  const book = new THREE.Group(); book.name = 'ReadingBook'; book.position.set(-0.36, 0.525, 0.90); root.add(book);
  // A second closed volume supports the open book at the same height as the
  // room's previous two-book stack, keeping it actually on the coffee table.
  mesh(new THREE.BoxGeometry(0.20, 0.035, 0.23), cover, book, [-0.035, -0.035, 0]);
  mesh(new THREE.BoxGeometry(0.005, 0.002, 0.216), ink, book, [0, 0.012, 0]);
  const left = new THREE.Group(), right = new THREE.Group();
  left.name = 'BookLeftPages'; right.name = 'BookRightCover'; book.add(left, right);
  const printSurfaces = [];
  const rightFallbackLines = [];
  for (const [group, side] of [[left, -1], [right, 1]]) {
    mesh(new THREE.BoxGeometry(0.154, 0.006, 0.228), cover, group, [side * 0.077, -0.014, 0]);
    const pages = mesh(new THREE.BoxGeometry(0.146, 0.022, 0.214), paper, group, [side * 0.074, 0, 0]);
    pages.name = side < 0 ? 'LeftPageBlock' : 'RightPageBlock';
    const printPage = printedPaper(group, side);
    printSurfaces.push(printPage);
    if (printPage) printPage({ title: '' });
    else for (let line = 0; line < 9; line++) {
      const print = mesh(new THREE.BoxGeometry(line % 3 === 2 ? 0.075 : 0.10, 0.0007, 0.0025), ink, group, [side * 0.074, 0.0115, -0.077 + line * 0.019]);
      print.castShadow = false;
      if (side > 0) rightFallbackLines.push(print);
    }
  }
  const pagePivot = new THREE.Group(); pagePivot.name = 'TurningPage'; pagePivot.position.y = 0.014; book.add(pagePivot);
  const turningPage = mesh(new THREE.BoxGeometry(0.145, 0.0008, 0.212), paper, pagePivot, [0.073, 0, 0]);
  turningPage.castShadow = false;
  // The single leaf disappears only once flat on the existing page stack.
  turningPage.visible = false;
  let printedPageKey = '';
  function setBookSpread(edition, pageIndex) {
    const page = edition?.pages?.[pageIndex];
    if (!page || !printSurfaces.every(Boolean)) return;
    const key = `${edition.id}:${pageIndex}`;
    if (key === printedPageKey) return;
    printedPageKey = key;
    printSurfaces[0]({ title: edition.title });
    printSurfaces[1]({ title: page.title, text: page.text, pageNumber: `${pageIndex + 1} / ${edition.pages.length}` });
  }

  const cup = new THREE.Group(); cup.name = 'DrinkingCup'; cup.position.set(0.42, 0.5525, 0.90); root.add(cup);
  const ceramic = material('#eee5d0', 0.5);
  const wallProfile = [
    new THREE.Vector2(0, -0.06), new THREE.Vector2(0.058, -0.06),
    new THREE.Vector2(0.073, 0.06), new THREE.Vector2(0.064, 0.06),
    new THREE.Vector2(0.052, -0.046), new THREE.Vector2(0, -0.046),
  ];
  mesh(new THREE.LatheGeometry(wallProfile, 32), ceramic, cup);
  // Keep the handle below the rim: this short character holds the near side,
  // so an oversized handle above the rim would enter the chin while sipping.
  const handle = mesh(new THREE.TorusGeometry(0.028, 0.009, 10, 24), ceramic, cup, [0, -0.018, 0.08]);
  handle.rotation.y = Math.PI / 2;
  const liquid = mesh(new THREE.CircleGeometry(0.059, 32), material('#6b827d', 0.25), cup, [0, 0.042, 0]);
  liquid.rotation.x = -Math.PI / 2; liquid.castShadow = false;
  const coaster = mesh(new THREE.CylinderGeometry(0.125, 0.13, 0.025, 32), material('#796149'), root, [0.42, 0.48, 0.90]);

  root.updateMatrixWorld(true);
  const cupHome = cup.matrixWorld.clone(), cupOffset = new THREE.Matrix4();
  const temporary = new THREE.Matrix4(), parentInverse = new THREE.Matrix4();
  let cupHeld = false, bookOpen = 0, pageProgress = 0;
  const cupTransfer = createCupTransfer({ root, cup, coaster, home: cupHome, isHeld: () => cupHeld, release: () => { cupHeld = false; } });
  function placeWorld(worldMatrix) {
    cup.parent.updateWorldMatrix(true, false);
    parentInverse.copy(cup.parent.matrixWorld).invert();
    temporary.multiplyMatrices(parentInverse, worldMatrix).decompose(cup.position, cup.quaternion, cup.scale);
    cup.updateMatrixWorld(true);
  }
  function updateBook(open = 0, flip = 0) {
    const openness = THREE.MathUtils.clamp(open, 0, 1);
    bookOpen = openness;
    pageProgress = THREE.MathUtils.clamp(flip, 0, 1);
    // A shallow V keeps the gutter and separate page stacks visible from the
    // room camera instead of reading as one flat, closed slab of paper.
    const openAngle = 0.14;
    left.rotation.z = -openAngle * openness;
    right.rotation.z = Math.PI * (1 - openness) + openAngle * openness;
    right.position.y = 0.026 * (1 - openness);
    pagePivot.rotation.z = openAngle + (Math.PI - 2 * openAngle) * pageProgress;
    turningPage.visible = openness > 0.95 && flip > 0.001 && flip < 0.999;
  }
  updateBook(0, 0);

  return {
    root, cup, book,
    stations: {
      read: { x: -0.36, z: 1.25, yaw: Math.PI },
      get drink() { return cupTransfer.drinkStation(); },
      move_cup: CUP_TRANSFER_STATION,
    },
    lookTargets: { book: new THREE.Vector3(-0.36, 0.55, 0.90), cup: new THREE.Vector3(0.42, 0.6125, 0.90) },
    getAnchors(avatarRoot, cupSnapshot = null) {
      avatarRoot.updateWorldMatrix(true, false);
      const local = (position) => avatarRoot.worldToLocal(new THREE.Vector3(...position)).toArray();
      return {
        book: local([-0.36, 0.55, 0.90]), cup: local([0.42, 0.5525, 0.90]),
        readLeft: local([-0.495, 0.55, 1.08]), readRight: local([-0.225, 0.55, 1.08]),
        cupPickup: local([0.42, 0.54, 1.08]),
        ...(cupTransfer.getState().supported ? cupTransfer.anchors(avatarRoot, cupSnapshot) : {}),
      };
    },
    updateBook, setBookSpread,
    enableCupTransfer: () => cupTransfer.enable(),
    getCupState: () => cupTransfer.getState(),
    beginCupTransfer: destination => cupTransfer.begin(destination),
    snapshotCupDrink: () => cupTransfer.drinkSnapshot(),
    requestCupReturn: transaction => cupTransfer.requestReturn(transaction),
    tryCupDeposit: transaction => cupTransfer.tryDeposit(transaction),
    getCupPlacement: transaction => cupTransfer.placement(transaction),
    blockCupTransfer: transaction => cupTransfer.block(transaction),
    finishCupTransfer: transaction => cupTransfer.finish(transaction),
    getReadingGazeLayout() {
      return { pageKey: printedPageKey || 'unprinted', lineCount: printSurfaces[1]?.readingLayout.lines.length ?? rightFallbackLines.length };
    },
    getReadingGazeTarget({ line = 0, fixation = .5 } = {}, target = new THREE.Vector3()) {
      if (bookOpen < .999 || (pageProgress > .001 && pageProgress < .999)) return null;
      const layout = printSurfaces[1]?.readingLayout;
      if (layout) {
        if (!layout.lines.length) return null;
        const row = layout.lines[Math.min(layout.lines.length - 1, Math.max(0, Math.floor(line)))];
        // Stay within the actual inked line and its transformed print plane.
        const span = Math.min(.07, row.width / layout.width * .141 * .8);
        const center = ((row.left + row.width / 2) / layout.width - .5) * .141;
        target.set(center + (THREE.MathUtils.clamp(fixation, 0, 1) - .5) * span,
          (.5 - row.y / layout.height) * .208, 0);
        return layout.surface.localToWorld(target);
      }
      const row = rightFallbackLines[Math.min(rightFallbackLines.length - 1, Math.max(0, Math.floor(line)))];
      if (!row) return null;
      target.set((THREE.MathUtils.clamp(fixation, 0, 1) - .5) * Math.min(.07, row.geometry.parameters.width * .8), 0, 0);
      return row.localToWorld(target);
    },
    getState: () => ({ cupHeld, bookOpen, pageFlip: pageProgress }),
    isCupHeld: () => cupHeld,
    attachCup(handWorldMatrix) {
      if (cupHeld) return;
      cup.updateWorldMatrix(true, false);
      cupOffset.copy(handWorldMatrix).invert().multiply(cup.matrixWorld);
      cupHeld = true;
    },
    updateHeldCup(handWorldMatrix) {
      if (cupHeld) { placeWorld(new THREE.Matrix4().multiplyMatrices(handWorldMatrix, cupOffset));cupTransfer.observe(); }
    },
    releaseCup() {
      // Do not snap to its home transform: the arm must visibly carry it back.
      // Keeping the actual endpoint makes any reach error inspectable.
      cupHeld = false;
    },
    getCupReturnError(expectedHome = cupHome) {
      cup.updateWorldMatrix(true, false);
      const actualPosition = new THREE.Vector3(), homePosition = new THREE.Vector3();
      const actualRotation = new THREE.Quaternion(), homeRotation = new THREE.Quaternion(), scale = new THREE.Vector3();
      cup.matrixWorld.decompose(actualPosition, actualRotation, scale);
      expectedHome.decompose(homePosition, homeRotation, scale);
      return { position: actualPosition.distanceTo(homePosition), angle: actualRotation.angleTo(homeRotation) };
    },
  };
}
