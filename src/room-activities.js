import * as THREE from 'three';

const material = (color, roughness = 0.8) => new THREE.MeshStandardMaterial({ color, roughness });
function mesh(geometry, mat, parent, position = [0, 0, 0]) {
  const object = new THREE.Mesh(geometry, mat);
  object.position.fromArray(position); object.castShadow = true; object.receiveShadow = true;
  parent.add(object); return object;
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
  for (const [group, side] of [[left, -1], [right, 1]]) {
    mesh(new THREE.BoxGeometry(0.154, 0.006, 0.228), cover, group, [side * 0.077, -0.014, 0]);
    const pages = mesh(new THREE.BoxGeometry(0.146, 0.022, 0.214), paper, group, [side * 0.074, 0, 0]);
    pages.name = side < 0 ? 'LeftPageBlock' : 'RightPageBlock';
    // Actual print lines make the opened spread readable as a book at room scale.
    for (let line = 0; line < 9; line++) {
      const print = mesh(new THREE.BoxGeometry(line % 3 === 2 ? 0.075 : 0.10, 0.0007, 0.0025), ink, group, [side * 0.074, 0.0115, -0.077 + line * 0.019]);
      print.castShadow = false;
    }
  }
  const pagePivot = new THREE.Group(); pagePivot.name = 'TurningPage'; pagePivot.position.y = 0.014; book.add(pagePivot);
  const turningPage = mesh(new THREE.BoxGeometry(0.145, 0.0008, 0.212), paper, pagePivot, [0.073, 0, 0]);
  turningPage.castShadow = false;
  // The single leaf disappears only once flat on the existing page stack.
  turningPage.visible = false;

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
  mesh(new THREE.CylinderGeometry(0.125, 0.13, 0.025, 32), material('#796149'), root, [0.42, 0.48, 0.90]);

  root.updateMatrixWorld(true);
  const cupHome = cup.matrixWorld.clone(), cupOffset = new THREE.Matrix4();
  const temporary = new THREE.Matrix4(), parentInverse = new THREE.Matrix4();
  let cupHeld = false, bookOpen = 0, pageProgress = 0;
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
      drink: { x: 0.29, z: 1.25, yaw: Math.PI },
    },
    lookTargets: { book: new THREE.Vector3(-0.36, 0.55, 0.90), cup: new THREE.Vector3(0.42, 0.6125, 0.90) },
    getAnchors(avatarRoot) {
      avatarRoot.updateWorldMatrix(true, false);
      const local = (position) => avatarRoot.worldToLocal(new THREE.Vector3(...position)).toArray();
      return {
        book: local([-0.36, 0.55, 0.90]), cup: local([0.42, 0.5525, 0.90]),
        readLeft: local([-0.495, 0.55, 1.08]), readRight: local([-0.225, 0.55, 1.08]),
        cupPickup: local([0.42, 0.54, 1.08]),
      };
    },
    updateBook,
    getState: () => ({ cupHeld, bookOpen, pageFlip: pageProgress }),
    isCupHeld: () => cupHeld,
    attachCup(handWorldMatrix) {
      if (cupHeld) return;
      cup.updateWorldMatrix(true, false);
      cupOffset.copy(handWorldMatrix).invert().multiply(cup.matrixWorld);
      cupHeld = true;
    },
    updateHeldCup(handWorldMatrix) {
      if (cupHeld) placeWorld(new THREE.Matrix4().multiplyMatrices(handWorldMatrix, cupOffset));
    },
    releaseCup() {
      // Do not snap to its home transform: the arm must visibly carry it back.
      // Keeping the actual endpoint makes any reach error inspectable.
      cupHeld = false;
    },
    getCupReturnError() {
      cup.updateWorldMatrix(true, false);
      const actualPosition = new THREE.Vector3(), homePosition = new THREE.Vector3();
      const actualRotation = new THREE.Quaternion(), homeRotation = new THREE.Quaternion(), scale = new THREE.Vector3();
      cup.matrixWorld.decompose(actualPosition, actualRotation, scale);
      cupHome.decompose(homePosition, homeRotation, scale);
      return { position: actualPosition.distanceTo(homePosition), angle: actualRotation.angleTo(homeRotation) };
    },
  };
}
