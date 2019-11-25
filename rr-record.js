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

   function proxy_observer(inner, fn_observe) {
      const proxy = new Proxy(inner, {
         set: function(obj, k, v) {
            fn_observe(obj, 'set ' + k, [v]);
            obj[k] = v;
            return true;
         },
         get: function(obj, k) {
            this.proxies = {};
            if (typeof obj[k] == 'function') {
               if (this.proxies[k] === undefined) {
                  this.proxies[k] = function() {
                     let ret = obj[k].apply(obj, arguments);
                     fn_observe(obj, k, arguments, ret);
                     if (ret && SHOULD_PROXY[k]) {
                        ret = proxy_observer(ret, fn_observe);
                     }
                     return ret;
                  };
               }
               return this.proxies[k];
            }
            const ret = obj[k];
            //fn_observe(obj, 'get ' + k, [], ret); // Observe getter?
            return ret;
         },
      });
      return proxy;
   }

   function ensure_proxied(obj, func) {
      if (!obj) return obj;
      if (!obj._crr_proxy) {
         obj._crr_proxy = proxy_observer(obj, func);
      }
      return obj._crr_proxy;
   }

   // -

   function hook_setter(obj, name, fn_observe) {
      const orig_desc = Object.getOwnPropertyDescriptor(obj, name);
      const hook_desc = Object.assign({}, orig_desc);
      hook_desc.set = function(v) {
         orig_desc.set.call(this, v);
         fn_observe(this, name, v);
      };
      Object.defineProperty(obj, name, hook_desc);
   }

   // -

   let RECORDING_FRAMES = 0;
   let RECORDING = null;

   // -

   function inject_observer() {
      if (window._CRR_DISABLE) return;

      if (HTMLCanvasElement.prototype.getContext.log_canvas) {
         console.log('Ignoring duplicate inject...');
         return;
      }
      console.log('injecting into', window.location, '...');
      const orig_get_context = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function() {
         const inner = orig_get_context.apply(this, arguments);
         if (window._CRR_DISABLE) return inner;

         if (!inner) return inner;

         if (RECORDING_FRAMES) {
            RECORDING.pickle_call(this, 'getContext', arguments, inner);
         }

         return ensure_proxied(inner, function(obj, k, args, ret) {
            if (!RECORDING_FRAMES) return;

            if (k == 'drawImage') {
               args = [].slice.call(args);
               const src = args[0];
               const val = src.toDataURL();
               args[0] = RECORDING.snapshot(val);
            }

            RECORDING.pickle_call(obj, k, args, ret);
         });
      };
      HTMLCanvasElement.prototype.getContext.log_canvas = true;

      const fn_observe_setter = function(obj, name, v) {
         if (!RECORDING_FRAMES) return;
         RECORDING.pickle_call(obj, 'set ' + name, [v]);
      };

      hook_setter(HTMLCanvasElement.prototype, 'width', fn_observe_setter);
      hook_setter(HTMLCanvasElement.prototype, 'height', fn_observe_setter);

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
      console.log('[LogCanvas] Recording ' + n + ' frames...');
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
            console.log(`[LogCanvas] ${n} frames recorded! (${calls} calls)`);
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
