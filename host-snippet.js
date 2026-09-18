/* ============================================================================
   MRMS-GL — what index.html adds
   ----------------------------------------------------------------------------
   Copyright (c) 2026 Live Storm Chasers Network LLC.  All rights reserved.
   Source-visible, not open source. See LICENSE — using this code requires
   written permission.

   This file in particular is meant to be READ rather than pasted. It shows the
   shape of the integration; copying it into another project still needs
   permission first.
   ----------------------------------------------------------------------------
   Paste this inside the existing Radar module (or next to it). The renderer and
   the fetcher live at their own URL, so index.html grows by this much and no
   more; fixing the renderer later means redeploying that repo, not this file.

   Written against the real integration points in index.html:
     Radar.getRadarBeforeId(mode)   decides where the radar sits in the stack
     $('radarLayerOrder').value     'below' | 'above' — the user's choice
     $('radarOpacity')              the existing slider, 0..100
     LayerOrderPanel.scheduleReorder(ms)  re-asserts order after a layer is added

   It does NOT replace the raster renderer. If the GPU path cannot run, attach()
   returns false and the existing renderer carries on untouched.
============================================================================ */

// The host's own raster radar layer, hidden while the GPU one is up.
const RASTER_LAYER_ID = 'your-raster-radar-layer';

// 1. Load the two modules once, before first use.
//    <script src=".../mrms-gl.js"></script>
//    <script src=".../mrms-fetch.js"></script>

const MRMSGLHost = {
  _on: false,

  // Swap the raster radar for the GPU one. Returns false and changes nothing if
  // the GPU path is unavailable, so the caller can simply not offer the option.
  enable() {
    const map = State.map;
    if (!map || typeof MRMSGL === 'undefined') return false;

    const beforeId = Radar.getRadarBeforeId($('radarLayerOrder')?.value || 'below');
    if (!MRMSGL.attach(map, beforeId)) {
      console.warn('[MRMS-GL] unavailable:', MRMSGL.lastError || 'no WebGL / texture too small');
      return false;
    }

    // Match whatever the slider already says rather than resetting it.
    MRMSGL.setOpacity(($('radarOpacity')?.value ?? 100) / 100);

    // Hide the raster layer rather than removing it — going back is then instant.
    if (map.getLayer(RASTER_LAYER_ID)) {
      map.setLayoutProperty(RASTER_LAYER_ID, 'visibility', 'none');
    }

    // The order engine reverts a plain moveLayer within ~600ms, so let it settle
    // the stack itself instead of fighting it.
    if (typeof LayerOrderPanel !== 'undefined') LayerOrderPanel.scheduleReorder(120);

    MRMSFetch.start((bytes) => MRMSGL.setData(bytes), 90 * 1000);
    this._on = true;
    return true;
  },

  disable() {
    const map = State.map;
    MRMSFetch.stop();
    if (typeof MRMSGL !== 'undefined') MRMSGL.detach(map);
    if (map && map.getLayer(RASTER_LAYER_ID)) {
      map.setLayoutProperty(RASTER_LAYER_ID, 'visibility', 'visible');
    }
    this._on = false;
  },

  isOn() { return this._on; },

  // Minutes behind real time, or null before the first frame lands. MRMS runs
  // every two minutes about a minute behind live, so 1-3 is healthy.
  frameAgeMin() {
    const ms = (typeof MRMSFetch !== 'undefined') ? MRMSFetch.frameAgeMs() : null;
    return ms === null ? null : Math.round(ms / 60000);
  }
};

/* --- hook the two existing controls ------------------------------------- */

// Opacity: the slider already drives Radar.setOpacity; mirror it to the GPU layer.
$('radarOpacity')?.addEventListener('input', e => {
  if (MRMSGLHost.isOn()) MRMSGL.setOpacity(e.target.value / 100);
});

// Layer order: re-attach at the new anchor. A custom layer cannot be moved with
// moveLayer the way a normal one can, so it is removed and added back.
$('radarLayerOrder')?.addEventListener('change', () => {
  if (!MRMSGLHost.isOn()) return;
  const map = State.map;
  MRMSGL.detach(map);
  MRMSGL.attach(map, Radar.getRadarBeforeId($('radarLayerOrder').value || 'below'));
  if (typeof LayerOrderPanel !== 'undefined') LayerOrderPanel.scheduleReorder(120);
});

/* --- notes ---------------------------------------------------------------
   No loop yet. The worker serves only the newest frame: /mrms/latest.bin
   ignores ?t= and ?time=, and /mrms/<stamp>.bin is a 404. /mrms/list reports
   which runs exist upstream but none of them can be fetched. A loop needs a
   worker route that accepts a timestamp, or the worker keeping recent frames.

   Cost is unchanged from the current renderer: one request every 90 seconds to
   a worker of our own, against a free and unmetered NOAA feed. No key, no
   account, no quota.
-------------------------------------------------------------------------- */
