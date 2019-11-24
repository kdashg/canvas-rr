LogCanvas = (() => {
   const AUTO_RECORD_FRAMES = 60;

   // -

   let last_id = 1;
   function next_id() {
      last_id += 1;
      return last_id;
   }

   function tag_of(obj) {
      if (obj.tag === undefined) {
         const name = obj.constructor.name;
         obj.tag = name + '$' + next_id();
      }
      return obj.tag;
   }

   function val_or_tag(x) {
      if (typeof x === 'object') return tag_of(x);
      return JSON.stringify(x);
   }

   function merge_json(x, y) {
      console.assert(x.endsWith('}'))
      console.assert(y.startsWith('{'))
      return x.substring(0, x.length-1) + ',' + y.substring(1);
   }

   // -

   class Recording {
      // String prefixes:
      // @: snapshot key
      // $: element key
      // ": actual string
      snapshots = {};
      elem_type_by_key = {};
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
         return key;
      }

      object_key(obj) {
         if (!obj) return null;
         if (obj._lc_key === undefined) {
            const id = this.prev_id += 1;
            const key = '$' + id;
            const type = obj.constructor.name;
            this.elem_type_by_key[key] = type;
            obj._lc_key = key;
         }
         return obj._lc_key;
      }

      pickle_arg(arg) {
         if (!arg) return arg;
         if (typeof arg == 'string') return '"' + arg;
         if (arg instanceof Array) return arg.map(x => this.pickle_arg(x));
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
         const header_obj = {
            snapshots: this.snapshots,
            elem_type_by_key: this.elem_type_by_key,
         };
         const header_json = JSON.stringify(header_obj, null, 3);

         console.assert(header_json.endsWith('\n}'))
         const parts = [header_json.substring(0, header_json.length-2)];
         parts.push(
            ',\n   frames: ['
         );
         let first_time = true;
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
         }
         parts.push(
            '\n   ]',
            '\n}'
         );
         return parts;
      }
   };

   function proxy_observer(inner, fn_observe) {
      const proxy = new Proxy(inner, {
         set: function(obj, k, v) {
            fn_observe(obj, k, [v]);
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
                     if (ret && k === 'getExtension') {
                        ret = proxy_observer(ret, fn_observe);
                     }
                     return ret;
                  };
               }
               return this.proxies[k];
            }
            const ret = obj[k];
            //fn_observe(obj, k, [], ret);
            return ret;
         },
      });
      return proxy;
   }

   // -

   let RECORDING_FRAMES = 0;
   let RECORDING = null;

   // -

   function inject_observer() {
      if (HTMLCanvasElement.prototype.getContext.log_canvas) {
         console.log('Ignoring duplicate inject...');
         return;
      }
      console.log('injecting into', window.location, '...');
      const orig_get_context = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function() {
         const inner = orig_get_context.apply(this, arguments);
         if (!inner) return inner;
         if (inner.proxy === undefined) {
            const canvas_tag = tag_of(this);
            const tag = tag_of(inner);
            console.log(`${canvas_tag}.getContext(${arguments[0]}) -> ${tag}`);
            inner.proxy = proxy_observer(inner, function(obj, k, args, ret) {
               if (!RECORDING_FRAMES) return;
               RECORDING.pickle_call(obj, k, args, ret);
            });
         }
         return inner.proxy;
      };
      HTMLCanvasElement.prototype.getContext.log_canvas = true;

      if (AUTO_RECORD_FRAMES) {
         record_frames(AUTO_RECORD_FRAMES); // Grab initial.
      }
   };

   function download_text_arr(filename, textArr, mimetype='text/plain') {
      const blob = new Blob(textArr, {type: mimetype});
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = filename;

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
   }

   function record_frames(n) {
      console.log('[LogCanvas] Recording ' + n + ' frames...');
      RECORDING_FRAMES = n;
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
         RECORDING.frames.push([]);
         requestAnimationFrame(per_frame);
      }
      requestAnimationFrame(per_frame);
   }

   function record_next_frames(n) {
      requestAnimationFrame(() => {
         record_frames(n);
      });
   }

   function download() {
      //const arr = [JSON.stringify(RECORDING, null, 3)];
      const arr = RECORDING.to_json_arr();
      download_text_arr('recording.json', arr);
   }

   return {
      inject_observer: inject_observer,
      record_frames: record_frames,
      record_next_frames: record_next_frames,
      download: download,
   };
})();

LogCanvas.inject_observer();
