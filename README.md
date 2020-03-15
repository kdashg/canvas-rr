# `canvas-rr`: Canvas Record-and-Replay

For WebGL and Canvas2D.

# Development cycle

1. Make change
2. `./build.py` to regenerate `out/*`
3. Reload the extension
4. Test

# Recording

1. (Re)load the temporary extension from `manifest.json`
   (https://jdashg.github.io/misc/temporary-browser-extensions.html)
   * To reload on Firefox: about:debugging -> "canvas-rr" section -> "Reload" button
2. (Re)load the page you want to record
3. Open the Browser's Web Console (f12)
4. LogCanvas.download() to save the recording as `.json`

# Replay

1. Load `player.html`
2. Choose a json to load
3. Hit "Play"
