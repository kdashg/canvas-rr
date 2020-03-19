LogCanvas = (() => {
   const AUTO_RECORD_FRAMES = 60 * 60;
   const SKIP_EMPTY_FRAMES = true;
   const SNAPSHOT_LINE_WRAP = 100;
   const MAX_SNAPSHOT_SIZE = 16384;

   // -

   class SplitLogger {
      prefix = ''

      constructor(desc) {
         if (desc) {
            this.prefix = desc + ' ';
         }
         this.start = performance.now();
         this.last_split = this.start;
      }

      log(text) {
         let now = performance.now();
         const split_diff = now - this.last_split;
         const total_diff = now - this.start;
         console.log(`[${this.prefix}${split_diff|0}/${total_diff|0}ms]`, text);
         this.last_split = now;
      }
   };

   // -

   const TO_DATA_URL_C2D = (() => {
      const c = document.createElement('canvas');
      c._CRR_IGNORE = true;
      const c2d = c.getContext('2d');
      c2d._CRR_IGNORE = true;
      return c2d;
   })();

   function to_data_url(src, w, h) {
      if (src.toDataURL) return src.toDataURL();

      w = w || src.naturalWidth || src.videoWidth || src.width;
      h = h || src.naturalHeight || src.videoHeight || src.height;
      while (Math.max(w, h) >= MAX_SNAPSHOT_SIZE) { // Too large for Firefox.
         w = (w >> 1) || 1;
         h = (h >> 1) || 1;
      }

      const c2d = TO_DATA_URL_C2D;
      c2d.canvas.width = w;
      c2d.canvas.height = h;
      c2d.drawImage(src, 0, 0, w, h);

      const ret = c2d.canvas.toDataURL();
      if (ret == "data:,") throw 0; // Encoder failed.

      if (src instanceof HTMLImageElement) {
         src.toDataURL = function() {
            return ret;
         };

         src.addEventListener('load', e => {
            src.toDataURL = undefined;
         }, {
            capture: false,
            once: true,
         });
      }

      return ret;
   }

   // -

   class Recording {
      // String prefixes:
      // @: snapshot key
      // $: element key
      // ": actual string
      snapshots = {};
      snapshots_by_val = {};
      elem_info_by_key = {};
      frames = [];

      new_frame() {
         this.frames.push([]);
      }

      new_call(obj_key, func_name, args, ret) {
         const frame = this.frames[this.frames.length-1];
         const call = [obj_key, func_name, args];
         if (ret !== undefined) {
            call.push(ret);
         }
         frame.push(call);
      }

      last_id = 0;

      new_id() {
         return this.last_id += 1;
      }

      snapshot_str(obj, w, h) {
         const type = obj.constructor.name;

         if (obj instanceof ArrayBuffer) {
            const arr = new Uint8Array(obj);
            return type + ':' + arr.toString();
         }
         if (obj instanceof DataView) {
            const arr = new Uint8Array(obj.buffer);
            return type + ':' + arr.toString();
         }
         if (obj.buffer instanceof ArrayBuffer) {
            return type + ':' + obj.toString();
         }

         switch (type) {
         case 'HTMLCanvasElement':
         case 'HTMLImageElement':
         case 'HTMLVideoElement':
            return to_data_url(obj, w, h);
         }
         return undefined;
      }

      obj_key(obj) {
         if (!obj) return null;
         if (obj._lc_key) return obj._lc_key;

         const key = obj._lc_key = '$' + this.new_id();

         const info = {
            type: obj.constructor.name,
         };
         if (info.type == 'HTMLCanvasElement') {
            info.width = obj.width;
            info.height = obj.height;
            this.elem_info_by_key[key] = info;
         }
         return key;
      }

      pickle_obj(obj, w, h) {
         if (!obj) return null;

         if (obj._lc_key) return obj._lc_key;

         const val_str = this.snapshot_str(obj, w, h);
         if (val_str) {
            // Snapshot instead of object key.
            const prev_key = obj._lc_snapshot_key;
            if (prev_key) {
               // Has previous snapshot, but data might have changed.
               const prev_val_str = this.snapshots[prev_key];
               if (val_str == prev_val_str) return prev_key;
            }

            const key = obj._lc_snapshot_key = '@' + this.new_id();
            this.snapshots[key] = val_str;
            return key;
         }

         return this.obj_key(obj);
      }

      pickle_arg(arg) {
         if (typeof arg == 'string') return '"' + arg;
         if (!arg) return arg;
         if (arg instanceof Array) return arg.map(x => this.pickle_arg(x));
         if (typeof arg == 'object') return this.pickle_obj(arg);
         return arg;
      }

      pickle_call(obj, func_name, call_args, call_ret) {
         const obj_key = this.obj_key(obj);
         const args = [].map.call(call_args, x => this.pickle_arg(x));
         const ret = this.pickle_arg(call_ret);
         this.new_call(obj_key, func_name, args, ret);
      }

      to_json_arr() {
         const slog = new SplitLogger('to_json_arr');

         const elem_info_json = JSON.stringify(this.elem_info_by_key, null, 3);
         slog.log(`${elem_info_json.length} bytes of elem_info_json.`);

         function chunk(src, chunk_size) {
            const ret = [];
            let pos = 0;
            while (pos < src.length) {
               const end = pos + chunk_size;
               ret.push(src.slice(pos, end));
               pos = end;
            }
            return ret;
         }

         const parts = [];
         parts.push(
            '{', // begin root object
            `\n"elem_info_by_key": ${elem_info_json},`,
            '\n"frames": [', // begin frames
            '\n   ['         // begin frame
         );

         let add_comma = false;
         for (const [i, frame] of Object.entries(this.frames)) {
            if (add_comma) {
               parts.push('\n   ],[');
            }
            add_comma = true;

            if (frame.length) {
               let add_comma2 = false;
               for (const call of frame) {
                  if (add_comma2) {
                     parts.push(',');
                  }
                  add_comma2 = true;

                  parts.push('\n      ', JSON.stringify(call));
               }
            }
         }

         const chunked_snapshots = {};
         for (const [k, v] of Object.entries(this.snapshots)) {
            chunked_snapshots[k] = chunk(v, SNAPSHOT_LINE_WRAP);
         }
         const snapshots_json = JSON.stringify(chunked_snapshots, null, 3);

         parts.push(
            '\n   ]', // end of frame
            '\n],',    // end of frames
            '\n"snapshots": ',
            snapshots_json,
            '\n}', // end of root object
            '\n'
         );

         // -

         let size = 0;
         for (const x of parts) {
            size += x.length;
         }
         slog.log(`${size} bytes in ${parts.length} parts...`);

         let join = '';
         for (const x of parts) {
            join += x;
         }

         slog.log(`done`);
         return [join];
      }
   };

   // -

   const DONT_HOOK = {
      'constructor': true,
   };

   function hook_props(obj, fn_observe) {
      const descs = Object.getOwnPropertyDescriptors(obj);

      for (const k in descs) {
         if (DONT_HOOK[k]) continue;

         const desc = descs[k];
         if (desc.set) {
            //console.log(`hooking setter: ${obj.constructor.name}.${k}`);
            const was = desc.set;
            desc.set = function(v) {
               was.call(this, v);
               fn_observe(this, 'set ' + k, [v], undefined);
            };
            continue;
         }
         if (typeof desc.value === 'function') {
            //console.log(`hooking func: ${obj.constructor.name}.${k}`);
            const was = desc.value;
            desc.value = function() {
               const ret = was.apply(this, arguments);
               fn_observe(this, k, arguments, ret);
               return ret;
            };
            continue;
         }
      }

      Object.defineProperties(obj, descs);
   }

   /*
   function log_observe(obj, name, args, ret) {
      console.log(`${obj.constructor.name}.${name}(${JSON.stringify([].slice.call(args))}) -> ${ret}`);
   }
   hook_props(HTMLCanvasElement.prototype, log_observe);
   hook_props(CanvasRenderingContext2D.prototype, log_observe);
   */

   // -

   let RECORDING_FRAMES = 0;
   let RECORDING = null;

   // -

   const HOOK_LIST = [
      HTMLCanvasElement,
      CanvasRenderingContext2D,
      Path2D,
      WebGLRenderingContext,
      WebGL2RenderingContext,
   ];
   const HOOK_CTOR_LIST = [
      Path2D,
   ];
   const IGNORED_FUNCS = {
      'toDataURL': true,
      'getTransform': true,
      'getParameter': true,
   };

   function inject_observer() {
      if (window._CRR_NO_INJECT) return;
      window._CRR_NO_INJECT = true;

      console.log(`[LogCanvas@${window.origin}] Injecting for`, window.location);

      function fn_observe(obj, k, args, ret) {
         if (obj._CRR_IGNORE) return;
         if (!RECORDING_FRAMES) return;

         if (IGNORED_FUNCS[k]) return;

         RECORDING.pickle_call(obj, k, args, ret);
      }

      for (const cur of HOOK_LIST) {
         hook_props(cur.prototype, fn_observe);
      }

      for (const cur of HOOK_CTOR_LIST) {
         const name = cur.prototype.constructor.name;
         const hook_class = class extends cur {
            constructor() {
               super(...arguments);
               RECORDING.pickle_call(null, 'new ' + name, arguments, this);
            }
         };
         hook_class.prototype.constructor.name = name;
         window[name] = hook_class;
      }

      if (AUTO_RECORD_FRAMES) {
         record_frames(AUTO_RECORD_FRAMES); // Grab initial.
      }
   };

   function download_text_arr(dry_run, filename, textArr, mimetype='text/plain') {
      const blob = new Blob(textArr, {type: mimetype});
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = filename;

      document.body.appendChild(link);
      if (!dry_run) {
         link.click();
      }
      document.body.removeChild(link);
   }

   function record_frames(n) {
      console.log(`[LogCanvas@${window.origin}] Recording ${n} frames...`);
      RECORDING_FRAMES = n+1;
      RECORDING = new Recording();

      function per_frame() {
         const cur_frame = RECORDING.frames[RECORDING.frames.length-1];
         if (SKIP_EMPTY_FRAMES && cur_frame && !cur_frame.length) {
            requestAnimationFrame(per_frame);
            return;
         }
         RECORDING_FRAMES -= 1;
         RECORDING_FRAMES |= 0;
         if (!RECORDING_FRAMES) {
            let calls = 0;
            RECORDING.frames.forEach(frame_calls => {
               calls += frame_calls.length;
            });
            console.log(`[LogCanvas@${window.origin}] ${n} frames recorded! (${calls} calls)`);
            return;
         }
         RECORDING.new_frame();
         requestAnimationFrame(per_frame);
      }
      per_frame();
   }

   function record_next_frames(n) {
      requestAnimationFrame(() => {
         record_frames(n);
      });
   }

   function download(dry_run = false) {
      const slog = new SplitLogger('download');
      const arr = RECORDING.to_json_arr();
      dry_run && slog.log(`to_json_arr`);
      download_text_arr(dry_run, 'recording.json', arr);
      dry_run && slog.log(`done`);
   }

   return {
      inject_observer: inject_observer,
      record_frames: record_frames,
      record_next_frames: record_next_frames,
      download: download,
   };
})();

LogCanvas.inject_observer();
