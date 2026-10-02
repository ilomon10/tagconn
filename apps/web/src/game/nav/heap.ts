// apps/web/src/game/nav/heap.ts  (M15 T4, docs/design/navigation.md section 4.1)
//
// Binary min-heap over node ids with typed-array storage, shared by the macro (tile) and micro (cell)
// searches. Order: f asc, then h asc, then id asc, so two runs over equal inputs pop in the same order
// (invariant 7, determinism). Lazy deletion: a node pushed twice is popped twice; the search skips
// the stale entry via its closed stamp.

export class NodeHeap {
  private ids: Int32Array;
  private fs: Float64Array;
  private hs: Float64Array;
  private n = 0;

  constructor(capacity: number) {
    const cap = Math.max(1, capacity | 0);
    this.ids = new Int32Array(cap);
    this.fs = new Float64Array(cap);
    this.hs = new Float64Array(cap);
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
  }

  /** Grows (x2) when full. */
  push(id: number, f: number, h: number): void {
    if (this.n === this.ids.length) this.grow();
    let i = this.n++;
    // Sift up: indices below `n` are initialised, so the `!` reads are in bounds.
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(f, h, id, this.fs[p]!, this.hs[p]!, this.ids[p]!)) break;
      this.ids[i] = this.ids[p]!;
      this.fs[i] = this.fs[p]!;
      this.hs[i] = this.hs[p]!;
      i = p;
    }
    this.ids[i] = id;
    this.fs[i] = f;
    this.hs[i] = h;
  }

  /** The smallest id (by f, h, id), or -1 when empty. */
  pop(): number {
    if (this.n === 0) return -1;
    const top = this.ids[0]!;
    this.n--;
    if (this.n > 0) {
      const id = this.ids[this.n]!;
      const f = this.fs[this.n]!;
      const h = this.hs[this.n]!;
      let i = 0;
      // Sift down the last leaf from the root.
      for (;;) {
        let c = 2 * i + 1;
        if (c >= this.n) break;
        const r = c + 1;
        if (r < this.n && this.less(this.fs[r]!, this.hs[r]!, this.ids[r]!, this.fs[c]!, this.hs[c]!, this.ids[c]!)) c = r;
        if (!this.less(this.fs[c]!, this.hs[c]!, this.ids[c]!, f, h, id)) break;
        this.ids[i] = this.ids[c]!;
        this.fs[i] = this.fs[c]!;
        this.hs[i] = this.hs[c]!;
        i = c;
      }
      this.ids[i] = id;
      this.fs[i] = f;
      this.hs[i] = h;
    }
    return top;
  }

  private less(fa: number, ha: number, ia: number, fb: number, hb: number, ib: number): boolean {
    if (fa !== fb) return fa < fb;
    if (ha !== hb) return ha < hb;
    return ia < ib;
  }

  private grow(): void {
    const cap = this.ids.length * 2;
    const ids = new Int32Array(cap);
    const fs = new Float64Array(cap);
    const hs = new Float64Array(cap);
    ids.set(this.ids);
    fs.set(this.fs);
    hs.set(this.hs);
    this.ids = ids;
    this.fs = fs;
    this.hs = hs;
  }
}
