// A push-optimal Sokoban solver for sokoban-solver-01-run-20261121.
//
// The generator builds each level as a hallway with independent rooms: a box
// pushed out of a door into the hallway is lost, so no box ever leaves its
// room, and the level's push optimum is the sum of its rooms' optima. This
// solver cuts a level into its rooms and solves each room with an A* search
// over pushes (a state is the boxes plus the player's reachable region). The
// heuristic is the cheapest assignment of the room's boxes to its goals, where
// one box's cost to one goal is the fewest pushes a lone box needs to reach
// it, found by a reverse pull search out from the goals. Two deadlocks are
// pruned: a push onto a square no lone box can leave, and a frozen 2 x 2
// block of walls and boxes with a box off its goal. The search is optimal, so
// a solved room costs its optimum and a solved level costs the sum.
//
// The search is budgeted by work, never by the clock, so two runs answer
// alike: each room's search keeps at most a fixed number of states. The
// program reads no clock and no environment as a source of variation.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** [dx, dy, the step's letter, the push's letter] */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** A level in XSB: width, height, walls (1 a wall), goals, boxes, player. */
interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * For one goal, the fewest pushes a lone box needs to reach it from every
 * square, by a reverse pull search out from the goal: a box at y can be
 * pushed to x (already reached) when the player can stand at y - d. -1
 * where no pull ever reaches the square: a dead square for that goal.
 */
function pullDistances(level: Level, goal: number): Int32Array {
  const { w, wall } = level;
  const dist = new Int32Array(wall.length).fill(-1);
  const queue: number[] = [goal];
  dist[goal] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && dist[y] < 0) {
        dist[y] = dist[x]! + 1;
        queue.push(y);
      }
    }
  }
  return dist;
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room, its squares, boxes and goals. Null when the level
 * is no set of rooms.
 */
interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = new Uint8Array(wall.length);
  for (const g of goals) {
    const dist = pullDistances(level, g);
    for (let i = 0; i < wall.length; i++) if (dist[i] >= 0) live[i] = 1;
  }
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * A push-optimal solution for one sub-level (a room, the other rooms' boxes
 * standing as walls), or null when the search gives up. A* over pushes: a
 * state is the boxes and the player's square after the push that made it;
 * its key is the boxes and the lowest square the player can reach from
 * there, so two states with the same boxes and the same reachable region
 * are one. The estimate is the cheapest assignment of the boxes to the
 * goals by the pull distances, which no solution can beat.
 */
function solvePushAStar(sub: Level, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = sub;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const dists = goals.map((g) => pullDistances(sub, g));
  const live = new Uint8Array(size);
  for (const dist of dists) for (let i = 0; i < size; i++) if (dist[i] >= 0) live[i] = 1;
  if (sub.boxes.some((b) => !live[b])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);

  // The cheapest assignment of these boxes to the goals, by the pull
  // distances; Infinity when no assignment reaches every goal.
  const estimate = (boxes: number[]): number => {
    const n = boxes.length;
    let best = Infinity;
    const used = new Array<boolean>(n).fill(false);
    const walk = (i: number, sum: number): void => {
      if (sum >= best) return;
      if (i === n) {
        best = sum;
        return;
      }
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        const d = dists[j]![boxes[i]!]!;
        if (d < 0) continue;
        used[j] = true;
        walk(i + 1, sum + d);
        used[j] = false;
      }
    };
    walk(0, 0);
    return best;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  // The lowest square the player reaches from `from` around the boxes; the
  // region is marked in `seen` with `stamp`.
  const reachLow = (from: number, into: Int32Array, tag: number): number => {
    let low = from;
    let n = 0;
    stack[n++] = from;
    into[from] = tag;
    while (n > 0) {
      const p = stack[--n]!;
      if (p < low) low = p;
      const up = p - w;
      const dn = p + w;
      const lf = p - 1;
      const rt = p + 1;
      if (!wall[up] && !occupied[up] && into[up] !== tag) {
        into[up] = tag;
        stack[n++] = up;
      }
      if (!wall[dn] && !occupied[dn] && into[dn] !== tag) {
        into[dn] = tag;
        stack[n++] = dn;
      }
      if (!wall[lf] && !occupied[lf] && into[lf] !== tag) {
        into[lf] = tag;
        stack[n++] = lf;
      }
      if (!wall[rt] && !occupied[rt] && into[rt] !== tag) {
        into[rt] = tag;
        stack[n++] = rt;
      }
    }
    return low;
  };
  const keyOf = (boxes: number[], low: number): string => `${low}|${boxes.join(',')}`;

  const sBoxes: number[][] = [sub.boxes.slice()];
  const sPlayer: number[] = [sub.player];
  const sParent: number[] = [-1];
  const sDir: number[] = [-1];
  const sG: number[] = [0];
  const index = new Map<string, number>();
  for (const b of sub.boxes) occupied[b] = 1;
  index.set(keyOf(sub.boxes, reachLow(sub.player, seen, ++stamp)), 0);
  for (const b of sub.boxes) occupied[b] = 0;

  // A heap on [f, -g, h, sequence]: the lowest f first, the deeper first on
  // ties, then the lower estimate, then the earlier found. The sequence
  // keeps the order fixed, so two runs expand alike.
  const heap: [number, number, number, number][] = [];
  let seq = 0;
  const h0 = estimate(sub.boxes);
  if (h0 === Infinity) return null;
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && (a[2] < b[2] || (a[2] === b[2] && a[3] < b[3])))));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  heapPush([h0, 0, h0, seq++]);

  // The goal is tested when a state is made, not when it is popped, and
  // that is still optimal here: the estimate is consistent (one push moves
  // one box one square, so no estimate drops by more than the push's cost)
  // and at least 1 on every unsolved state, so the state just popped has
  // f at least the goal's pushes, and no state left in the heap can lead to
  // fewer.
  let found = solved(sub.boxes) ? 0 : -1;
  while (heap.length > 0 && found < 0) {
    const [, negG, , s] = heapPop();
    const g = -negG;
    if (sG[s] !== g) continue;
    const boxes = sBoxes[s]!;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    reachLow(sPlayer[s]!, seen, here);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k]!;
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(sub, occupied, goal, t);
        let key = '';
        let next: number[] | null = null;
        let h = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          h = estimate(next);
          key = keyOf(next, reachLow(b, mark, ++stamp));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || h === Infinity) continue;
        const prev = index.get(key);
        if (prev !== undefined && sG[prev]! <= g + 1) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        const t2 = sBoxes.length;
        index.set(key, t2);
        sBoxes.push(next!);
        sPlayer.push(b);
        sParent.push(s);
        sDir.push(k);
        sG.push(g + 1);
        heapPush([g + 1 + h, -(g + 1), h, seq++]);
        if (solved(next!)) {
          found = t2;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;
  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = sub.player;
  let boxes = sub.boxes.slice();
  for (const s of path) {
    const nextBoxes = sBoxes[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const k = sDir[s]!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(sub, occupied, player, from - (DIRS[k]![1]! * w + DIRS[k]![0]!));
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[k]![3]!;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/**
 * A breadth-first search over pushes, the same states and pruning as the
 * A* but no estimate: the fallback when the A* gives up, still optimal.
 */
function solvePushBfs(sub: Level, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = sub;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const dists = goals.map((g) => pullDistances(sub, g));
  const live = new Uint8Array(size);
  for (const dist of dists) for (let i = 0; i < size; i++) if (dist[i] >= 0) live[i] = 1;
  if (sub.boxes.some((b) => !live[b])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const reachLow = (from: number, into: Int32Array, tag: number): number => {
    let low = from;
    let n = 0;
    stack[n++] = from;
    into[from] = tag;
    while (n > 0) {
      const p = stack[--n]!;
      if (p < low) low = p;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && !occupied[q] && into[q] !== tag) {
          into[q] = tag;
          stack[n++] = q;
        }
      }
    }
    return low;
  };
  const keyOf = (boxes: number[], low: number): string => `${low}|${boxes.join(',')}`;
  const sBoxes: number[][] = [sub.boxes.slice()];
  const sPlayer: number[] = [sub.player];
  const sParent: number[] = [-1];
  const sDir: number[] = [-1];
  const index = new Map<string, number>();
  for (const b of sub.boxes) occupied[b] = 1;
  index.set(keyOf(sub.boxes, reachLow(sub.player, seen, ++stamp)), 0);
  for (const b of sub.boxes) occupied[b] = 0;
  let found = solved(sub.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < sBoxes.length; head++) {
    const boxes = sBoxes[head]!;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    reachLow(sPlayer[head]!, seen, here);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k]!;
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(sub, occupied, goal, t);
        let key = '';
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reachLow(b, mark, ++stamp));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, sBoxes.length);
        sBoxes.push(next!);
        sPlayer.push(b);
        sParent.push(head);
        sDir.push(k);
        if (solved(next!)) {
          found = sBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = sub.player;
  let boxes = sub.boxes.slice();
  for (const s of path) {
    const nextBoxes = sBoxes[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const k = sDir[s]!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(sub, occupied, player, from - (DIRS[k]![1]! * w + DIRS[k]![0]!));
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[k]![3]!;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's.
 */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = solvePushAStar(level, 200_000) ?? solvePushBfs(level, 250_000);
    return whole === null ? '' : whole.moves;
  }
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushAStar(sub, 200_000) ?? solvePushBfs(sub, 250_000);
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
