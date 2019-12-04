LogCanvas = (() => {
   const AUTO_RECORD_FRAMES = 60;

   // -

   class SplitLogger {
      prefix = ''

      constructor(desc) {
         if (desc) {
            this.prefix = desc + ' '
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

   class SnapshotT {
      constructor(key) {
         this.key = key;
      }
   };

   class Recording {
      // String prefixes:
      // @: snapshot key
      // $: element key
      // ": actual string
      snapshots = {};
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

      prev_id = 0;
      snapshot(val) {
         const id = this.prev_id += 1;
         const key = '@' + id;
         this.snapshots[key] = val;
         return new SnapshotT(key);
      }

      object_key(obj) {
         if (!obj) return null;
         if (obj._lc_key === undefined) {
            const id = this.prev_id += 1;
            const key = '$' + id;
            obj._lc_key = key;

            const info = {};
            this.elem_info_by_key[key] = info;
            info.type = obj.constructor.name;

            if (info.type == 'HTMLCanvasElement') {
               info.width = obj.width;
               info.height = obj.height;
            }
         }
         return obj._lc_key;
      }

      pickle_arg(arg) {
         if (typeof arg == 'string') return '"' + arg;
         if (!arg) return arg;
         if (arg instanceof Array) return arg.map(x => this.pickle_arg(x));
         if (arg instanceof SnapshotT) return arg.key;
         if (typeof arg == 'object') return this.object_key(arg);
         return arg;
      }

      pickle_call(obj, func_name, call_args, call_ret) {
         const obj_key = this.object_key(obj);
         const args = [].map.call(call_args, x => this.pickle_arg(x));
         const ret = this.pickle_arg(call_ret);
         this.new_call(obj_key, func_name, args, ret);
      }

      to_json_arr() {
         const slog = new SplitLogger('to_json_arr');
         const header_obj = {
            snapshots: this.snapshots,
            elem_info_by_key: this.elem_info_by_key,
         };
         const header_json = JSON.stringify(header_obj, null, 3);
         slog.log(`${header_json.length} bytes of header_json.`);


         console.assert(header_json.endsWith('\n}'))
         const parts = [header_json.substring(0, header_json.length-2)];
         slog.log(`header_json.substring`);
         parts.push(
            ',\n   "frames": ['
         );
         let first_time = true;
         let i = 0;
         for (const frame of this.frames) {
            if (!first_time) {
               parts.push(',');
            }
            first_time = false;

            parts.push('\n      [');
            if (frame.length) {
               let first_time2 = true;
               for (const call of frame) {
                  if (!first_time2) {
                     parts.push(',');
                  }
                  first_time2 = false;

                  parts.push('\n         ', JSON.stringify(call));
               }
               parts.push('\n      ');
            }
            parts.push(']');
            //slog.log(`frame[${i}]`);
            i += 1;
         }
         parts.push(
            '\n   ]',
            '\n}'
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

   const SHOULD_PROXY = {
      getExtension: true,
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
   ];

   function inject_observer() {
      if (window._CRR_NO_INJECT) return;
      window._CRR_NO_INJECT = true;

      console.log(`[LogCanvas@${window.origin}] Injecting for`, window.location);

      function fn_observe(obj, k, args, ret) {
         if (!RECORDING_FRAMES) return;

         if (k == 'drawImage') {
            args = [].slice.call(args);
            const src = args[0];
            const val = src.toDataURL();
            args[0] = RECORDING.snapshot(val);
         }

         RECORDING.pickle_call(obj, k, args, ret);
      }

      for (const cur of HOOK_LIST) {
         hook_props(cur.prototype, fn_observe);
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
