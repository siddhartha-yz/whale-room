// Coordinates describe the character's centre on the room's X/Z floor plane.
export const NAV_BOUNDS = Object.freeze({
  minX: -3.65, maxX: 3.65, minZ: -2.85, maxZ: 2.85,
});

export const OBSTACLES = Object.freeze([
  Object.freeze({ name: 'sofa', minX: -2.5, maxX: 0.9, minZ: -2.9, maxZ: -1.65 }),
  Object.freeze({ name: 'coffeeTable', minX: -0.85, maxX: 0.85, minZ: 0, maxZ: 1 }),
  Object.freeze({ name: 'plant', minX: 2.65, maxX: 3.45, minZ: -2.8, maxZ: -2.05 }),
  Object.freeze({ name: 'cabinet', minX: 2.95, maxX: 3.75, minZ: -1.65, maxZ: 0.8 }),
]);

const BODY_CLEARANCE = 0.23;
// Turning near the table also sweeps the chibi's long, low hair. Interaction
// stations use the smaller body corridor only while holding a safe facing yaw.
const TABLE_CLEARANCE = 0.60;
const GRID_STEP = 0.16;
const EPSILON = 1e-9;
function expand(bodyOnly) {
  return OBSTACLES.map((rect) => {
    const margin = rect.name === 'coffeeTable' && !bodyOnly ? TABLE_CLEARANCE : BODY_CLEARANCE;
    return { minX: rect.minX - margin, maxX: rect.maxX + margin, minZ: rect.minZ - margin, maxZ: rect.maxZ + margin };
  });
}
const ordinaryObstacles = expand(false), bodyObstacles = expand(true);
const obstaclesFor = (options) => options?.clearance === 'body' ? bodyObstacles : ordinaryObstacles;

function pointIsClear(point, obstacles) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) return false;
  if (point.x < NAV_BOUNDS.minX || point.x > NAV_BOUNDS.maxX
    || point.z < NAV_BOUNDS.minZ || point.z > NAV_BOUNDS.maxZ) return false;
  return !obstacles.some((rect) => (
    point.x >= rect.minX - EPSILON && point.x <= rect.maxX + EPSILON
    && point.z >= rect.minZ - EPSILON && point.z <= rect.maxZ + EPSILON
  ));
}

export function isWalkable(point, options = {}) { return pointIsClear(point, obstaclesFor(options)); }

// Slab intersection includes tangencies: a shortcut must not graze a corner.
function intersectsRectangle(start, end, rect) {
  let enter = 0;
  let leave = 1;
  for (const [axis, min, max] of [
    ['x', rect.minX - EPSILON, rect.maxX + EPSILON],
    ['z', rect.minZ - EPSILON, rect.maxZ + EPSILON],
  ]) {
    const delta = end[axis] - start[axis];
    if (Math.abs(delta) < EPSILON) {
      if (start[axis] < min || start[axis] > max) return false;
      continue;
    }
    const first = (min - start[axis]) / delta;
    const second = (max - start[axis]) / delta;
    enter = Math.max(enter, Math.min(first, second));
    leave = Math.min(leave, Math.max(first, second));
    if (enter > leave) return false;
  }
  return true;
}

function segmentIsClear(start, end, obstacles) {
  // The room bounds are convex, so valid endpoints keep the entire segment inside.
  return pointIsClear(start, obstacles) && pointIsClear(end, obstacles)
    && !obstacles.some((rect) => intersectsRectangle(start, end, rect));
}

function gridAxis(min, max, start, end) {
  const values = [min, max, start, end];
  for (let value = min + GRID_STEP; value < max; value += GRID_STEP) values.push(value);
  // Including the exact start/end coordinates avoids snapping into furniture.
  return [...new Set(values)].sort((a, b) => a - b);
}

class MinHeap {
  entries = [];

  push(entry) {
    const heap = this.entries;
    heap.push(entry);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent].priority <= entry.priority) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = entry;
  }

  pop() {
    const heap = this.entries;
    const result = heap[0];
    const last = heap.pop();
    if (heap.length === 0) return result;
    let index = 0;
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < heap.length && heap[child + 1].priority < heap[child].priority) child += 1;
      if (last.priority <= heap[child].priority) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = last;
    return result;
  }
}

function simplify(points, obstacles) {
  const result = [];
  let anchor = 0;
  while (anchor < points.length - 1) {
    let next = points.length - 1;
    while (next > anchor + 1 && !segmentIsClear(points[anchor], points[next], obstacles)) next -= 1;
    result.push(points[next]);
    anchor = next;
  }
  return result;
}

/**
 * Returns waypoints excluding start and including end, or null for an invalid
 * endpoint / unreachable route. An already-reached destination returns [].
 * Seated characters must first leave the sofa via its approach point.
 * Explicit clearance:'body' is reserved for fixed-facing interaction corridors;
 * ordinary paths leave enough space to turn the character's long hair.
 */
export function findPath(start, end, options = {}) {
  const obstacles = obstaclesFor(options);
  if (!pointIsClear(start, obstacles) || !pointIsClear(end, obstacles)) return null;
  if (start.x === end.x && start.z === end.z) return [];
  if (segmentIsClear(start, end, obstacles)) return [{ x: end.x, z: end.z }];

  const xs = gridAxis(NAV_BOUNDS.minX, NAV_BOUNDS.maxX, start.x, end.x);
  const zs = gridAxis(NAV_BOUNDS.minZ, NAV_BOUNDS.maxZ, start.z, end.z);
  const width = xs.length;
  const height = zs.length;
  const total = width * height;
  const points = Array.from({ length: total }, (_, index) => ({
    x: xs[index % width], z: zs[Math.floor(index / width)],
  }));
  const walkable = Uint8Array.from(points, (point) => Number(pointIsClear(point, obstacles)));
  const startIndex = zs.indexOf(start.z) * width + xs.indexOf(start.x);
  const endIndex = zs.indexOf(end.z) * width + xs.indexOf(end.x);
  const cost = new Float64Array(total).fill(Infinity);
  const parent = new Int32Array(total).fill(-1);
  const closed = new Uint8Array(total);
  const frontier = new MinHeap();
  const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  cost[startIndex] = 0;
  frontier.push({ index: startIndex, priority: distance(start, end), cost: 0 });

  while (frontier.entries.length > 0) {
    const current = frontier.pop();
    const index = current.index;
    if (closed[index] || current.cost > cost[index]) continue;
    if (index === endIndex) {
      const route = [];
      for (let cursor = index; cursor !== -1; cursor = parent[cursor]) route.push(points[cursor]);
      return simplify(route.reverse(), obstacles);
    }
    closed[index] = 1;
    const x = index % width;
    const z = Math.floor(index / width);
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dz === 0) continue;
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
        const neighbor = nz * width + nx;
        if (!walkable[neighbor] || closed[neighbor]) continue;
        if (dx !== 0 && dz !== 0
          && (!walkable[z * width + nx] || !walkable[nz * width + x])) continue;
        if (!segmentIsClear(points[index], points[neighbor], obstacles)) continue;
        const nextCost = cost[index] + distance(points[index], points[neighbor]);
        if (nextCost >= cost[neighbor]) continue;
        cost[neighbor] = nextCost;
        parent[neighbor] = index;
        frontier.push({ index: neighbor, cost: nextCost, priority: nextCost + distance(points[neighbor], end) });
      }
    }
  }
  return null;
}
