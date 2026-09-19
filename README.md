MRMS-GL
=======

GPU-rendered MRMS radar for Mapbox GL JS.

Copyright (c) 2026 Live Storm Chasers Network LLC. All rights reserved.

This code is published to be read, not taken. It is source-visible, not open
source — see LICENSE. Read it, study it, quote it when discussing the
techniques. Using it in a project needs written permission first, which is
usually easy to get: ask. Permission comes with terms, and attribution is
always one of them — the notices stay in the source and a visible credit
appears wherever the work is shown.

None of that touches the data. NOAA's MRMS products are free to everyone and
this repository makes no claim over them.

Decodes NOAA's MRMS grids in the browser and draws them on the GPU, sampling
the raw grid per screen pixel rather than stretching a pre-rendered image.


Why
---

The usual approach decodes the grid, draws it once into a large canvas and
hands the map a static image. That is sharp zoomed out but the single image is
then stretched as you zoom in — measured at 12x by zoom 11 and 50x by zoom 13,
which is where it softens.

Here the grid goes to the GPU as a texture and is sampled per screen pixel
every frame, so there is no fixed resolution to outrun.

The data is NOAA MRMS, which is free and unmetered. One request per refresh
through a proxy worker. No key, no account, no quota.


Files
-----

    mrms-gl.js      the renderer. Exposes MRMSGL.
    mrms-fetch.js   fetch and decode. Exposes MRMSFetch.
    index.html      standalone bench, with live controls for smoothing, loop
                    speed, frame blending and a twelve-frame loop.
    host-snippet.js reference only.


Use
---

    <script src=".../mrms-gl.js"></script>
    <script src=".../mrms-fetch.js"></script>

    MRMSFetch.WORKER = 'https://your-proxy.example';

    if (MRMSGL.attach(map, beforeId)) {
      MRMSFetch.start(frame => MRMSGL.setData(frame), 90000);
    }

attach() returns false rather than throwing when the GPU path is unavailable,
so the caller can fall back to a raster renderer instead of showing no radar.

`beforeId` is the layer to insert beneath. Pass it. Attaching with no anchor
places the radar above everything — labels, roads, boundaries — and radar
appearing on screen is not proof the layer is in the right slot, only that it
is not buried. "Visible" and "correctly ordered" are different claims.

### Do not gate attach() on the map's load signals

On at least one production style under Mapbox GL JS 3.6, `isStyleLoaded()`,
`loaded()` and `areTilesLoaded()` all read false indefinitely while the map
renders its basemap, labels, pins and radar correctly. `idle` therefore never
fires — measured zero times in six seconds, tab visible, nothing panning or
zooming. Every source in that style reported `loaded: true`, and there were no
model, fill-extrusion or sky layers to blame; the cause sits below the public
API.

A host that defers `attach()` until `idle` on such a style never attaches at
all, and reports no error while doing it.

Ask the question you actually mean instead. If what you need is queryable
vector features, poll `querySourceFeatures` until it returns something, with a
hard timeout so the caller always proceeds.


The proxy
---------

These modules carry no endpoint. `MRMSFetch.WORKER` must point at something
that serves two routes:

    /mrms/latest.bin?product=   the raw PNG from GRIB2 section 7
    /mrms/list?product=         the timestamps available upstream

with these response headers:

    X-Scale     "R,E,D" — the GRIB2 reference value and the binary and decimal
                scale factors, so the client can recover physical units
    X-Grid      "NIxNJ" — grid dimensions, which differ by product
    X-Kind      dbz | shear | mesh | category
    X-Modified  the upstream Last-Modified, for frame age

and `Access-Control-Expose-Headers` listing them, or the browser cannot read
any of it. That last point is easy to miss: without it the headers arrive and
are silently invisible to JavaScript, and a client falls back to assumed values
that happen to work until they don't.

### What the X-Scale fallback looks like

When `X-Scale` is missing — whether absent from the expose list or simply not
sent — callers fall back to the hardcoded triple:

    -9990,0,1

Under that the conversion collapses to `dBZ = byte`, which puts a typical
observed range of bytes 70–181 at 70 to 181 dBZ. Reflectivity does not go past
about 80, so the scale is wrong on its face.

If you see `-9990,0,1`, you are reading the fallback, not the product. Derive
the relation from the renderer's own decode path instead, or probe it as
described under Colour tables.

A proxy is needed at all because NOAA's host sends no CORS header and the files
are gzipped GRIB2. The data itself is free and unmetered.


Products
--------

    hsr             seamless hybrid scan reflectivity — what reaches the ground
    composite       strongest return in the column, so broader and hotter
    shear02         instant azimuthal shear, 0-2 km — the low-level couplet
    shear36         instant azimuthal shear, 3-6 km — the mid-level mesocyclone
    rot30..1440     accumulated low-level rotation, 30 min to 24 hours
    rotml*          the same accumulations at mid level
    mesh            maximum estimated hail size
    ptyperefl       precipitation type with intensity, composed from two products


What was verified rather than assumed
-------------------------------------

    geo-registration  blocks painted at known lat/lon landed on Kansas, south
                      Texas and the Pacific Northwest, square and in place
    mercator maths    matches mapboxgl.MercatorCoordinate to six decimals
    frame age         about 2 minutes behind live, on a 2-minute cadence
    fallback          returns false for a small texture limit, a missing WebGL
                      context and a null map
    shear decode      physical distribution, peak 0.062 s^-1, nothing clamped
    hosts             Mapbox GL JS 2.15 and 3.6.0, mercator projection. On
                      3.6.0 the program links, all twelve uniforms resolve and
                      the draw issues clean. Untested on MapLibre.

Mercator is a hard requirement, not a preference. Mapbox's own documentation
states that CustomLayerInterface can only be used with mercator, and that globe
does not support custom layers at all — while recent styles ship globe by
default. A map on globe will call render() and draw nothing.


Things that cost time and are worth carrying
--------------------------------------------

A vertex position is not a texture coordinate. Passing mercator straight
through samples a sliver of the ramp.

`sinh()` does not exist in GLSL ES 1.0. Expand it by hand.

The grids are equirectangular, the quad is mercator. Latitude has to be
un-projected per fragment or the north stretches and the south squashes.

The multiply form `['*', expr, k]` is rejected for text-size and circle-radius
on GL 2.15. Assume it is rejected everywhere.

Custom layers do not appear in `map.getStyle().layers` and cannot be reordered
with `moveLayer`. Remove and re-add instead. A host's own layer-order engine
cannot help either, because any code that iterates `getStyle().layers` cannot
see the layer at all, and `moveLayer` is a silent no-op on it. The host must
re-attach after its basemap exists.

Custom layers always render before the symbol pass, so one can never be drawn
above labels. Hide the labels instead if that is needed.

Grid size and bit depth are NOT fixed across products. Reflectivity is
7000x3500 and 16-bit; shear and rotation are 14000x7000 and 8-bit. Reading two
bytes from an 8-bit image decodes without error and produces a spiky bimodal
field that looks like data and is not. Both come from the response headers and
the PNG's own IHDR chunk.

The draw floor is per product kind. A dBZ floor applied to shear discards
almost the entire field, because real shear sits at bytes where 5 dBZ would be
noise.

The colour ramp is sampled LINEAR and the palette carries a stop per half
decibel — one per encoded byte. Those two go together. A coarser table
stretched over 256 texels repeats colours, and then LINEAR has room to smear
every boundary while NEAREST shows each repeat as a contour ring inside a
slowly varying core. With a stop per value neither happens. Changing one
without the other brings back whichever artefact the other was hiding.

The decode runs in a pool of four workers, built from a Blob so the module
stays self-contained. Unfiltering a 14000x7000 PNG is about 650 ms of tight
loop; on the main thread that is 650 ms where the map does not move. The
buffers are transferred rather than copied, because a 98 MB grid would
otherwise be duplicated twice per frame. It falls back to decoding inline where
a content security policy blocks Blob workers.


The edge treatment, and three wrong versions of it
--------------------------------------------------

    hardware GL_LINEAR     averaged echoes with empty neighbours, inventing
                           weak returns. Every echo grew a soft halo.

    empties weighted 0     no halo, but at an edge only one neighbour holds
                           data, so edges became hard 1 km squares — invisible
                           zoomed out, obviously blocky zoomed in.

    empties weighted 0.5   smooth again, but an empty cell still carries a
                           VALUE of zero, so the average slid down the ramp and
                           every echo grew a false blue rim.

The fault in all three was letting emptiness affect the colour. It now cannot:
the value is averaged over the neighbours that hold data, renormalised over
those alone, and the empty ones reduce coverage instead. Coverage fades the
alpha, so an edge softens by going transparent rather than by changing hue.

Separately, the colour ramp is sampled LINEAR. The data is quantised to half a
decibel per byte and NEAREST made those steps show as contour banding.


Loop
----

    loadSeries(count, step, onFrame)

Resolves to an array of frames **already in time order**. `setFrames` and
`startLoop` then play them.

`step` is in FRAMES, not minutes. On a two-minute product, `step: 3` gives
six-minute spacing. Omitted, it is 1 — every frame. So `step: 1` plays twelve
frames over 24 minutes, `step: 2` over 48.

**`onFrame` is PROGRESS ONLY. It is not a collection point.** It fires as each
fetch completes, and the fetches run in parallel across the decode workers, so
the order it reports is COMPLETION order, not time order. Building a frame
array from it produces a loop that plays

    01:30, 01:22, 01:26, 01:18, 01:38 ...

— the frame index advancing cleanly while the weather steps backwards several
times a cycle. It reads as a juddering renderer, and no amount of
frame-duration, hold or blend tuning will touch it, because sequencing was
never what those settings control.

Use the resolved array. Do not sort it: it is ordered by construction, and a
sort that can never fire tells the next reader the series might arrive
unordered, which is false. Assert instead, if you want insurance.

Stop any live poll before gathering a series. A 90-second refresh will
overwrite loop frames within seconds of them being set.

Frames are held as decoded byte arrays rather than GPU textures — a dozen
14000x7000 textures is over a gigabyte of VRAM and the context is lost, while
the same frames as arrays upload in about 20 ms each.

`startLoop(frameMs, holdMs, onFrame)` takes the frame duration directly. The
defaults are 300 ms per frame and 1000 ms held on the newest. Pacing is even:
instrumenting the loop's internal queueing gives 243 ms against a 240 ms
nominal, repeated, with the single long gap per cycle being the hold.

### Choosing a frame count is also choosing memory and cache behaviour

Decoded frames are cached by product and timestamp, but **the cache holds 10**,
regardless of how many frames a caller asks for.

Frames are held as decoded byte arrays, and the size is per product:

    hsr       7000x3500   Uint8Array   24,500,000 bytes   23.4 MB per frame
    shear02  14000x7000   Uint8Array   98,000,000 bytes   93.5 MB per frame

Exactly four times, since the grid is double in each dimension. Measured, both
products, cold and warm on the same machine:

    REFLECTIVITY (hsr)              ROTATION / SHEAR (shear02)
    frames  cold    warm   total    frames  cold     warm    total
      12    2684 ms  764    280 MB     6    5197 ms   120     561 MB
      16    2662 ms 2640    374 MB    12    7939 ms  2234    1122 MB
      20    3343 ms 3355    467 MB    16   10150 ms  9815    1495 MB
      23    3822 ms 3890    537 MB

The cliff is the cache limit, not the product — both behave identically around
it. Below ten the cache is essentially free: six shear frames re-gather in
120 ms against five seconds cold. At twelve, ten of the twelve survive and warm
is roughly a quarter of cold. By sixteen the benefit is gone entirely — warm is
97% of cold on shear, and equal to cold on reflectivity.

What differs is the memory bill. Twelve frames is 280 MB of reflectivity or
1.1 GB of shear, and a sixteen-frame shear series pushed the heap to 3 GB
during the run.

A single shear frame is about 2.4 s to fetch and decode, roughly three times a
reflectivity frame. That is the number to use when deciding whether to prefetch
one rather than fetch it at the moment it is needed.

A host that re-gathers on a timer pays the full fetch and decode every time,
permanently, for frames it held moments earlier.

Twelve is a reasonable place to sit for reflectivity: two over the limit, so
most of the set still survives, while keeping a long enough window to read a
storm's motion. For the 14000x7000 products, stay at or below ten unless the
memory is genuinely available.

These are warm-network figures on one machine. The cold column will be worse on
a slower connection; the ratios are the durable part.

### What reads as stutter

The data, usually. MRMS publishes every two minutes, so a loop is a sequence of
discrete states, not motion. Blending cross-fades between them, which dissolves
rather than moves; with it off they step. Neither is movement, because the
frames contain positions and not velocities. Real movement needs advection —
estimating the shift between frames and warping the field along it — which is a
genuine piece of work and misbehaves when storms grow or decay rather than
travel.

Frame COUNT and window length matter as much as step timing, and neither is
visible from a screenshot. A proxy listing capped at twenty timestamps once
turned a twelve-frame loop at every third frame into seven frames over
forty-two minutes; against a reference showing far more, the loop felt wrong in
a way no amount of speed or spacing adjustment could fix, because a short cycle
repeats too often and reads as a different thing entirely.

Frame DENSITY is a separate lever again. Two loops at the same playback speed
look very different if their frames are spaced differently: at the same frame
duration, a twelve-frame loop at four-minute spacing moves the field twice as
far per step as one at two-minute spacing. Both are honest radar; the denser
one reads as motion, the sparser one reads as stepping.

### A reference renderer, measured

Measured by stepping its own controls, not by watching it play:

    spacing       2 minutes  (10:14, 10:16, 10:18, 10:20 ... every frame)
    window        1 hour     (its own selector)
    frames        ~30
    speed ladder  a round 1000 ms at 1x, divided by the multiplier

    1x  1000      3x   333      5x   200      20x   50
    2x   500      4x   250     10x   100

Clean readings at 1x, 3x, 5x and 10x were 1008, 338, 208 and 113 ms; the
excess is scheduling overhead. Its hold on the newest frame is roughly one
second. It also offers 0.3x and 0.5x below 1x.

**Read a reference loop's spacing by STEPPING it, never by sampling a playing
clock.** Sampling a moving display misses frames and over-reports the gap: the
same two-minute product read as five-minute spacing that way, and the error
survived until the control was stepped by hand.


The rotation scale
------------------

Anchored to operational azimuthal shear thresholds, not fitted to a particular
day:

    0.005   marginal, common in any convective line
    0.010   a mesocyclone is likely
    0.015   strong rotation
    0.020   significant, the range a tornadic supercell occupies
    0.030+  extreme

Two earlier versions were fitted to one quiet afternoon instead. One put yellow
at 0.009, above 98% of that day's data, so every track rendered featureless
grey. The other put yellow at 0.003, below 60% of it, and painted a marginal
line the colours of a tornadic supercell. Overstating rotation is a real
problem, not a cosmetic one — a fixed scale means a colour means the same thing
every day, and quiet days correctly look quiet.


Precipitation type
------------------

MRMS publishes the category and the intensity as separate products: PrecipFlag
carries the category with no intensity, reflectivity the intensity with no
category. `ptyperefl` composes them as `category * 100 + dBZ`, which is the
layout the four-band palette expects — rain 2.5-94, snow 105-170, mix 205-270,
ice 305-360.

The flag values come from NOAA's published table, not from memory:

    -3  no coverage              7   hail
     0  no precipitation        10   cool stratiform rain
     1  warm stratiform rain    91   tropical stratiform rain
     3  snow                    96   tropical convective rain
     6  convection

Flags 2, 4, 5, 8 and 9 are unused, so this product has no freezing rain and no
sleet category. Only two of the palette's four bands can ever be filled from it
— rain and snow. A mix or ice band appearing means the mapping is wrong, not
that it is winter.

An earlier version had two codes backwards, reading 3 as freezing rain and 10
as snow, which painted cool stratiform rain across Wyoming in snow blue. It
looked plausible and was wrong, which is the failure mode to watch for here.


Colour tables
-------------

`loadPal()` accepts the three `.pal` formats in common use: the GRLevelX
keyword form, the ColorTable block using `Color[value] = rgb(...)`, and bare
numeric rows of "value r g b" with `#` comments. Bare tables are read as
control points, so a repeated value produces the hard band break those files
rely on, and equal values keep file order through the sort or the breaks
invert.

Tables declaring units other than dBZ are refused rather than applied.

### Tables are authored in dBZ; the texture is indexed by BYTE

A `.pal` is authored in dBZ. The ramp texture is 256 texels indexed by the
encoded byte, and `loadPal` maps between them with

    dBZ = byte / 2 - 30

Measured by probing the renderer — loading a ramp that encodes dBZ into the red
channel, then reading the ramp texture back per texel:

    texel 70  ->  5 dBZ        texel 128 -> 34 dBZ
    texel 181 -> 60.5 dBZ      texel 255 -> 98 dBZ

Byte 255 computes to 97.5 and reads back as 98: one quantisation step in the
colour encode, not a discrepancy.

The draw floor for reflectivity is byte 70, which is 5 dBZ. That is what a
legend reading "5 to 70 dBZ" is reporting, even when the table itself spans 0
to 100. It is the renderer's own default, not a host setting.

A generator producing a `.pal` should emit dBZ values and nothing else.

### clearPal() is mandatory when leaving reflectivity

Nobody finds this by reading code. The failure is silent and looks exactly like
a broken renderer.

    shear data occupies      roughly bytes 4 to 60
    the dBZ draw floor is    byte 70   -> every shear cell discarded
    a dBZ ramp across        bytes 4-60 is fully transparent

So the field draws NOTHING, while every state read looks healthy: attached,
frames loaded, kind correct, grid correct, draw call issued, no GL error. The
only thing missing is pixels.

Call `clearPal()` before showing a non-dBZ product. Cleared, the renderer uses
its own ramp for that kind and takes the floor from the frame's `kind`, which
is correct in every case. Reload the `.pal` when returning to reflectivity.


Measuring this renderer
-----------------------

Three notes that saved more time than any amount of reasoning about it.

A loop with a deliberate dwell has TWO populations of interval. Any jitter
statistic that does not separate them is meaningless — one hold mixed among
eleven even steps produces a mean above nominal, a large standard deviation and
a maximum that is really the hold. Classify by the loop's own structure, last
frame versus the rest, not by a magic threshold.

Instrument the thing itself. Polling from outside registers one index change as
two and reports steps shorter than the nominal interval, which is impossible.
Note also that the public `showFrame` is not what the loop calls internally, so
wrapping the public API alone shows nothing.

A flag that says "attached", "ok" or "ready" is not the thing it describes. Put
pixels on screen and look at them — a flat single-colour ramp over the whole
range answers "is this renderer drawing at all" in one glance, where state
reads will happily report health over an empty canvas.


Not done
--------

The rotation scale has not been seen during an actual tornado warning. It is
anchored to published thresholds, but how it reads on a significant event is
untested.

Snow has never been drawn. Precipitation type separates rain from snow, and in
September every frame is rain, so the snow band is unexercised until winter.

Smoothing is a plain 3x3 mean. It works, but it softens the whole field rather
than only the edges, which is why the default is modest rather than high.

The frame cache does not size itself to the series being played. Until it does,
a loop above a dozen frames re-decodes in full on every gather — which on the
14000x7000 products means about ten seconds and 1.5 GB for sixteen frames.
