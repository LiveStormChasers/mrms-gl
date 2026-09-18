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
  index.html      standalone bench for development.


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

The flag values were confirmed against a live frame: 0 none, -3 outside radar
coverage, 1 warm stratiform rain, 6 convective rain, 7 hail, 10 snow, 91 and 96
tropical variants. Freezing rain and sleet do not occur in a September frame, so
the mix and ice band mappings come from the specification and stay UNVERIFIED
until winter. If those bands ever look wrong, start there.


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

No loop. The proxy serves only the newest frame: latest.bin ignores a timestamp
parameter and a per-timestamp path is a 404. The list endpoint reports which
runs exist upstream but none can be fetched. A loop needs a route that accepts a
timestamp, or the worker retaining recent frames.

The rotation scale has not been seen during an actual tornado warning. It is
anchored to published thresholds, but how it reads on a significant event is
untested.
