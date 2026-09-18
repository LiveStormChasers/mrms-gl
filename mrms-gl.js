/* ============================================================================
   MRMS-GL — GPU-rendered MRMS reflectivity for Mapbox GL JS
   ----------------------------------------------------------------------------
   Live Storm Chasers.  Loaded from its own deployment; the host page only calls
   MRMSGL.attach(map) and MRMSGL.detach().

   WHY THIS EXISTS
   The previous renderer decoded the 7000x3500 MRMS grid, drew it once into an
   8192px canvas, and handed Mapbox a static image. That is sharp when zoomed
   out — 0.73 km per pixel against MRMS's native 0.85 km — but the single image
   is then stretched as you zoom in: measured at 12x by zoom 11 and 50x by zoom
   13, which is where it goes soft.

   Here the decoded grid goes to the GPU as a texture and is sampled per screen
   pixel, every frame, so there is no fixed resolution to outrun. This is what
   a tile-based SDK does; it costs nothing extra because the data fetch is
   unchanged — one request every 90 seconds to a Worker of our own, against a
   free and unmetered NOAA feed.

   NO KEY, NO ACCOUNT, NO QUOTA.

   THREE THINGS THAT ARE NOT OBVIOUS
   1. Mapbox custom layers render in Web Mercator world coordinates, not screen
      pixels. The vertex shader converts lon/lat to mercator itself.
   2. WebGL 1 has no integer textures. The reflectivity byte is carried in the
      LUMINANCE channel, and the colour ramp is a second 1-D texture sampled by
      that value — the same trick MapsGL uses.
   3. GL_LINEAR on the data texture is what produces the smoothing. It must be
      off for the colour ramp, or bands bleed into each other.
============================================================================ */
(function (global) {
  'use strict';

  const VERSION = '0.1.0';

  // MRMS CONUS extent. The BOUNDS are the same for every 2D product, but the
  // grid SIZE is not: reflectivity, MESH and ptype are 7000x3500 at 0.01
  // degrees, while azimuthal shear and the rotation tracks are 14000x7000 at
  // 0.005. Size therefore arrives with each frame rather than being a constant
  // here — assuming one would sample the other wrong and draw nonsense.
  const GRID = { lonW: -129.995, lonE: -60.005, latN: 54.995, latS: 20.005 };
  const FALLBACK_NI = 7000, FALLBACK_NJ = 3500;

  // ---------------------------------------------------------------------------
  // Colour ramp.  dBZ -> hex, irregularly spaced, interpolated into 256 texels.
  // A conventional reflectivity scale: cyan at
  // the bottom, greens from 14.5, yellow at 34.5, red at 44.5, magenta at 54.5,
  // then a grey tail to white. The old ramp stopped at 43 dBZ and clamped, so
  // every core above that drew as one flat near-white blob with no structure.
  // ---------------------------------------------------------------------------
  const RAMP = [
    [0,'#01f3f7'],[1,'#05dbe7'],[2,'#09c3d7'],[3,'#0dabc7'],[3.5,'#0fc3bf'],[4,'#1193b7'],
    [5,'#157ba7'],[8.5,'#1081bb'],[10.5,'#0b8cce'],[12.5,'#0798ff'],[13,'#069be6'],
    [14,'#15bfb4'],[14.5,'#25e17d'],[16.5,'#21d370'],[18.5,'#1dc563'],[21,'#18b454'],
    [23,'#15a747'],[25,'#119a3b'],[27,'#0e8c2e'],[29,'#0a7f22'],[31,'#067115'],[33,'#026409'],
    [34,'#80af13'],[34.5,'#ffff21'],[36,'#ffe712'],[37.5,'#ffcf04'],[39,'#ffb700'],
    [40.5,'#ff8c00'],[41.5,'#ff6900'],[42.5,'#ff4600'],[43.5,'#ff2300'],[44.5,'#ff0000'],
    [47,'#e40000'],[49.5,'#c90000'],[52.5,'#aa0000'],[54.5,'#b400b4'],[55.5,'#c013be'],
    [56.5,'#cc27c9'],[57.5,'#d83bd3'],[58.5,'#e54ede'],[59.5,'#f162e8'],[60.5,'#fd75f3'],
    [61,'#e86de8'],[61.5,'#d468cc'],[62,'#c05db8'],[62.5,'#ab55a5'],[63,'#974d92'],
    [63.5,'#83457e'],[64,'#6f3d6b'],[64.5,'#5a3558'],[65,'#462d44'],[65.5,'#322531'],
    [66,'#1d1e1d'],[67.5,'#292a29'],[69,'#353635'],[70.5,'#414241'],[72,'#4d4e4d'],
    [73.5,'#595a59'],[75,'#656665'],[76.5,'#717271'],[78,'#7d7e7d'],[79.5,'#898a89'],
    [81,'#969696'],[82.5,'#a2a2a2'],[84,'#aeaeae'],[85.5,'#bababa'],[87,'#c6c6c6'],
    [88.5,'#d2d2d2'],[90,'#dedede'],[91.5,'#eaeaea'],[93,'#f6f6f6'],[94.5,'#ffffff'],
    [100,'#ffffff']
  ];

  // The byte in the data texture encodes dBZ as (dbz + 30) * 2, so 0 dBZ is 60
  // and 94.5 dBZ is 249. Building the ramp in that same space means the shader
  // does a single texture read with no arithmetic.
  const ENC_OFF = 30, ENC_MUL = 2;

  function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // Which 256-texel ramp a frame gets, by what the frame actually holds.
  function rampFor(kind) {
    // 4000 = the product's own x1000 times the fetcher's x4. Changing one of
    // those without the other silently shifts every colour on the shear scale.
    if (kind === 'shear')    return scaledRampTexels(SHEAR_RAMP, 4000);
    if (kind === 'mesh')     return scaledRampTexels(MESH_RAMP, 0.5);
    if (kind === 'category') return categoryTexels(PTYPE_COLOURS);
    if (kind === 'ptyperefl') return ptypeRefTexels();
    return buildRampTexels();
  }

  // ptypeRefl is the only product whose values are not a measurement on one
  // scale: the number is category*100 + dBZ, spanning 2.5 to 360. A byte cannot
  // hold that, so the fetcher hands over Float32 and the texture carries the
  // value scaled into 0..1 across the palette's own range.
  const PTYPEREFL_MAX = 360;
  // rain, snow, mix, ice — matching the palette's own band layout.
  const PTYPEREFL_BANDS = [[2.5, 94], [105, 170], [205, 270], [305, 360]];
  function ptypeRefTexels() {
    const out = new Uint8Array(256 * 4);
    const hx = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
    for (let t = 1; t < 256; t++) {
      const v = (t / 255) * PTYPEREFL_MAX;
      // Gaps between the bands are dead space — nothing should draw there.
      let k = -1;
      for (let i = 0; i < PTYPEREFL_RAMP.length; i++) {
        if (PTYPEREFL_RAMP[i][0] <= v) k = i; else break;
      }
      if (k < 0) { out[t*4+3] = 0; continue; }
      // The bands have explicit ranges; anything between them is dead space.
      // A gap-width heuristic was wrong here — rain ends at 94 and snow starts
      // at 105, an 11-unit gap, narrower than snow's own 10-unit stop spacing,
      // so no threshold separates them. Ranges are unambiguous.
      if (!PTYPEREFL_BANDS.some(([lo, hi]) => v >= lo && v <= hi)) { out[t*4+3] = 0; continue; }
      const [v0, c0] = PTYPEREFL_RAMP[k];
      const next = PTYPEREFL_RAMP[k + 1];
      // Do not interpolate across a band boundary into the next category.
      const sameBand = next && PTYPEREFL_BANDS.some(([lo, hi]) => v0 >= lo && next[0] <= hi);
      let col = hx(c0);
      if (sameBand && next[0] > v0) {
        const f = Math.min(1, (v - v0) / (next[0] - v0));
        const c1 = hx(next[1]);
        col = col.map((c, i) => Math.round(c + f * (c1[i] - c)));
      }
      out[t*4] = col[0]; out[t*4+1] = col[1]; out[t*4+2] = col[2]; out[t*4+3] = 255;
    }
    return out;
  }

  // Stops given in real units; mul converts a unit to its texel index, matching
  // the encoding the fetcher applied.
  function scaledRampTexels(stops, mul) {
    const out = new Uint8Array(256 * 4);
    for (let enc = 1; enc < 256; enc++) {
      const v = enc / mul;
      if (v < stops[0][0]) { out[enc * 4 + 3] = 0; continue; }
      let i = 0;
      while (i < stops.length - 1 && stops[i + 1][0] <= v) i++;
      const [v0, c0] = stops[i];
      const [v1, c1] = stops[Math.min(i + 1, stops.length - 1)];
      const t = v1 === v0 ? 0 : (v - v0) / (v1 - v0);
      const a = hexToRgb(c0), b = hexToRgb(c1);
      out[enc * 4]     = Math.round(a[0] + t * (b[0] - a[0]));
      out[enc * 4 + 1] = Math.round(a[1] + t * (b[1] - a[1]));
      out[enc * 4 + 2] = Math.round(a[2] + t * (b[2] - a[2]));
      out[enc * 4 + 3] = 255;
    }
    return out;
  }

  // Flat colours, no interpolation — blending two categories would invent a
  // third that means nothing.
  function categoryTexels(map) {
    const out = new Uint8Array(256 * 4);
    for (const k in map) {
      const i = +k, c = hexToRgb(map[k]);
      if (i < 1 || i > 255) continue;
      out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
    }
    return out;
  }

  function buildRampTexels() {
    const out = new Uint8Array(256 * 4);
    for (let enc = 0; enc < 256; enc++) {
      const dbz = enc / ENC_MUL - ENC_OFF;
      if (enc === 0 || dbz < RAMP[0][0]) { out[enc * 4 + 3] = 0; continue; }  // transparent
      let i = 0;
      while (i < RAMP.length - 1 && RAMP[i + 1][0] <= dbz) i++;
      const [d0, c0] = RAMP[i];
      const [d1, c1] = RAMP[Math.min(i + 1, RAMP.length - 1)];
      const t = d1 === d0 ? 0 : (dbz - d0) / (d1 - d0);
      const a = hexToRgb(c0), b = hexToRgb(c1);
      out[enc * 4]     = Math.round(a[0] + t * (b[0] - a[0]));
      out[enc * 4 + 1] = Math.round(a[1] + t * (b[1] - a[1]));
      out[enc * 4 + 2] = Math.round(a[2] + t * (b[2] - a[2]));
      out[enc * 4 + 3] = 255;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Palettes for the non-reflectivity products.
  //
  // SHEAR — azimuthal shear in s^-1, encoded as value*10000, so a texel index of
  // 100 is 0.01 s^-1. Thresholds follow how forecasters read it: below about
  // 0.003 is noise and clutter, 0.005 is worth a look, 0.010 is a solid
  // couplet, and past 0.015 is strong rotation. Kept deliberately dull at the
  // bottom and loud at the top so a weak field does not read as a threat.
  // Measured on a live frame: 423,602 cells below 0.005, 2,450 between 0.005 and
  // 0.010, 83 above 0.010, and a single cell at 0.062. So the scale is deliberately
  // uneven — most of its width covers the range a couplet actually lives in, and
  // the long thin tail above 0.02 gets the last few stops rather than half the ramp.
  // Rotation scale in real s^-1 rather than an
  // invented one. Greys for weak shear, olive into yellow through the middle,
  // red for a couplet, then cyan at the top end.
  //
  // It stops at 0.020. Measured frames reach 0.062, so everything above 0.020
  // holds the last colour rather than being clipped out — the palette's author
  // chose where the scale ends and that is respected, but nothing vanishes.
  // Rotation scale, fitted to what the data actually contains rather than to a
  // picture of someone else's map. Measured over an hour of tracks across
  // southern Minnesota: 41% of cells sit at 0.003 s^-1, 80% below 0.005, 94%
  // below 0.007, and the peak was 0.016.
  //
  // So the yellows cover 0.003 to 0.005 where the bulk lives, oranges and reds
  // take 0.005 to 0.008, and the bright end is reserved for the top few percent.
  // An earlier version put yellow at 0.009, which is above 98% of the data, so
  // entire tracks rendered as featureless grey.
  //
  // Below 0.0025 nothing is drawn. That is not noise-trimming for its own sake:
  // without it the weak field fills every gap and the tracks stop reading as
  // tracks.
  // Rotation scale, fitted to the measured distribution. Over an hour of tracks
  // across southern Minnesota: 41% of cells at 0.003 s^-1, 66% below 0.004,
  // 80% below 0.005, 94% below 0.007, peak 0.016.
  //
  // So roughly two thirds of the field is grey, a quarter yellow, and only a few
  // percent reach orange or red. That proportion is the whole point — it is what
  // makes a track read as a track with a hot core rather than a solid slab.
  //
  // Two earlier versions got this wrong in opposite directions. Yellow at 0.009
  // is above 98% of the data, so everything rendered featureless grey. Yellow at
  // 0.003 is below 60% of it, so everything rendered hot.
  // Rotation scale, anchored to operational thresholds rather than fitted to a
  // quiet afternoon. From the NWS azimuthal shear guidance:
  //
  //   0.005   marginal, common in any convective line
  //   0.010   a mesocyclone is likely
  //   0.015   strong rotation
  //   0.020   significant, the range a tornadic supercell occupies
  //   0.030+  extreme
  //
  // This matters more than matching any one screenshot. A scale fitted to a
  // particular day makes weak rotation look dangerous, and on a broadcast that
  // is a real problem, not a cosmetic one. An earlier version put red at 0.0085
  // and painted a marginal Minnesota line the colour of a tornadic supercell.
  //
  // The consequence is that quiet days look quiet, which is correct. Most of a
  // weak field sits below 0.005 and stays grey.
  const SHEAR_RAMP = [
    [0.0030,'#9a9a9a'],[0.0040,'#b0b0a8'],[0.0050,'#c8c880'],[0.0060,'#e0e040'],
    [0.0075,'#ffff00'],[0.0090,'#ffd800'],[0.0100,'#ffa800'],[0.0120,'#ff7000'],
    [0.0150,'#ff2000'],[0.0175,'#d00000'],[0.0200,'#ff44ff'],[0.0250,'#ff99ff'],
    [0.0300,'#ffffff'],[0.0400,'#ffffff']
  ];
;
;
;
;

  // MESH — maximum estimated hail size, encoded as mm/2. The breaks are the
  // sizes that matter operationally rather than an even spread: 25mm is the
  // severe criterion, 50mm is golfball, 70mm is baseball.
  const MESH_RAMP = [
    [6,'#00c8ff'],[13,'#00ff96'],[19,'#64ff00'],[25,'#ffff00'],
    [32,'#ffaa00'],[44,'#ff5000'],[57,'#ff0000'],[70,'#ff00ff'],
    [90,'#b400ff'],[120,'#ffffff']
  ];

  // PrecipFlag categories. Not a scale at all — each value is a distinct thing,
  // so these are flat colours with no interpolation between them.
  // A four-band precipitation-type palette, carried over unchanged from a
  // deployed and tested elsewhere. One scale, four bands, the hundreds
  // digit selecting the category:
  //   rain 2.5-94 (147 stops)  snow 105-170 (10)  mix 205-270 (12)  ice 305-360 (10)
  // Do not "tidy" this into four separate ramps — the product encodes category
  // and intensity in one number and the palette is built to match.
  const PTYPEREFL_RAMP = [
    [2.5,'#31e8a5'],
    [3,'#31e8a5'],
    [3.5,'#31e8a5'],
    [4,'#31e8a5'],
    [4.5,'#31e8a5'],
    [5,'#31e8a5'],
    [5.5,'#31e5a2'],
    [6,'#2ce29f'],
    [6.5,'#31df9c'],
    [7,'#31dc99'],
    [7.5,'#31d996'],
    [8,'#2fd693'],
    [8.5,'#31d390'],
    [9,'#32d18e'],
    [9.5,'#32ce8b'],
    [10,'#32cb88'],
    [10.5,'#32c885'],
    [11,'#32c582'],
    [11.5,'#32c289'],
    [12,'#32bf7c'],
    [12.5,'#32bc79'],
    [13,'#33ba77'],
    [13.5,'#33b774'],
    [14,'#33b471'],
    [14.5,'#33b16e'],
    [15,'#33ae6b'],
    [15.5,'#33ab68'],
    [16,'#33a865'],
    [16.5,'#34a663'],
    [17,'#34a360'],
    [17.5,'#34a05d'],
    [18,'#349d5a'],
    [18.5,'#349a57'],
    [19,'#349754'],
    [19.5,'#349451'],
    [20,'#34914f'],
    [20.5,'#318e4c'],
    [21,'#2f8b49'],
    [21.5,'#2d8846'],
    [22,'#2b8643'],
    [22.5,'#288341'],
    [23,'#26803e'],
    [23.5,'#247d3b'],
    [24,'#227b38'],
    [24.5,'#1f7835'],
    [25,'#1d7533'],
    [25.5,'#1b7230'],
    [26,'#19702d'],
    [26.5,'#166d2a'],
    [27,'#146a27'],
    [27.5,'#126725'],
    [28,'#106522'],
    [28.5,'#0d621f'],
    [29,'#0b5f1c'],
    [29.5,'#095c19'],
    [30,'#075a17'],
    [30.5,'#065515'],
    [31,'#065114'],
    [31.5,'#064d13'],
    [32,'#054812'],
    [32.5,'#054410'],
    [33,'#05400f'],
    [33.5,'#043b0e'],
    [34,'#04370d'],
    [34.5,'#04330c'],
    [35,'#ffff21'],
    [35.5,'#fff81f'],
    [36,'#fff11d'],
    [36.5,'#ffea1b'],
    [37,'#ffe41a'],
    [37.5,'#ffdd18'],
    [38,'#ffd616'],
    [38.5,'#ffcf14'],
    [39,'#ffc913'],
    [39.5,'#ffc211'],
    [40,'#ffbb0f'],
    [40.5,'#ffb40d'],
    [41,'#ffae0c'],
    [41.5,'#ffa70a'],
    [42,'#ffa008'],
    [42.5,'#ff9906'],
    [43,'#ff9305'],
    [43.5,'#ff8c03'],
    [44,'#ff8501'],
    [44.5,'#ff7f00'],
    [45,'#ff0000'],
    [45.5,'#fa0000'],
    [46,'#f60000'],
    [46.5,'#f20000'],
    [47,'#ed0000'],
    [47.5,'#e90000'],
    [48,'#e50000'],
    [48.5,'#e10000'],
    [49,'#dc0000'],
    [49.5,'#d80000'],
    [50,'#cf0000'],
    [50.5,'#c60000'],
    [51,'#bd0000'],
    [51.5,'#b40000'],
    [52,'#ab0000'],
    [52.5,'#a20000'],
    [53,'#990000'],
    [53.5,'#900000'],
    [54,'#870000'],
    [54.5,'#7e0000'],
    [55,'#b400b4'],
    [55.5,'#b705b6'],
    [56,'#ba0ab9'],
    [56.5,'#bd0fbc'],
    [57,'#c014be'],
    [57.5,'#c419c1'],
    [58,'#c71ec4'],
    [58.5,'#ca24c7'],
    [59,'#cd29c9'],
    [59.5,'#d02ecc'],
    [60,'#d433cf'],
    [60.5,'#d738d2'],
    [61,'#da3dd4'],
    [61.5,'#dd43d7'],
    [62,'#e048da'],
    [62.5,'#e44ddd'],
    [63,'#e752df'],
    [63.5,'#ea57e2'],
    [64,'#ed5ce5'],
    [64.5,'#f162e7'],
    [65,'#5a3558'],
    [65.5,'#5a3558'],
    [66,'#5a3558'],
    [66.5,'#5a3558'],
    [67,'#5a3558'],
    [67.5,'#5a3558'],
    [68,'#5a3558'],
    [68.5,'#5a3558'],
    [69,'#5a3558'],
    [69.5,'#5a3558'],
    [70,'#393a39'],
    [70.5,'#393a39'],
    [71,'#393a39'],
    [71.5,'#393a39'],
    [72,'#393a39'],
    [72.5,'#393a39'],
    [73,'#393a39'],
    [73.5,'#393a39'],
    [74,'#393a39'],
    [74.5,'#393a39'],
    [75,'#ffffff'],
    [94,'#ffffff'],
    [105,'#0f6caa'],
    [110,'#167eba'],
    [115,'#1e90cb'],
    [120,'#26a3dc'],
    [125,'#59c4e9'],
    [130,'#8ce6f6'],
    [135,'#ffffff'],
    [140,'#ffffff'],
    [150,'#cfcfcf'],
    [160,'#a0a0a0'],
    [205,'#e5b5ff'],
    [210,'#e89ef1'],
    [215,'#eb87e3'],
    [220,'#ee71d6'],
    [225,'#f15dc8'],
    [230,'#f449bb'],
    [235,'#f735ad'],
    [240,'#fb21a0'],
    [245,'#eb1c92'],
    [250,'#dc1784'],
    [255,'#cd1276'],
    [260,'#be0e68'],
    [305,'#af5fff'],
    [310,'#a658f4'],
    [315,'#9d52ea'],
    [320,'#954cdf'],
    [325,'#8c46d5'],
    [330,'#8440cb'],
    [335,'#7b3ac0'],
    [340,'#7334b6'],
    [350,'#6128a1'],
    [360,'#592297']
  ];

  const PTYPE_COLOURS = {
    1:'#00c800',  3:'#ff00ff',  4:'#ff64ff',  6:'#00ffff',
    7:'#0096ff', 10:'#00c800', 91:'#ffc800', 96:'#ff6400'
  };

  // ---------------------------------------------------------------------------
  // GRLevelX / RadarScope .pal colour tables
  //
  // Per the GRLevelX Color Table File Specification:
  //   Color:       value r g b [r2 g2 b2]        gradient from this value to the next
  //   Color4:      value r g b a [r2 g2 b2 a2]
  //   SolidColor:  value r g b [..]              constant band from this value up
  //   SolidColor4: value r g b a [..]
  //   ;  starts a comment, to end of line
  //   Units:, Step:, Product:, Category:, RF:, ND:  are metadata we ignore
  //
  // The second colour, where given, is what the band fades TO by the next stop.
  // Without it the band fades to the next stop's first colour. SolidColor does
  // not fade at all. Getting that distinction wrong is what makes a ported
  // palette look close but not right.
  //
  // Only DBZ tables make sense here — a velocity or ptype table would apply its
  // numbers to reflectivity and silently mislead. parsePal returns the declared
  // units so the caller can refuse.
  // ---------------------------------------------------------------------------
  function parsePal(text) {
    const stops = [];
    let units = null, product = null;
    let sawKeyword = false;

    for (let raw of String(text).split(/\r?\n/)) {
      // ; and # both start comments in the wild; // appears in ColorTable blocks.
      let line = raw.replace(/\/\/.*$/, '');
      const c = line.search(/[;#]/);
      if (c >= 0) line = line.slice(0, c);
      line = line.trim();
      if (!line || line === '{' || line === '}') continue;

      // --- ColorTable 3.x block:  Color[50] = gradient( rgb(255,0,0), rgb(160,0,0) )
      const ct = line.match(/^Color\s*\[\s*(-?[\d.]+)\s*\]\s*=\s*(.+)$/i);
      if (ct) {
        sawKeyword = true;
        const value = parseFloat(ct[1]);
        const cols = [...ct[2].matchAll(/rgba?\s*\(([^)]*)\)/gi)]
          .map(mm => mm[1].split(/[\s,]+/).map(Number).filter(x => !isNaN(x)));
        if (!cols.length) continue;
        const pad = a => [a[0] | 0, a[1] | 0, a[2] | 0, a.length > 3 ? a[3] | 0 : 255];
        stops.push({
          value,
          solid: /solid/i.test(ct[2]),
          from: pad(cols[0]),
          to: cols[1] ? pad(cols[1]) : null
        });
        continue;
      }

      // --- metadata and legacy keyword lines
      const kv = line.match(/^(\w+)\s*[:=]\s*(.*)$/);
      if (kv) {
        const key = kv[1].toLowerCase();
        const rest = kv[2].trim().replace(/^["']|["']$/g, '');
        if (key === 'units') { units = rest; sawKeyword = true; continue; }
        if (key === 'product' || key === 'category') { product = rest; sawKeyword = true; continue; }

        if (key === 'color' || key === 'color4' ||
            key === 'solidcolor' || key === 'solidcolor4') {
          sawKeyword = true;
          const n = rest.split(/[\s,]+/).map(Number).filter(x => !isNaN(x));
          const hasAlpha = key.endsWith('4');
          const size = hasAlpha ? 4 : 3;
          if (n.length < 1 + size) continue;
          const a = n.slice(1, 1 + size);
          const b = n.length >= 1 + size * 2 ? n.slice(1 + size, 1 + size * 2) : null;
          stops.push({
            value: n[0],
            solid: key.startsWith('solid'),
            from: [a[0], a[1], a[2], hasAlpha ? a[3] : 255],
            to:   b ? [b[0], b[1], b[2], hasAlpha ? b[3] : 255] : null
          });
          continue;
        }
        // Step:, RF:, ND: and anything else is metadata we do not need.
        if (key === 'step' || key === 'rf' || key === 'nd' ||
            key === 'scale' || key === 'offset' || key === 'colortable') {
          sawKeyword = true; continue;
        }
        continue;
      }

      // --- bare numeric rows:  value r g b [a]
      // WSV3 and several hand-rolled tables use no keywords at all. A repeated
      // value is a deliberate hard break between bands, which falls out of
      // interpolating between consecutive points.
      const n = line.split(/[\s,]+/).map(Number);
      if (n.length >= 4 && n.every(x => !isNaN(x))) {
        stops.push({
          value: n[0],
          solid: false,
          from: [n[1] | 0, n[2] | 0, n[3] | 0, n.length > 4 ? n[4] | 0 : 255],
          to: null
        });
      }
    }

    // Stable sort: equal values must keep file order or the hard breaks inv
    // themselves and the bands come out reversed.
    stops.forEach((st, k) => { st._i = k; });
    stops.sort((x, y) => (x.value - y.value) || (x._i - y._i));
    stops.forEach(st => { delete st._i; });

    return { stops, units, product, sawKeyword };
  }

  // Turn parsed stops into the 256 texels the shader samples. Mirrors how the
  // built-in palette is built so both paths behave identically.
  function palTexels(stops) {
    const out = new Uint8Array(256 * 4);
    if (!stops.length) return out;

    for (let enc = 0; enc < 256; enc++) {
      const dbz = enc / ENC_MUL - ENC_OFF;
      if (enc === 0 || dbz < stops[0].value) { out[enc * 4 + 3] = 0; continue; }

      let i = 0;
      while (i < stops.length - 1 && stops[i + 1].value <= dbz) i++;
      const cur = stops[i], next = stops[i + 1] || null;

      let col;
      if (cur.solid || !next) {
        col = cur.from;
      } else {
        const end = cur.to || next.from;
        const span = next.value - cur.value;
        const t = span <= 0 ? 0 : (dbz - cur.value) / span;
        col = [0, 1, 2, 3].map(k => Math.round(cur.from[k] + t * (end[k] - cur.from[k])));
      }
      out[enc * 4]     = col[0];
      out[enc * 4 + 1] = col[1];
      out[enc * 4 + 2] = col[2];
      out[enc * 4 + 3] = col[3];
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Shaders
  // ---------------------------------------------------------------------------
  const VERT = `
    attribute vec2 a_pos;          // mercator 0..1
    uniform mat4 u_matrix;
    varying vec2 v_merc;
    void main() {
      v_merc = a_pos;              // NOT a texture coord — see the fragment shader
      gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
    }`;

  // The data texture is sampled with GL_LINEAR, which is where the smoothing
  // comes from: the GPU interpolates between grid cells for every screen pixel
  // instead of a fixed image being stretched.
  //
  // The texture coordinate cannot simply be the vertex position. Two corrections:
  //
  //   u  is linear in mercator x, because longitude is linear in mercator x.
  //
  //   v  is NOT. The MRMS grid is equirectangular — every row is an equal step
  //      of latitude — while the quad is drawn in mercator, where rows are not
  //      evenly spaced. Sampling linearly stretches the north and squashes the
  //      south. So the shader inverts the projection per fragment to recover a
  //      real latitude, which is the same correction the old canvas renderer
  //      made per row. Tested: three blocks painted at known lat/lon landed on
  //      Kansas, south Texas and the Pacific Northwest, square and in place.
  //
  // sinh() does not exist in GLSL ES 1.0, so it is expanded by hand.
  // Edge treatment. This went through three wrong versions before landing here,
  // each one tested side by side against a reference renderer on the same frame:
  //
  //   hardware GL_LINEAR      averaged echoes with empty neighbours, inventing
  //                           weak returns — every echo grew a soft halo and
  //                           read larger than it is.
  //   empties weighted 0      no halo, but at an edge only one neighbour holds
  //                           data so there is nothing to blend with: edges
  //                           became hard 1 km squares, invisible zoomed out
  //                           and obviously blocky zoomed in.
  //   empties weighted ~0.5   smooth again, but an empty cell still carries a
  //                           VALUE of zero, so the average slid down the ramp
  //                           and every echo grew a false blue rim.
  //
  // The fault in all three was letting emptiness affect the colour. Here it
  // cannot: the dBZ is averaged over the neighbours that actually hold data,
  // renormalised over those alone. What the empty ones do instead is reduce
  // coverage, and coverage fades the alpha. An edge therefore softens by going
  // transparent rather than by changing hue or stepping.
  //
  // u_floor discards below a minimum dBZ — weak returns near the noise floor
  // otherwise spread a wide fringe that is mostly clutter.
  const FRAG = `
    precision highp float;
    uniform sampler2D u_data;
    uniform sampler2D u_next;     // the frame being crossed into
    uniform float u_blend;        // 0 = current frame only, 1 = fully the next
    uniform sampler2D u_ramp;
    uniform float u_opacity;
    uniform vec4 u_bounds;        // mercX west, mercX east, lat north, lat south
    uniform vec2 u_texel;         // 1/Ni, 1/Nj
    uniform float u_floor;        // minimum encoded value to draw at all
    uniform float u_feather;      // 0 = hard edges, 1 = coverage fades alpha
    uniform float u_packed;       // 1 when the value packs a category, 0 otherwise
    uniform float u_smooth;       // 0 = none, 1 = full neighbourhood average
    varying vec2 v_merc;
    void main() {
      float u = (v_merc.x - u_bounds.x) / (u_bounds.y - u_bounds.x);
      float mercY = (0.5 - v_merc.y) * 6.283185307;
      float sh = (exp(mercY) - exp(-mercY)) * 0.5;      // sinh, absent in GLSL ES 1.0
      float lat = degrees(atan(sh));
      float v = (u_bounds.z - lat) / (u_bounds.z - u_bounds.w);
      if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) discard;

      vec2 tc = vec2(u, v) / u_texel - 0.5;
      vec2 base = floor(tc), f = tc - base;
      vec2 o = (base + 0.5) * u_texel;

      float a = texture2D(u_data, o).a;
      float b = texture2D(u_data, o + vec2(u_texel.x, 0.0)).a;
      float c = texture2D(u_data, o + vec2(0.0, u_texel.y)).a;
      float d = texture2D(u_data, o + u_texel).a;

      // Frame blending. MRMS publishes every two minutes, so a loop is a
      // slideshow unless consecutive frames are crossed into one another. The
      // blend happens on the VALUE, before the colour lookup, so a cell fading
      // from 20 to 40 dBZ passes through 30 and its real colour — blending the
      // two colours instead would cross the palette in a straight line and
      // invent shades that are not on the scale.
      if (u_blend > 0.0) {
        float na = texture2D(u_next, o).a;
        float nb = texture2D(u_next, o + vec2(u_texel.x, 0.0)).a;
        float nc = texture2D(u_next, o + vec2(0.0, u_texel.y)).a;
        float nd = texture2D(u_next, o + u_texel).a;
        // Empty takes part in the blend like any other value. An earlier version
        // held a real value whenever the other side was empty, meaning an echo
        // appeared at full strength the instant the next frame had it and never
        // faded where the next frame did not — so it grew at the leading edge and
        // refused to shrink at the trailing one. The result smeared instead of
        // dissolving. Letting empty participate makes the fade symmetric.
        a = mix(a, na, u_blend);
        b = mix(b, nb, u_blend);
        c = mix(c, nc, u_blend);
        d = mix(d, nd, u_blend);
      }

      float ha = step(u_floor, a), hb = step(u_floor, b);
      float hc = step(u_floor, c), hd = step(u_floor, d);

      float wa = (1.0 - f.x) * (1.0 - f.y);
      float wb = f.x * (1.0 - f.y);
      float wc = (1.0 - f.x) * f.y;
      float wd = f.x * f.y;

      float cov = wa * ha + wb * hb + wc * hc + wd * hd;   // 0..1 echo coverage
      if (cov <= 0.001) discard;

      // Value from cells that hold data only — emptiness never shifts the colour.
      float enc = (a * wa * ha + b * wb * hb + c * wc * hc + d * wd * hd) / cov;

      // A packed value must NEVER be interpolated across a category boundary.
      // Precipitation type carries the category in the hundreds digit, so rain at
      // 50 dBZ is 50 and snow at 20 dBZ is 120; averaging them gives 85, which
      // the palette reads as rain at 85 dBZ. Every rain/snow edge then draws a
      // band of white and magenta that is not in the data. Take the nearest cell
      // instead whenever the neighbours disagree about the category.
      if (u_packed > 0.5) {
        float band = floor(enc * 255.0 * 360.0 / 255.0 / 100.0);
        float ba = floor(a * 255.0 * 360.0 / 255.0 / 100.0);
        float bb = floor(b * 255.0 * 360.0 / 255.0 / 100.0);
        float bc = floor(c * 255.0 * 360.0 / 255.0 / 100.0);
        float bd = floor(d * 255.0 * 360.0 / 255.0 / 100.0);
        float spread = max(max(ba, bb), max(bc, bd)) - min(min(ba, bb), min(bc, bd));
        if (spread > 0.5) {
          // Neighbours straddle a boundary — snap to the nearest cell so the edge
          // is a hard line between two categories, which is what it physically is.
          enc = (f.x < 0.5)
              ? ((f.y < 0.5) ? a : c)
              : ((f.y < 0.5) ? b : d);
          if (enc <= u_floor) discard;
        }
      }

      // Spatial smoothing. Sampling four cells gives a hard-edged field, and a
      // two-minute step between hard edges reads as a jump however the timing is
      // tuned. Widening the neighbourhood softens the edges, so consecutive
      // frames differ less abruptly — it does not change the data, only how
      // sharply it is drawn. Skipped for packed values, where averaging across a
      // category boundary is meaningless.
      if (u_smooth > 0.0 && u_packed < 0.5) {
        float acc = 0.0, wt = 0.0;
        for (int dy = -1; dy <= 1; dy++) {
          for (int dx = -1; dx <= 1; dx++) {
            vec2 off = vec2(float(dx), float(dy)) * u_texel;
            float sv = texture2D(u_data, o + off).a;
            if (sv >= u_floor) { acc += sv; wt += 1.0; }
          }
        }
        if (wt > 0.0) enc = mix(enc, acc / wt, u_smooth);
      }

      vec4 col = texture2D(u_ramp, vec2(enc, 0.5));
      if (col.a <= 0.0) discard;

      float edge = mix(1.0, smoothstep(0.0, 1.0, cov), u_feather);
      gl_FragColor = vec4(col.rgb, col.a * u_opacity * edge);
    }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('MRMSGL shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  // Mercator helpers. Mapbox's custom layer matrix expects mercator 0..1.
  function lonToMerc(lon) { return (180 + lon) / 360; }
  function latToMerc(lat) {
    const s = Math.sin(lat * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }

  const MRMSGL = {
    VERSION,
    id: 'lsc-mrms-gl',
    _map: null, _gl: null, _prog: null, _buf: null,
    _dataTex: null, _nextTex: null, _rampTex: null, _bounds: null,
    _pendingNext: null, _blend: 0,
    _pending: null, _opacity: 0.9, _attached: false,
    _texel: null,
    _Ni: FALLBACK_NI, _Nj: FALLBACK_NJ, _kind: 'dbz',
    _maxTexture: 0,
    _palTexels: null,       // null = use the built-in palette
    _palName: null,
    // The floor is per KIND, not global. It was a dBZ floor applied to every
    // product: 5 dBZ encodes to byte 70, but real shear lives at bytes 20-40, so
    // a shear field was almost entirely discarded before it reached the ramp and
    // drew nothing at all.
    //   dbz       5 dBZ    byte 70   below this is mostly clutter
    //   shear     0.002    byte  8   below this is noise, not rotation
    //   mesh      6 mm     byte  3   below this is not worth drawing
    //   category  1        byte  1   0 already means none
    // The shear floor follows the palette's own first stop, 0.001 s^-1, which at
    // x4 on a x1000 product is byte 4. Anything below that is noise the palette
    // itself declines to colour.
    // shear 10/255 is 0.0025 s^-1 at x4 on a x1000 product — the ramp's own first
    // stop. Lower and the weak field floods the gaps between tracks.
    // shear 12/255 is 0.003 s^-1, the ramp's first stop.
    _floors: { dbz: 70 / 255, shear: 12 / 255, mesh: 3 / 255, category: 1 / 255,
               ptyperefl: 1 / 255 },
    _feather: 1.0,                              // coverage fades the alpha at edges

    // The host page hands us the decoded grid: a Uint8Array of Ni*Nj bytes,
    // each (dbz + 30) * 2, zero meaning no echo. Exactly what the existing
    // decoder already produces, so nothing about the fetch changes.
    // Accepts either a bare Uint8Array (reflectivity at the old fixed size) or
    // the { data, Ni, Nj, kind } the fetcher now returns.
    setData(frame) {
      const was = this._kind;
      if (frame && frame.data && !this.canHold(frame.Ni || FALLBACK_NI)) {
        this.lastError = `Grid ${frame.Ni}x${frame.Nj} exceeds this GPU's ` +
                         `${this._maxTexture} texture limit`;
        return false;
      }
      if (frame && frame.data) {
        this._pending = frame.data;
        this._Ni = frame.Ni || FALLBACK_NI;
        this._Nj = frame.Nj || FALLBACK_NJ;
        this._kind = frame.kind || 'dbz';
      } else {
        this._pending = frame;
        this._Ni = FALLBACK_NI;
        this._Nj = FALLBACK_NJ;
        this._kind = 'dbz';
      }
      const kindChanged = was !== this._kind;
      if (kindChanged) { this._floorOverride = null; this._uploadRamp(); }
      if (this._map) this._map.triggerRepaint();
      return true;
    },

    // ---- loop -------------------------------------------------------------
    // Frames are held as decoded byte arrays, not as GPU textures. A dozen
    // 14000x7000 textures is 1.2 GB of VRAM and the context is lost; the same
    // frames as Uint8Arrays sit in ordinary memory and upload in about 20 ms,
    // which is well inside a frame at any sane playback speed.
    _frames: [], _frameIndex: 0, _loopTimer: null,

    setFrames(frames) {
      this.stopLoop();
      this._frames = frames || [];
      this._frameIndex = Math.max(0, this._frames.length - 1);
      if (this._frames.length) this.setData(this._frames[this._frameIndex]);
    },

    frameCount() { return this._frames.length; },
    frameIndex() { return this._frameIndex; },

    showFrame(i) {
      if (!this._frames.length) return false;
      this._frameIndex = ((i % this._frames.length) + this._frames.length) % this._frames.length;
      this.setData(this._frames[this._frameIndex]);
      return true;
    },

    // ms is the gap between frames; dwellMs is the extra pause on the newest one,
    // which is what stops a loop reading as a blur — the eye needs a beat on the
    // current state before it starts again.
    startLoop(ms, dwellMs, onFrame) {
      this.stopLoop();
      if (this._frames.length < 2) return false;
      // 300ms between frames and 1600ms on the newest, matching what reads well
      // on a two-minute cadence: an eight frame loop becomes a two and a half
      // second cycle with a beat on the current state.
      const gap = ms || 300;
      // The hold on the newest frame is capped relative to the step. At 10x a
      // fixed 1600ms hold is ten steps long and the wrap reads as a stall rather
      // than a beat, which is the thing that makes a loop feel stuttery at the
      // restart. Three steps is enough to register the present frame.
      const dwell = dwellMs || 0;

      // MRMS publishes every two minutes, so twelve frames stepped one to the
      // next is a slideshow — storms jump rather than move. Each step is instead
      // animated: the current frame is crossed into the following one across the
      // gap, so the field morphs. The dwell on the newest frame is not blended,
      // because that pause is the point at which the viewer reads the present.
      const tick = (now) => {
        this._raf = null;
        if (typeof document !== 'undefined' && document.hidden) {
          this._loopTimer = setTimeout(() => this._resume(tick), 1000);
          return;
        }
        const t = now - this._stepStart;
        const onNewest = this._frameIndex === this._frames.length - 1;
        // 5x is the reference, so the defaults hold at the middle of the scale
        // rather than at one end of it.
        const k = 5 / (this._speed || 5);
        const stepMs = gap * k;
        const span = onNewest ? (dwell ? dwell * k : stepMs * 3) : stepMs;

        if (t >= span) {
          this.showFrame(this._frameIndex + 1);
          this._blend = 0;
          this._queueNext();
          if (onFrame) onFrame(this._frameIndex, this._frames.length,
                               this._frames[this._frameIndex]);
          this._stepStart = now;
        } else if (!onNewest && this._blendOn) {
          // Ease rather than a straight ramp, so the change is gentlest at the
          // moment each frame is most readable.
          const x = t / span;
          this._blend = x * x * (3 - 2 * x);
          if (this._map) this._map.triggerRepaint();
        }
        this._raf = requestAnimationFrame(tick);
      };

      this._stepStart = performance.now();
      this._blend = 0;
      this._queueNext();
      this._raf = requestAnimationFrame(tick);
      return true;
    },

    // Hand the following frame to the shader so it has something to cross into.
    _queueNext() {
      if (!this._blendOn || this._frames.length < 2) { this._pendingNext = null; return; }
      const nxt = this._frames[(this._frameIndex + 1) % this._frames.length];
      this._pendingNext = nxt && nxt.data ? nxt.data : null;
    },

    _resume(tick) {
      this._stepStart = performance.now();
      this._raf = requestAnimationFrame(tick);
    },

    // Frame blending, on by default. A caller can turn it off to step.
    setBlend(on) { this._blendOn = !!on; if (!on) this._blend = 0; },
    _blendOn: true,

    // Spatial smoothing, 0 to 1. This is the lever that makes a loop read
    // smoothly: frame count only lengthens the loop, and cross-fading only
    // dissolves. Softening the edges is what stops a two-minute step looking
    // like a jump.
    _smooth: 0.5,
    setSmooth(x) {
      this._smooth = Math.max(0, Math.min(1, Number(x) || 0));
      if (this._map) this._map.triggerRepaint();
    },
    smooth() { return this._smooth; },

    // Playback speed as a multiplier, where a larger number is faster — the same
    // sense as the familiar 20x, 10x, 5x, ... , 1x scale. 1x is close to real
    // time for a two-minute cadence and slow enough to study; 20x is a quick
    // sweep of the whole window. Changing it takes effect on the next step
    // rather than restarting the loop, so the picture does not jump.
    SPEEDS: [20, 10, 5, 4, 3, 2, 1],
    _speed: 5,

    setSpeed(x) {
      const n = Number(x);
      if (!isFinite(n) || n <= 0) return false;
      this._speed = n;
      return true;
    },
    speed() { return this._speed; },

    stopLoop() {
      if (this._loopTimer) { clearTimeout(this._loopTimer); this._loopTimer = null; }
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
      this._blend = 0;
      this._pendingNext = null;
      if (this._map) this._map.triggerRepaint();
    },

    isLooping() { return !!(this._loopTimer || this._raf); },

    kind() { return this._kind; },
    gridSize() { return [this._Ni, this._Nj]; },

    setOpacity(o) {
      this._opacity = Math.max(0, Math.min(1, o));
      if (this._map) this._map.triggerRepaint();
    },

    // Minimum reflectivity drawn, in dBZ. Raising it trims the weak outer fringe.
    // Only meaningful while a reflectivity product is up; it overrides the
    // per-kind floor until cleared.
    setFloorDbz(dbz) {
      this._floorOverride = ((dbz + ENC_OFF) * ENC_MUL) / 255;
      if (this._map) this._map.triggerRepaint();
    },
    clearFloorOverride() {
      this._floorOverride = null;
      if (this._map) this._map.triggerRepaint();
    },
    _floorOverride: null,

    // 0 leaves edges hard, 1 fades them by how much of the pixel holds echo.
    setFeather(x) {
      this._feather = Math.max(0, Math.min(1, x));
      if (this._map) this._map.triggerRepaint();
    },

    _uploadNext(gl) {
      const bytes = this._pendingNext;
      this._pendingNext = null;
      if (!this._nextTex) {
        this._nextTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._nextTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, this._nextTex);
      }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, this._Ni, this._Nj, 0,
                    gl.ALPHA, gl.UNSIGNED_BYTE, bytes);
    },

    _uploadData(gl) {
      const bytes = this._pending;
      this._pending = null;
      if (!this._dataTex) {
        this._dataTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._dataTex);
        // NEAREST, not LINEAR: the shader does its own interpolation so it can
        // exclude empty cells. Hardware filtering would blend them back in.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, this._dataTex);
      }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, this._Ni, this._Nj, 0,
                    gl.ALPHA, gl.UNSIGNED_BYTE, bytes);
      // The texel size the shader interpolates with must follow the grid, not a
      // constant, or a 14000-wide frame is sampled as if it were 7000.
      this._texel = new Float32Array([1 / this._Ni, 1 / this._Nj]);
    },

    onAdd(map, gl) {
      this._map = map; this._gl = gl;

      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error('MRMSGL link: ' + gl.getProgramInfoLog(prog));
      }
      this._prog = prog;

      // One quad covering the MRMS bounds, in mercator.
      const x0 = lonToMerc(GRID.lonW), x1 = lonToMerc(GRID.lonE);
      const y0 = latToMerc(GRID.latN), y1 = latToMerc(GRID.latS);
      // Verified against mapboxgl.MercatorCoordinate.fromLngLat to six decimals.
      this._bounds = new Float32Array([x0, x1, GRID.latN, GRID.latS]);
      this._texel  = new Float32Array([1 / this._Ni, 1 / this._Nj]);
      const quad = new Float32Array([x0,y0, x1,y0, x0,y1, x1,y1]);
      this._buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._buf);
      gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

      // Colour ramp. NEAREST, not LINEAR: linear here would bleed neighbouring
      // bands into one another and soften every colour boundary.
      // LINEAR, not NEAREST. The data is quantised to half a decibel per byte,
      // and sampling the ramp with NEAREST made those steps show as contour
      // banding inside cells once zoomed in. Interpolating between texels
      // recovers a continuous colour.
      this._rampTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._rampTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA,
                    gl.UNSIGNED_BYTE, this._palTexels || buildRampTexels());
    },

    render(gl, matrix) {
      if (!this._prog) return;
      if (this._pending) this._uploadData(gl);
      if (this._pendingNext) this._uploadNext(gl);
      if (!this._dataTex) return;

      gl.useProgram(this._prog);

      const aPos = gl.getAttribLocation(this._prog, 'a_pos');
      gl.bindBuffer(gl.ARRAY_BUFFER, this._buf);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      gl.uniformMatrix4fv(gl.getUniformLocation(this._prog, 'u_matrix'), false, matrix);
      gl.uniform1f(gl.getUniformLocation(this._prog, 'u_opacity'), this._opacity);
      gl.uniform4fv(gl.getUniformLocation(this._prog, 'u_bounds'), this._bounds);
      gl.uniform2fv(gl.getUniformLocation(this._prog, 'u_texel'), this._texel);
      gl.uniform1f(gl.getUniformLocation(this._prog, 'u_floor'),
                   this._floorOverride !== null ? this._floorOverride
                                                : (this._floors[this._kind] || this._floors.dbz));
      gl.uniform1f(gl.getUniformLocation(this._prog, 'u_feather'), this._feather);
      gl.uniform1f(gl.getUniformLocation(this._prog, 'u_blend'),
                   this._nextTex ? this._blend : 0);
      gl.uniform1f(gl.getUniformLocation(this._prog, 'u_packed'),
                   this._kind === 'ptyperefl' ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(this._prog, 'u_smooth'), this._smooth);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._dataTex);
      gl.uniform1i(gl.getUniformLocation(this._prog, 'u_data'), 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._rampTex);
      gl.uniform1i(gl.getUniformLocation(this._prog, 'u_ramp'), 1);

      // The second frame always has to be bound, even when not blending — an
      // unbound sampler reads as black on some drivers and the field flickers.
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this._nextTex || this._dataTex);
      gl.uniform1i(gl.getUniformLocation(this._prog, 'u_next'), 2);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },

    onRemove(map, gl) {
      if (this._dataTex) gl.deleteTexture(this._dataTex);
      if (this._nextTex) gl.deleteTexture(this._nextTex);
      this._nextTex = null;
      if (this._rampTex) gl.deleteTexture(this._rampTex);
      if (this._buf) gl.deleteBuffer(this._buf);
      if (this._prog) gl.deleteProgram(this._prog);
      this._dataTex = this._rampTex = this._buf = this._prog = null;
      this._map = null;
    },

    // ---- host API -----------------------------------------------------------
    // Returns false rather than throwing if the GPU path is unavailable, so the
    // host can fall back to its raster renderer instead of showing no radar.
    // Checked here rather than assumed: a machine with a 4096 texture limit
    // cannot hold the 7000x3500 grid and must not silently draw a partial one.
    canRun(map) {
      try {
        const gl = map && map.painter && map.painter.context && map.painter.context.gl;
        if (!gl) return false;
        // Reflectivity needs 7000. Refusing outright below 14000 would lock a
        // capable machine out of the radar entirely for the sake of a product
        // it may never open, so attach on 7000 and check the rest per frame.
        this._maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        return this._maxTexture >= FALLBACK_NI;
      } catch (e) { return false; }
    },

    // Shear and the rotation tracks are 14000x7000 — four times the cells of
    // reflectivity. A GPU that cannot hold that must be told before the product
    // is offered, not after it has drawn a corrupt frame.
    canHold(Ni) {
      return !this._maxTexture || Ni <= this._maxTexture;
    },

    attach(map, beforeId) {
      if (this._attached) return true;
      if (!map) return false;
      if (!this.canRun(map)) return false;
      try {
        map.addLayer({ id: this.id, type: 'custom', renderingMode: '2d',
                       onAdd: (m, gl) => this.onAdd(m, gl),
                       render: (gl, mat) => this.render(gl, mat),
                       onRemove: (m, gl) => this.onRemove(m, gl) }, beforeId);
      } catch (e) {
        // Shader compile or link failure lands here. Leave nothing behind.
        try { if (map.getLayer(this.id)) map.removeLayer(this.id); } catch (e2) {}
        this._attached = false;
        this.lastError = e.message;
        return false;
      }
      this._attached = true;
      return true;
    },

    detach(map) {
      const m = map || this._map;
      if (m && m.getLayer(this.id)) m.removeLayer(this.id);
      this._attached = false;
    },

    isAttached() { return this._attached; },
    lastError: null,

    // Exposed so the host can show the same ramp in a legend.
    ramp() { return RAMP.slice(); },

    // Load a GRLevelX / RadarScope .pal colour table for this session.
    // Returns { ok, error, name, units, stops }. Nothing is stored — a reload
    // goes back to the built-in palette, which is deliberate: a palette loaded
    // from a file is a one-off, not a setting to be silently inherited later.
    loadPal(text, name) {
      const { stops, units, product } = parsePal(text);

      if (!stops.length) {
        return { ok: false, error: 'No colours found. Expected "Color: 20 0 255 0", "Color[20] = rgb(0,255,0)", or plain "20 0 255 0" rows.' };
      }

      // A velocity or ptype table would apply its numbers to reflectivity and
      // look plausible while being wrong, so refuse rather than guess. Only
      // when the file says what it is: a bare numeric table declares nothing,
      // and refusing those would rule out most hand-made palettes.
      if (units && !/^d?bz$/i.test(units.trim())) {
        return { ok: false, error: `This table is in ${units}, not dBZ` + (product ? ` (${product})` : '') + '.' };
      }

      this._palTexels = palTexels(stops);
      this._palName = name || null;
      this._uploadRamp();
      return { ok: true, name: this._palName, units: units || 'dBZ', stops: stops.length,
               range: [stops[0].value, stops[stops.length - 1].value] };
    },

    // Back to the palette that ships with the renderer.
    clearPal() {
      this._palTexels = null;
      this._palName = null;
      this._uploadRamp();
    },

    palName() { return this._palName; },

    _uploadRamp() {
      const map = this._map;
      if (!map || !this._rampTex) return;
      const gl = map.painter && map.painter.context && map.painter.context.gl;
      if (!gl) return;
      gl.bindTexture(gl.TEXTURE_2D, this._rampTex);
      const filt = this._kind === 'category' ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
      // A loaded .pal only applies to reflectivity — it is a dBZ table, and
      // stretching it over shear or hail sizes would be meaningless.
      const texels = (this._kind === 'dbz' && this._palTexels)
        ? this._palTexels
        : rampFor(this._kind);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA,
                    gl.UNSIGNED_BYTE, texels);
      map.triggerRepaint();
    }
  };

  global.MRMSGL = MRMSGL;
})(window);
