# `canvas-rr`: Canvas Record-and-Replay

For WebGL and Canvas2D.

# Development cycle

1. Make change
2. `./build.py` to regenerate `out/*`
3. Reload the extension
4. Test

## Loading temporary extensions

### Firefox

1. URL: about:debugging
2. In the sidebar under "Setup" select "This Nightly" (or similar)
3. Under "Temporary Extensions", hit "Load Temporary Add-on..."
4. Select file "canvas-rr/web-ext/manifest.json"
5. You should see a new "Temporary Extension" entry for "canvas-rr" (including Reload and Remove buttons)

### Chrome

1. URL: chrome://extensions/
2. At the top-right, enable "Developer mode"
3. Near the top-left, hit "Load unpacked"
4. Select folder "canvas-rr/web-ext"
5. You should see a new extension tile for "canvas-rr" (including reload icon and Remove button)

# Recording

1. (Re)load the temporary extension (see above)
2. (Re)load the page you want to record
3. Open the Browser's Web Console (F12)
4. Let it record via AUTO_RECORD_FRAMES
   4a. You can also use LogCanvas.record_frames(n) or LogCanvas.record_next_frames(n),
       but starting recordings in the middle of execution does not work yet
5. LogCanvas.download() to save the recording as `.json`.
   (you don't have to wait for all the frames to finish recording)
   Note: Recordings are often tens to hundreds of megabytes

# Replay: Using [player.html](https://kdashg.github.io/canvas-rr/player.html)

1. Load player.html
2. Choose a json to load
3. Hit "Play"
