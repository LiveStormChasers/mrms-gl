/* ============================================================================
   MRMS-FETCH — pulls the MRMS grid and hands it to MRMSGL
   ----------------------------------------------------------------------------
   Split from the renderer on purpose: the renderer only ever wants a byte per
   grid cell, so the two can be replaced independently.

   The Worker returns the NOAA GRIB re-encoded as a 16-bit greyscale PNG. It is
   decoded here by hand rather than by the browser, because an <img> decode would
   drop it to 8 bits and lose the low end of the scale.

   One request per refresh, against a free and unmetered NOAA feed, through a
   Worker of our own. No key and no quota.
============================================================================ */
(function (global) {
  'use strict';

  // Bytes per pixel is NOT fixed across products. Reflectivity is a 16-bit PNG;
  // azimuthal shear and the rotation tracks are 8-bit. Reading two bytes from an
  // 8-bit image pairs adjacent pixels into meaningless numbers — it decodes
  // without error and yields a spiky, bimodal field that looks like data and is
  // not. The PNG header itself states the bit depth, so read it rather than
  // assume; the worker's nBits agrees but the image is the authority.
  function pngBitDepth(png) {
    // IHDR is always the first chunk: width, height, then bit depth at byte 24.
    return png.length > 25 ? png[24] : 16;
  }

  // Grid size is NOT fixed across products. Reflectivity, MESH and ptype are
  // 7000x3500 at 0.01 degrees; azimuthal shear and the rotation tracks are
  // 14000x7000 at 0.005. Assuming one would sample the other completely wrong
  // and draw something map-shaped and meaningless, so it is read from the
  // worker's X-Grid header on every fetch and passed to the renderer.
  const DEFAULT_NI = 7000, DEFAULT_NJ = 3500;

  async function inflate(bytes) {
    return new Uint8Array(await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
    ).arrayBuffer());
  }

  function idatOf(png) {
    const chunks = [];
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let p = 8;
    while (p < png.length - 12) {
      const len = view.getUint32(p);
      const type = String.fromCharCode(png[p+4], png[p+5], png[p+6], png[p+7]);
      if (type === 'IDAT') chunks.push(png.slice(p + 8, p + 8 + len));
      if (type === 'IEND') break;
      p += 12 + len;
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  // PNG row filters. Undoing these by hand is unavoidable for 16-bit data.
  // One byte per cell, per kind. Each scale is chosen so the useful range fills
  // the byte without clipping anything real:
  //   shear  0.0254 s^-1 is far above any observed couplet
  //   mesh   508mm is larger than any hailstone ever measured
  function encode(v, kind) {
    if (v === null || !isFinite(v) || v < -900) return 0;
    if (kind === 'shear') {
      // Measured against live data: the 8-bit product carries shear already
      // multiplied by 1000, so a 0.020 s^-1 couplet arrives as 20 and the whole
      // useful range sits in single figures to low tens. Multiplying by another
      // 10000 clamped everything at the ceiling.
      // Scaled by 4 here, so the byte holds 0 to 0.0635 s^-1. Measured against a
      // live frame the peak was 0.062, and clamping at 0.031 would have flattened
      // the strongest cells into one colour — the same fault the old dBZ ramp had
      // above 43. The useful range still occupies most of the scale because
      // anything past about 0.02 is rare.
      // Negative shear is anticyclonic — real, but the tornado-relevant signal
      // is cyclonic, so the negative half is dropped rather than folded in.
      if (v <= 0) return 0;
      return Math.max(1, Math.min(254, Math.round(v * 4)));
    }
    if (kind === 'mesh') {
      if (v <= 0) return 0;
      return Math.max(1, Math.min(254, Math.round(v / 2)));
    }
    if (kind === 'category') {
      // Already a small integer. Pass it through untouched — scaling a category
      // would destroy it.
      return (v < 0 || v > 254) ? 0 : Math.round(v);
    }
    // dbz
    if (v < 5 || v > 90) return 0;
    return Math.max(1, Math.min(254, Math.round((v + 30) * 2)));
  }

  function unfilter(raw, NI, NJ, BPP) {
    const rowBytes = 1 + NI * BPP;
    const cur = new Uint8Array(NI * BPP), prev = new Uint8Array(NI * BPP);
    const rows = [];
    for (let j = 0; j < NJ; j++) {
      const rs = j * rowBytes, f = raw[rs];
      const src = raw.subarray(rs + 1, rs + 1 + NI * BPP);
      for (let b = 0; b < NI * BPP; b++) {
        const x = src[b], a = b >= BPP ? cur[b - BPP] : 0, u = prev[b];
        switch (f) {
          case 0: cur[b] = x; break;
          case 1: cur[b] = (x + a) & 255; break;
          case 2: cur[b] = (x + u) & 255; break;
          case 3: cur[b] = (x + ((a + u) >> 1)) & 255; break;
          case 4: {
            const ub = b >= BPP ? prev[b - BPP] : 0;
            const p = a + u - ub, pa = Math.abs(p - a), pb = Math.abs(p - u), pc = Math.abs(p - ub);
            cur[b] = (x + (pa <= pb && pa <= pc ? a : pb <= pc ? u : ub)) & 255;
            break;
          }
          default: cur[b] = x;
        }
      }
      prev.set(cur);
      rows.push(cur.slice());
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Decode pool
  //
  // Unfiltering a 14000x7000 PNG is about 650 ms of tight loop. On the main
  // thread that is 650 ms where the map does not pan, zoom or repaint, and a
  // loop of a dozen frames freezes the page for eight seconds.
  //
  // The decode touches no DOM and no network — it takes bytes and returns bytes
  // — so it moves into workers unchanged. A pool also decodes frames in
  // parallel, so a series gets faster as well as smoother.
  //
  // The worker source is built from a Blob rather than shipped as a second file,
  // so the module stays self-contained and carries no URL of its own.
  // ---------------------------------------------------------------------------
  const WORKER_SRC = `
    ${pngBitDepth.toString()}
    ${idatOf.toString()}
    ${inflate.toString()}
    ${unfilter.toString()}
    ${encode.toString()}

    self.onmessage = async (e) => {
      const { id, png, Ni, Nj, R, E, D, kind } = e.data;
      try {
        const bpp = pngBitDepth(png) === 8 ? 1 : 2;
        const rows = unfilter(await inflate(idatOf(png)), Ni, Nj, bpp);
        const scale = Math.pow(10, D), ef = Math.pow(2, E);
        const out = new Uint8Array(Ni * Nj);
        let k = 0;
        for (let j = 0; j < Nj; j++) {
          const row = rows[j];
          for (let i = 0; i < Ni; i++) {
            const v = bpp === 1 ? row[i] : (row[i * 2] << 8) | row[i * 2 + 1];
            out[k++] = encode((R + v * ef) / scale, kind);
          }
        }
        self.postMessage({ id, out }, [out.buffer]);
      } catch (err) {
        self.postMessage({ id, error: err.message });
      }
    };
  `;

  const Pool = {
    // Four is enough to saturate the network and keep a core free for the map.
    SIZE: 4,
    _workers: null, _next: 0, _seq: 0, _pending: new Map(),

    available() {
      return typeof Worker !== 'undefined' && typeof Blob !== 'undefined';
    },

    _spawn() {
      if (this._workers) return true;
      if (!this.available()) return false;
      try {
        const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
        this._workers = [];
        for (let i = 0; i < this.SIZE; i++) {
          const w = new Worker(url);
          w.onmessage = (e) => {
            const job = this._pending.get(e.data.id);
            if (!job) return;
            this._pending.delete(e.data.id);
            e.data.error ? job.reject(new Error(e.data.error)) : job.resolve(e.data.out);
          };
          this._workers.push(w);
        }
        URL.revokeObjectURL(url);
        return true;
      } catch (e) {
        // Blob workers are blocked by some content security policies. Fall back
        // to decoding inline rather than failing outright.
        this._workers = null;
        return false;
      }
    },

    decode(png, Ni, Nj, R, E, D, kind) {
      if (!this._spawn()) return null;          // caller decodes inline instead
      const id = ++this._seq;
      const w = this._workers[this._next++ % this.SIZE];
      return new Promise((resolve, reject) => {
        this._pending.set(id, { resolve, reject });
        // The buffer is transferred, not copied — a 98 MB grid would otherwise
        // be duplicated on the way in and again on the way out.
        w.postMessage({ id, png, Ni, Nj, R, E, D, kind }, [png.buffer]);
      });
    },

    terminate() {
      if (!this._workers) return;
      this._workers.forEach(w => w.terminate());
      this._workers = null;
      this._pending.clear();
    }
  };

  const MRMSFetch = {
    // Set this before first use. It must point at a proxy that serves
    // /mrms/latest.bin and /mrms/list, returning the raw PNG from GRIB2
    // section 7 with these response headers:
    //
    //   X-Scale     "R,E,D" — the GRIB2 reference value, binary and decimal
    //               scale factors, so the client can recover physical units
    //   X-Grid      "NIxNJ" — the grid dimensions, which differ by product
    //   X-Kind      dbz | shear | mesh | category
    //   X-Modified  the upstream file's Last-Modified, for frame age
    //
    // and with Access-Control-Expose-Headers listing them, or the browser
    // cannot read any of it. MRMS itself is free and unmetered; the proxy exists
    // because NOAA's host sends no CORS header and the files are gzipped GRIB2.
    WORKER: '',
    // hsr       lowest usable tilt — what is reaching the ground
    // composite strongest return anywhere in the column, so broader and hotter
    //           than hsr because it includes precipitation aloft
    // ptype is deliberately absent: PrecipFlag is a CATEGORY, not dBZ, and the
    // worker reports a different scale for it (-3,0,0 against -9990,0,1). The
    // decode below would turn it into nonsense, so it needs its own path first.
    PRODUCTS: ['hsr', 'composite',
               // instant rotation — a couplet, what tvwx uses for the break
               'shear02', 'shear36',
               // accumulated rotation — where it has BEEN, low level then mid
               'rot30', 'rot60', 'rot120', 'rot240', 'rot360', 'rot1440',
               'rotml30', 'rotml60', 'rotml120', 'rotml240', 'rotml360', 'rotml1440',
               'mesh', 'mesh60', 'ptyperefl'],

    // MRMS PrecipFlag, from NOAA's own flag table rather than from memory. An
    // earlier version had two of these backwards — 3 read as freezing rain and 10
    // as snow — which painted cool stratiform rain over Wyoming in snow blue.
    //
    //   -3  no coverage          0   no precipitation
    //    1  warm stratiform rain  3   SNOW
    //    6  convection            7   hail
    //   10  COOL STRATIFORM RAIN  91  tropical stratiform rain
    //                            96  tropical convective rain
    //
    // Flags 2, 4, 5, 8 and 9 are unused, so this product has NO freezing rain and
    // NO sleet category. The mix and ice bands of the four-band palette can never
    // be filled from PrecipFlag — it separates rain from snow and nothing else.
    // Anything claiming otherwise is a mapping error, not winter data.
    //   0xx rain   1xx snow
    PTYPE_BAND: { 1:0, 6:0, 7:0, 10:0, 91:0, 96:0,  3:1 },
    _product: 'hsr',
    _timer: null,
    _lastModified: null,
    _frameAgeMs: null,

    // Returns { data, Ni, Nj, kind, scale } — the decoded grid plus everything
    // needed to draw it. Nothing about the grid is assumed: size comes from the
    // worker's X-Grid header and the packing from X-Scale, because they differ
    // per product (7000x3500 for reflectivity, 14000x7000 for shear).
    //
    // Values are encoded to a byte the renderer can hold as a texture:
    //   dbz    (dbz + 30) * 2   so -30..97 fits 1..254, half a decibel a step
    //   shear  s^-1 * 10000     so 0..0.0254 fits, a couplet is around 0.01
    //   mesh   mm / 2           so 0..508mm fits, 50mm is golfball
    //   0 always means nothing here.
    // Fetch one product and return its PHYSICAL values, before any encoding.
    // Split out of load() so ptypeRefl can combine two products that each need
    // their real units rather than each other's byte encoding.
    async _fetchPhysical(product) {
      if (!this.WORKER) {
        throw new Error('MRMSFetch.WORKER is not set — point it at your proxy before use');
      }
      const res = await fetch(`${this.WORKER}/mrms/latest.bin?product=${product}&t=${Date.now()}`);
      if (!res.ok) throw new Error(`MRMS ${product} HTTP ${res.status}`);
      return this._readPhysical(res, product);
    },

    // Decode a response into physical values. Shared by the latest frame and by
    // any historic one, so the two can never drift apart.
    async _readPhysical(res, product) {

      const kind = res.headers.get('x-kind') || 'dbz';
      // X-Grid is "NIxNJ". The fallback is the reflectivity size, which is what
      // the worker served before the header existed.
      const g = (res.headers.get('x-grid') || '').match(/^(\d+)x(\d+)$/);
      const Ni = g ? +g[1] : DEFAULT_NI;
      const Nj = g ? +g[2] : DEFAULT_NJ;

      const [R, E, D] = (res.headers.get('x-scale') || '-9990,0,1').split(',').map(Number);
      const modified = res.headers.get('x-modified') || null;
      const scale = Math.pow(10, D), ef = Math.pow(2, E);

      const png = new Uint8Array(await res.arrayBuffer());
      const BPP = pngBitDepth(png) === 8 ? 1 : 2;
      const rows = unfilter(await inflate(idatOf(png)), Ni, Nj, BPP);

      const phys = new Float32Array(Ni * Nj);
      let k = 0;
      for (let j = 0; j < Nj; j++) {
        const row = rows[j];
        for (let i = 0; i < Ni; i++) {
          const v = BPP === 1 ? row[i] : (row[i * 2] << 8) | row[i * 2 + 1];
          phys[k++] = (R + v * ef) / scale;
        }
      }
      return { phys, Ni, Nj, kind, modified };
    },

    async _fetchPhysicalAt(product, stamp) {
      const res = await fetch(`${this.WORKER}/mrms/frame/${stamp}.bin?product=${product}`);
      if (!res.ok) throw new Error(`MRMS ${product} ${stamp} HTTP ${res.status}`);
      return this._readPhysical(res, product);
    },

    // Decode straight to the encoded bytes the renderer wants, in a worker when
    // one is available. This is the path every product takes except ptypeRefl,
    // which composes two grids and therefore needs the physical values first.
    async _readEncoded(res, product) {
      const kind = res.headers.get('x-kind') || 'dbz';
      const g = (res.headers.get('x-grid') || '').match(/^(\d+)x(\d+)$/);
      const Ni = g ? +g[1] : DEFAULT_NI;
      const Nj = g ? +g[2] : DEFAULT_NJ;
      const [R, E, D] = (res.headers.get('x-scale') || '-9990,0,1').split(',').map(Number);
      const modified = res.headers.get('x-modified') || null;
      const png = new Uint8Array(await res.arrayBuffer());

      const viaPool = Pool.decode(png, Ni, Nj, R, E, D, kind);
      if (viaPool) {
        return { data: await viaPool, Ni, Nj, kind, modified };
      }

      // No worker available — same work, on this thread.
      const BPP = pngBitDepth(png) === 8 ? 1 : 2;
      const rows = unfilter(await inflate(idatOf(png)), Ni, Nj, BPP);
      const scale = Math.pow(10, D), ef = Math.pow(2, E);
      const data = new Uint8Array(Ni * Nj);
      let k = 0;
      for (let j = 0; j < Nj; j++) {
        const row = rows[j];
        for (let i = 0; i < Ni; i++) {
          const v = BPP === 1 ? row[i] : (row[i * 2] << 8) | row[i * 2 + 1];
          data[k++] = encode((R + v * ef) / scale, kind);
        }
      }
      return { data, Ni, Nj, kind, modified };
    },

    async load() {
      // ptypeRefl is not a product the worker serves — it is built here from two
      // that it does. The Fox Weather palette wants reflectivity shaded inside a
      // category, and MRMS publishes those separately: PrecipFlag carries the
      // category with no intensity, SeamlessHSR the intensity with no category.
      if (this._product === 'ptyperefl') return this._loadPtypeRefl();

      if (!this.WORKER) {
        throw new Error('MRMSFetch.WORKER is not set — point it at your proxy before use');
      }
      const res = await fetch(`${this.WORKER}/mrms/latest.bin?product=${this._product}&t=${Date.now()}`);
      if (!res.ok) throw new Error(`MRMS ${this._product} HTTP ${res.status}`);
      const kindHdr = res.headers.get('x-kind');
      if (kindHdr && kindHdr !== 'dbz' && kindHdr !== 'shear' && kindHdr !== 'mesh') {
        throw new Error(`Product "${this._product}" is ${kindHdr} data`);
      }
      const f = await this._readEncoded(res, this._product);
      this._lastModified = f.modified;
      return { data: f.data, Ni: f.Ni, Nj: f.Nj, kind: f.kind, product: this._product };
    },

    // Combine PrecipFlag and SeamlessHSR into the category*100 + dBZ field the
    // Fox Weather palette was built and tested against. Both are 7000x3500 so
    // they align cell for cell — checked rather than assumed, because a silent
    // mismatch would paint snow colours over the wrong ground.
    async _loadPtypeRefl() {
      const [flag, refl] = await Promise.all([
        this._fetchPhysical('ptype'),
        this._fetchPhysical('hsr')
      ]);

      return this._composePtype(flag, refl);
    },

    // Compose PrecipFlag and reflectivity into the packed category*100 + dBZ field.
    // Split out so a historic pair composes exactly as the live pair does.
    _composePtype(flag, refl) {
      if (flag.Ni !== refl.Ni || flag.Nj !== refl.Nj) {
        throw new Error(`ptype grid ${flag.Ni}x${flag.Nj} does not match ` +
                        `reflectivity ${refl.Ni}x${refl.Nj}`);
      }

      const n = flag.Ni * flag.Nj;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const band = this.PTYPE_BAND[Math.round(flag.phys[i])];
        if (band === undefined) continue;            // none, or outside coverage
        const dbz = refl.phys[i];
        if (!(dbz > 0)) continue;                    // a category with no echo draws nothing
        // Scaled to a byte across the palette's 0..360 range, because the
        // texture is 8-bit. 360/255 is about 1.4 units per step, which is finer
        // than the palette's own stop spacing, so nothing is lost.
        const v = band * 100 + Math.min(94, dbz);
        out[i] = Math.max(1, Math.min(255, Math.round(v / 360 * 255)));
      }
      this._lastModified = flag.modified || refl.modified || null;
      return { data: out, Ni: flag.Ni, Nj: flag.Nj, kind: 'ptyperefl', product: 'ptyperefl' };
    },

    // One historic frame. The proxy serves these from NOAA's own directory, which
    // holds roughly a day of files, so nothing is stored anywhere.
    async loadAt(stamp) {
      if (!this.WORKER) throw new Error('MRMSFetch.WORKER is not set');
      if (this._product === 'ptyperefl') {
        // Composed from two products, so both halves must come from the same run.
        const [flag, refl] = await Promise.all([
          this._fetchPhysicalAt('ptype', stamp),
          this._fetchPhysicalAt('hsr', stamp)
        ]);
        return this._composePtype(flag, refl);
      }
      const res = await fetch(`${this.WORKER}/mrms/frame/${stamp}.bin?product=${this._product}`);
      if (!res.ok) throw new Error(`MRMS ${this._product} ${stamp} HTTP ${res.status}`);
      const f = await this._readEncoded(res, this._product);
      return { data: f.data, Ni: f.Ni, Nj: f.Nj, kind: f.kind, product: this._product, stamp };
    },

    // Load a run of frames, newest last, reporting progress as each arrives.
    // Frames are fetched in order rather than all at once: a dozen 14000x7000
    // grids in parallel is 1.2 GB of decode competing for one main thread, and
    // the browser stops painting. Sequential is slower to finish and stays
    // usable throughout, which matters more.
    // Decoded frames, keyed product+stamp. A historic frame never changes, so a
    // second loop over the same window costs nothing — which is the difference
    // between a loop that starts instantly and one that spends nine seconds
    // refetching what it already had.
    //
    // Capped because these are large: a 14000x7000 frame is 98 MB, so twelve of
    // them is over a gigabyte. Oldest out first.
    _cache: new Map(),
    CACHE_MAX: 10,

    _cacheGet(key) {
      const hit = this._cache.get(key);
      if (hit) {                       // refresh recency
        this._cache.delete(key);
        this._cache.set(key, hit);
      }
      return hit;
    },

    _cachePut(key, frame) {
      this._cache.set(key, frame);
      while (this._cache.size > this.CACHE_MAX) {
        this._cache.delete(this._cache.keys().next().value);
      }
    },

    clearCache() { this._cache.clear(); },
    cacheSize() { return this._cache.size; },

    async loadSeries(count, onFrame) {
      const stamps = (await this.times()).slice(-count);

      // Run a few at a time rather than one after another. With the decode in
      // workers the limit is no longer the main thread, so the wall clock drops
      // roughly by the width of this window. It is not unlimited: every frame in
      // flight is a full grid held in memory, and a dozen 14000x7000 grids at
      // once is over a gigabyte.
      const WIDTH = Pool.available() ? 4 : 1;
      const frames = new Array(stamps.length);
      let done = 0, cursor = 0;

      const runOne = async () => {
        while (cursor < stamps.length) {
          const idx = cursor++;
          const stamp = stamps[idx];
          try {
            const key = this._product + '@' + stamp;
            const cached = this._cacheGet(key);
            const f = cached || await this.loadAt(stamp);
            if (!cached) this._cachePut(key, f);
            frames[idx] = f;
            if (onFrame) onFrame(f, ++done, stamps.length);
          } catch (e) {
            // A missing frame is normal — NOAA prunes while the listing is read.
            // Skip it rather than abandoning the whole loop.
            done++;
            if (typeof console !== 'undefined') console.warn('[MRMS] frame', stamp, e.message);
          }
        }
      };

      await Promise.all(Array.from({ length: WIDTH }, runOne));
      // Holes where a frame failed are dropped, and order is preserved because
      // each result went into its own slot rather than being pushed on arrival.
      return frames.filter(Boolean);
    },


    // The worker serves only the newest frame: /mrms/latest.bin ignores ?t= and
    // ?time=, and /mrms/<stamp>.bin is a 404 — all three return an identical
    // body. /mrms/list reports which runs exist upstream but nothing can fetch
    // them, so a loop is not possible from the client as things stand. It needs
    // either a worker route that accepts a timestamp, or the worker retaining
    // recent frames as they arrive.

    // Refresh cadence matches the previous renderer: MRMS publishes about every
    // two minutes, so 90s never misses a run without hammering the Worker.
    start(onData, everyMs) {
      this.stop();
      const tick = async () => {
        try { onData(await this.load(), this._lastModified); }
        catch (e) { if (global.console) console.warn('[MRMS]', e.message); }
      };
      tick();
      this._timer = setInterval(tick, everyMs || 90000);
    },

    stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } },
    lastModified() { return this._lastModified; },

    // Which MRMS product to fetch. Takes effect on the next load, so callers
    // that want it immediately should stop(), set, then start() again.
    setProduct(p) {
      if (this.PRODUCTS.indexOf(p) === -1) return false;
      this._product = p;
      return true;
    },
    product() { return this._product; },

    // How far behind real time the drawn frame is. MRMS publishes on a strict
    // two-minute cadence roughly a minute behind live, so healthy is about
    // 1 to 3 minutes; much beyond that means the feed has stalled.
    frameAgeMs() {
      return this._lastModified ? (Date.now() - Date.parse(this._lastModified)) : null;
    },

    // Timestamps that exist UPSTREAM, newest last. Note these cannot currently
    // be fetched — see the note above. Useful only for showing what is available.
    async times() {
      const r = await fetch(`${this.WORKER}/mrms/list?product=${this._product}`);
      if (!r.ok) throw new Error('MRMS list HTTP ' + r.status);
      const j = await r.json();
      // The worker lists each run twice; collapse to unique, ordered.
      return [...new Set(j.times || [])].sort();
    }
  };

  global.MRMSFetch = MRMSFetch;
})(window);
