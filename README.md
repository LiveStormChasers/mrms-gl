MRMS-GL
=======

GPU-rendered MRMS radar for Mapbox GL JS.

Decodes NOAA's MRMS grids in the browser and draws them on the GPU, sampling the
raw grid per screen pixel rather than stretching a pre-rendered image.


Why
---

The usual approach decodes the grid, draws it once into a large canvas and hands
the map a static image. That is sharp zoomed out but the single image is then
stretched as you zoom in — measured at 12x by zoom 11 and 50x by zoom 13, which
is where it softens.

Here the grid goes to the GPU as a texture and is sampled per screen pixel every
frame, so there is no fixed resolution to outrun.

The data is NOAA MRMS, which is free and unmetered. One request per refresh
through a proxy worker. No key, no account, no quota.


Files
-----

  mrms-gl.js      the renderer. Exposes MRMSGL.
  mrms-fetch.js   fetch and decode. Exposes MRMSFetch.
  index.html      standalone bench, with live controls for smoothing, loop
                  speed, frame blending and a twelve-frame loop.


Use
---

    <script src=".../mrms-gl.js"></script>
    <script src=".../mrms-fetch.js"></script>

    MRMSFetch.WORKER = 'https://your-proxy.example';

    if (MRMSGL.attach(map, beforeId)) {
      MRMSFetch.start(frame => MRMSGL.setData(frame), 90000);
    }

attach() returns false rather than throwing when the GPU path is unavailable, so
the caller can fall back to a raster renderer instead of showing no radar.


The proxy
---------

These modules carry no endpoint. MRMSFetch.WORKER must point at something that
serves two routes:

  /mrms/latest.bin?product=<id>   the raw PNG from GRIB2 section 7
  /mrms/list?product=<id>         the timestamps available upstream

with these response headers:

  X-Scale     "R,E,D" — the GRIB2 reference value and the binary and decimal
              scale factors, so the client can recover physical units
  X-Grid      "NIxNJ" — grid dimensions, which differ by product
  X-Kind      dbz | shear | mesh | category
  X-Modified  the upstream Last-Modified, for frame age

and Access-Control-Expose-Headers listing them, or the browser cannot read any
of it. That last point is easy to miss: without it the headers arrive and are
silently invisible to JavaScript, and a client falls back to assumed values that
happen to work until they don't.

A proxy is needed at all because NOAA's host sends no CORS header and the files
are gzipped GRIB2. The data itself is free and unmetered.


Products
--------

  hsr         seamless hybrid scan reflectivity — what reaches the ground
  composite   strongest return in the column, so broader and hotter
  shear02     instant azimuthal shear, 0-2 km — the low-level couplet
  shear36     instant azimuthal shear, 3-6 km — the mid-level mesocyclone
  rot30..1440 accumulated low-level rotation, 30 min to 24 hours
  rotml*      the same accumulations at mid level
  mesh        maximum estimated hail size
  ptyperefl   precipitation type with intensity, composed from two products


What was verified rather than assumed
-------------------------------------

  geo-registration   blocks painted at known lat/lon landed on Kansas, south
                     Texas and the Pacific Northwest, square and in place
  mercator maths     matches mapboxgl.MercatorCoordinate to six decimals
  frame age          about 2 minutes behind live, on a 2-minute cadence
  fallback           returns false for a small texture limit, a missing WebGL
                     context and a null map
  shear decode       physical distribution, peak 0.062 s^-1, nothing clamped


Things that cost time and are worth carrying
--------------------------------------------

1. A vertex position is not a texture coordinate. Passing mercator straight
   through samples a sliver of the ramp.

2. sinh() does not exist in GLSL ES 1.0. Expand it by hand.

3. The grids are equirectangular, the quad is mercator. Latitude has to be
   un-projected per fragment or the north stretches and the south squashes.

4. The multiply form ['*', expr, k] is rejected for text-size and circle-radius
   on GL 2.15. Assume it is rejected everywhere.

5. Custom layers do not appear in map.getStyle().layers and cannot be reordered
   with moveLayer. Remove and re-add instead.

6. Custom layers always render before the symbol pass, so one can never be drawn
   above labels. Hide the labels instead if that is needed.

7. Grid size and bit depth are NOT fixed across products. Reflectivity is
   7000x3500 and 16-bit; shear and rotation are 14000x7000 and 8-bit. Reading
   two bytes from an 8-bit image decodes without error and produces a spiky
   bimodal field that looks like data and is not. Both come from the response
   headers and the PNG's own IHDR chunk.

8. The draw floor is per product kind. A dBZ floor applied to shear discards
   almost the entire field, because real shear sits at bytes where 5 dBZ would
   be noise.

9. The colour ramp is sampled LINEAR and the palette carries a stop per half
   decibel — one per encoded byte. Those two go together. A coarser table
   stretched over 256 texels repeats colours, and then LINEAR has room to smear
   every boundary while NEAREST shows each repeat as a contour ring inside a
   slowly varying core. With a stop per value neither happens. Changing one
   without the other brings back whichever artefact the other was hiding.

10. The decode runs in a pool of four workers, built from a Blob so the module
    stays self-contained. Unfiltering a 14000x7000 PNG is about 650 ms of tight
    loop; on the main thread that is 650 ms where the map does not move. The
    buffers are transferred rather than copied, because a 98 MB grid would
    otherwise be duplicated twice per frame. It falls back to decoding inline
    where a content security policy blocks Blob workers.


The edge treatment, and three wrong versions of it
--------------------------------------------------

  hardware GL_LINEAR     averaged echoes with empty neighbours, inventing weak
                         returns. Every echo grew a soft halo.

  empties weighted 0     no halo, but at an edge only one neighbour holds data,
                         so edges became hard 1 km squares — invisible zoomed
                         out, obviously blocky zoomed in.

  empties weighted 0.5   smooth again, but an empty cell still carries a VALUE
                         of zero, so the average slid down the ramp and every
                         echo grew a false blue rim.

The fault in all three was letting emptiness affect the colour. It now cannot:
the value is averaged over the neighbours that hold data, renormalised over
those alone, and the empty ones reduce coverage instead. Coverage fades the
alpha, so an edge softens by going transparent rather than by changing hue.

Separately, the colour ramp is sampled LINEAR. The data is quantised to half a
decibel per byte and NEAREST made those steps show as contour banding.


Loop
----

loadSeries(n, onFrame) fetches a run of frames and setFrames/startLoop plays
them. Frames are held as decoded byte arrays rather than GPU textures — a dozen
14000x7000 textures is over a gigabyte of VRAM and the context is lost, while the
same frames as arrays upload in about 20 ms each.

Decoded frames are cached by product and timestamp, so a second loop over the
same window costs almost nothing. Measured: about 4 s cold for twelve
reflectivity frames, about 1 s warm.

startLoop runs on requestAnimationFrame, so it stops in a background tab without
being asked. Measured timing at 5x: 305 ms steps with 2 ms jitter, and the blend
ramps smoothly at 144 fps. Nothing in the playback stutters.

What does read as stutter is the data. MRMS publishes every two minutes, so a
loop is a sequence of discrete states, not motion. Blending cross-fades between
them, which dissolves rather than moves; with it off they step. Neither is
movement, because the frames contain positions and not velocities. Real movement
needs advection — estimating the shift between frames and warping the field along
it — which is a genuine piece of work and misbehaves when storms grow or decay
rather than travel.

loadSeries(count, step) controls spacing. MRMS publishes every two minutes, so
step 1 plays twelve frames over 24 minutes and step 2 plays twelve over 48. Wider
spacing covers more ground per step, which reads faster at the same playback
speed and suits watching a system travel; tight spacing suits watching one storm
develop. Neither is more correct.

This came from a measurement worth keeping: a reference renderer playing what it
labels the same two-minute product stepped its clock five minutes per frame, so
it was showing roughly every other frame. That is why its loop reads faster at
the same nominal speed — more weather per step, not a higher frame rate.

The selection always ends on the newest frame and returns what exists rather than
failing, so a wide step against a short listing simply yields fewer frames.


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
category. ptyperefl composes them as category * 100 + dBZ, which is the layout
the four-band palette expects — rain 2.5-94, snow 105-170, mix 205-270,
ice 305-360.

The flag values come from NOAA's published table, not from memory:

  -3  no coverage            0   no precipitation
   1  warm stratiform rain   3   snow
   6  convection             7   hail
  10  cool stratiform rain   91  tropical stratiform rain
                             96  tropical convective rain

Flags 2, 4, 5, 8 and 9 are unused, so this product has no freezing rain and no
sleet category. Only two of the palette's four bands can ever be filled from it —
rain and snow. A mix or ice band appearing means the mapping is wrong, not that
it is winter.

An earlier version had two codes backwards, reading 3 as freezing rain and 10 as
snow, which painted cool stratiform rain across Wyoming in snow blue. It looked
plausible and was wrong, which is the failure mode to watch for here.


Colour tables
-------------

loadPal() accepts the three .pal formats in common use: the GRLevelX keyword
form, the ColorTable block using Color[value] = rgb(...), and bare numeric rows
of "value r g b" with # comments. Bare tables are read as control points, so a
repeated value produces the hard band break those files rely on, and equal values
keep file order through the sort or the breaks invert.

Tables declaring units other than dBZ are refused rather than applied.


Not done
--------

The rotation scale has not been seen during an actual tornado warning. It is
anchored to published thresholds, but how it reads on a significant event is
untested.

Snow has never been drawn. Precipitation type separates rain from snow, and in
September every frame is rain, so the snow band is unexercised until winter.

Smoothing is a plain 3x3 mean. It works, but it softens the whole field rather
than only the edges, which is why the default is modest rather than high.
