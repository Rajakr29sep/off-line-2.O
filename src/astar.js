// Generic A* shortest path over an adjacency function. Used for indoor (floor-plan) and outdoor (road) routing.
class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(node, priority) {
    const a = this.items;
    a.push([priority, node]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top[1];
  }
}

/**
 * @param start      start node key
 * @param isGoal     (key) => boolean   (supports multi-goal, e.g. "nearest exit")
 * @param neighbours (key) => Array<[nextKey, cost, edgeRef]>
 * @param heuristic  (key) => admissible estimate to goal (return 0 for Dijkstra)
 * @returns {path:[keys], edges:[edgeRef], cost} or null when unreachable
 */
function astar({ start, isGoal, neighbours, heuristic = () => 0, maxExpansions = 500000 }) {
  const g = new Map([[start, 0]]);
  const came = new Map();
  const closed = new Set();
  const open = new MinHeap();
  open.push(start, heuristic(start));
  let expansions = 0;
  while (open.size) {
    const cur = open.pop();
    if (closed.has(cur)) continue;
    if (isGoal(cur)) {
      const path = [cur];
      const edges = [];
      let k = cur;
      while (came.has(k)) {
        const [prev, ref] = came.get(k);
        path.push(prev);
        edges.push(ref);
        k = prev;
      }
      return { path: path.reverse(), edges: edges.reverse(), cost: g.get(cur), expansions };
    }
    closed.add(cur);
    if (++expansions > maxExpansions) break;
    for (const [next, cost, ref] of neighbours(cur)) {
      if (closed.has(next)) continue;
      const tentative = g.get(cur) + cost;
      if (tentative < (g.has(next) ? g.get(next) : Infinity)) {
        g.set(next, tentative);
        came.set(next, [cur, ref]);
        open.push(next, tentative + heuristic(next));
      }
    }
  }
  return null;
}

module.exports = { astar };
