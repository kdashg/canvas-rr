LogCanvas = (() => {
   const GL = WebGL2RenderingContext;

   const RECORDING_VERSION = 5;
   const AUTO_RECORD_FRAMES = 3 * 60;
   const SKIP_EMPTY_FRAMES = true;
   const SNAPSHOT_LINE_WRAP = 100;
   const MAX_SNAPSHOT_SIZE = 16384;
   const SNAPSHOT_INLINE_LEN = 100;
   const READABLE_SNAPSHOTS = false;
   const DEDUPE_SNAPSHOTS = true;
   const LOG_CALL_NAME_LIST = [
      //'drawImage',
      //'getContext',
      //'linkProgram', 'bindAttribLocation',
      //'getParameter',
      //'bindBuffer', 'bufferData', 'bufferSubData',
   ];
   const LINK_PROGRAM_INJECT_BIND_ATTRIB_LOCATION = true;
   const GET_PARAMETER_OVERRIDES = {};
   //GET_PARAMETER_OVERRIDES[GL.MAX_TEXTURE_SIZE] = 8192;

   // -

   // MS Fishbowl overrides window.performance with its own custom
   // object for some reason, so save this before Fishbowl has a chance
   // to mess with it.
   const perf = window.performance;
   function performance_now() {
      return perf.now();
   }

   class SplitLogger {
      prefix = ''

      constructor(desc) {
         if (desc) {
            this.prefix = desc + ' ';
         }
         this.start = performance_now();
         this.last_split = this.start;
      }

      log(text) {
         let now = performance_now();
         const split_diff = now - this.last_split;
         const total_diff = now - this.start;
         console.log(`[${this.prefix}${split_diff|0}/${total_diff|0}ms]`, text);
         this.last_split = now;
      }
   };

   // -

   function suffix_scaled(val) {
      const SUFFIX_LIST = ['n', 'u', 'm', '', 'K', 'M', 'G', 'T'];
      const UNSCALED_SUFFIX = SUFFIX_LIST.indexOf('');
      let tier = Math.floor((Math.log10(val) / 3));
      tier += UNSCALED_SUFFIX;
      tier = Math.max(0, Math.min(tier, SUFFIX_LIST.length-1));
      tier -= UNSCALED_SUFFIX;
      const tier_base = Math.pow(1000, tier);
      return [val / tier_base, SUFFIX_LIST[tier + UNSCALED_SUFFIX]];
   }

   function to_suffixed(val, fixed) {
      const [scaled, suffix] = suffix_scaled(val);
      if (!suffix) return val;

      if (fixed === undefined) {
         fixed = 2 - (Math.log10(scaled) | 0);
      }
      return `${scaled.toFixed(fixed)}${suffix}`;
   }

   // -

   const should_ignore_set = new WeakSet();

   function new_ignored_c2d() {
      const c = document.createElement('canvas');
      should_ignore_set.add(c);
      const c2d = c.getContext('2d');
      should_ignore_set.add(c2d);
      return c2d;
   }

   let TO_DATA_URL_C2D = new_ignored_c2d();

   function to_data_url(src, w, h) {
      if (src.toDataURL) return src.toDataURL();

      w = w || src.naturalWidth || src.videoWidth || src.width;
      h = h || src.naturalHeight || src.videoHeight || src.height;
      while (Math.max(w, h) >= MAX_SNAPSHOT_SIZE) { // Too large for Firefox.
         w = (w >> 1) || 1;
         h = (h >> 1) || 1;
      }
      let c2d = TO_DATA_URL_C2D;
      c2d.canvas.width = w;
      c2d.canvas.height = h;
      if (src instanceof ImageData) {
         c2d.putImageData(src, 0, 0);
      } else {
         c2d.drawImage(src, 0, 0, w, h);
      }

      let ret;
      try {
         ret = c2d.canvas.toDataURL();
      } catch (e) {
         if (e instanceof DOMException &&
             e.name == 'SecurityError') {
            console.warn('After', c2d, '.drawImage(', src, '), ', c2d.canvas, '.toDataURL() failed with', e.name, ', recording black:', e);
            c2d = TO_DATA_URL_C2D = new_ignored_c2d();
            c2d.canvas.width = w;
            c2d.canvas.height = h;
            ret = c2d.canvas.toDataURL();
         } else {
            throw e;
         }
      }
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
      if (src instanceof ImageBitmap) {
         src.toDataURL = function() {
            return ret;
         };
      }

      return ret;
   }

   // -

   const Base64 = {
      encode: dec_ab => {
         const dec_u8a = new Uint8Array(dec_ab);
         let remaining = dec_u8a;
         let dec_bstr = "";
         while (remaining.length) {
            const chunk = remaining.slice(0, 1000);
            remaining = remaining.slice(1000);
            dec_bstr += String.fromCodePoint(...chunk);
         }
         const enc = btoa(dec_bstr);
         return enc;
      },
      decode: enc => {
         const dec_bstr = atob(enc);
         const dec_u8a = new Uint8Array([].map.call(dec_bstr, x => x.codePointAt(0)));
         return dec_u8a.buffer;
      },
   };

   function snapshot_if_array_buffer(obj, length_only) {
      const type = obj.constructor.name;

      let view;
      if (obj instanceof ArrayBuffer) {
         view = new Uint8Array(obj);
      } else if (obj instanceof DataView) {
         view = new Uint8Array(obj, obj.byteOffset, obj.byteLength);
      } else if (obj.buffer instanceof ArrayBuffer) {
         view = obj;
      } else {
         return undefined;
      }

      if (length_only) {
         return [type + ':*' + view.length];
      }
      let str;
      if (READABLE_SNAPSHOTS) {
         str = view.toString();
      } else {
         str = '^' + Base64.encode(view.buffer);
      }
      let hash;
      if (DEDUPE_SNAPSHOTS) {
         // We must hash the type in too!
         // I don't think it's worth it to de-dupe data across types.
         hash = fnv1a_32(type);
         hash = fnv1a_32(view, hash);
         hash = '0x' + hash.toString(16);
      }
      return [type + ':' + str, hash];
   }

   // -

   // Because Everything Is Doubles, we only have 53bit integer precision,
   // so i32*i32 is imprecise (i.e. wrong) for larger numbers.
   function mul_i32(a, b) {
      const ah = (a >> 16) & 0xffff;
      const al = a & 0xffff;
      return ((ah*b << 16) + (al*b|0)) | 0;
   }

   // FNV-1a: A solid and simple non-cryptographic hash.
   // https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
   // (Would be simpler if doing full-precision u32*u32 were easier in JS...)
   function fnv1a_32(input, continue_from) {
      let bytes = input;
      if (typeof bytes == 'string') {
         bytes = new Uint8Array([].map.call(bytes, x => x.codePointAt(0)));
      } else if (bytes.buffer instanceof ArrayBuffer) {
         bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      } else if (bytes instanceof ArrayBuffer) {
         bytes = new Uint8Array(bytes.buffer);
      } else {
         throw input.constructor.name;
      }

      const PRIME = 0x01000193;
      const OFFSET_BASIS = 0x811c9dc5;

      if (continue_from === undefined) {
         continue_from = OFFSET_BASIS;
      }
      let hash = continue_from;
      bytes.forEach(c => {
         // i32*i32->i32 has the same bit-result as u32*u32->u32.
         hash = mul_i32(PRIME, hash ^ c);
      });

      const u32 = new Uint32Array(1);
      u32[0] = hash;
      return u32[0];
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

      // -

      snapshot_str(obj, func_name, arg_id) {
         const type = obj.constructor.name;
         switch (type) {
         case 'HTMLCanvasElement':
         case 'HTMLImageElement':
         case 'HTMLVideoElement':
         case 'ImageBitmap':
         case 'ImageData':
            return [to_data_url(obj)];

         case 'CanvasRenderingContext2D':
         case 'WebGLRenderingContext':
         case 'WebGL2RenderingContext':
            return undefined;
         }

         if (type == 'Object') {
            const str = JSON.stringify(obj);
            return [type + ':' + str];
         }

         const length_only = (func_name == 'readPixels');
         const snapshot = snapshot_if_array_buffer(obj, length_only);
         if (snapshot !== undefined) return snapshot;

         console.error(`[LogCanvas@${window.origin}] Warning: Unrecognized type "${type}" in snapshot_str for ${func_name}.${arg_id}: `, obj);
         return undefined;
      }

      key_by_obj = new WeakMap();

      obj_key(obj) {
         if (!obj) return null;
         let key = this.key_by_obj.get(obj);
         if (key) return key;

         key = '$' + this.new_id();
         this.key_by_obj.set(obj, key);

         const info = {
            type: obj.constructor.name,
         };
         if (['HTMLCanvasElement', 'OffscreenCanvas'].includes(info.type)) {
            info.width = obj.width;
            info.height = obj.height;
            this.elem_info_by_key[key] = info;
         }
         return key;
      }

      prev_snapshot_key_by_obj = new WeakMap();

      pickle_obj(obj, func_name, arg_id) {
         if (!obj) return null;

         {
            const key = this.key_by_obj.get(obj);
            if (key) return key;
         }

         if (arg_id == -1) {
            // Return values can be ignored.
            const ctor = obj.constructor;
            if (ctor == ImageData || ctor == TextMetrics) {
               return '#' + ctor.name;
            }
         }

         let snapshot;
         if (arg_id != -1) {
            // Don't snapshot return values.
            snapshot = this.snapshot_str(obj, func_name, arg_id);
         }
         if (snapshot) {
            // Snapshot instead of just tagging with object key.
            const [val_str, hash] = snapshot;
            if (!val_str.startsWith('data:') && val_str.length <= SNAPSHOT_INLINE_LEN) {
               return '=' + val_str;
            }
            const prev_key = this.prev_snapshot_key_by_obj.get(obj);
            if (prev_key) {
               // Has previous snapshot, but data might have changed.
               const prev_val_str = this.snapshots[prev_key];
               if (val_str == prev_val_str) return prev_key;
            }
            let uuid = hash;
            if (!uuid) {
               uuid = this.new_id();
            }
            const root_key = '@' + uuid;
            let collision_id = 0;
            let key = root_key;
            while (this.snapshots[key]) {
               //console.log(`Deduping ${key} (${val_str.length} chars)`);
               if (this.snapshots[key] == val_str) break;
               collision_id += 1;
               key = root_key + '.' + collision_id;
            }
            if (collision_id) {
               console.warn(`Collision while de-duping snapshot -> ${key}`);
            }

            this.prev_snapshot_key_by_obj.set(obj, key);
            this.snapshots[key] = val_str;
            return key;
         }

         return this.obj_key(obj);
      }

      pickle_arg(arg, func_name, i, spew) {
         if (spew) {
            console.log('pickle_arg', {arg});
         }
         if (typeof arg == 'string') return '"' + arg;
         if (!arg) return arg;
         if (arg instanceof Array) return arg.map(x => this.pickle_arg(x, func_name, i));
         if (typeof arg == 'object') return this.pickle_obj(arg, func_name, i);
         return arg;
      }

      pickle_call(obj, func_name, call_args, call_ret) {
         if (LOG_CALL_NAME_LIST.includes(func_name)) {
            console.log('pickle_call', ...arguments);
         }
         const obj_key = this.obj_key(obj);
         const args = [].map.call(call_args, (x,i) => this.pickle_arg(x, func_name, i));
         const ret = this.pickle_arg(call_ret, func_name, -1);
         this.new_call(obj_key, func_name, args, ret);
      }

      to_json_arr() {
         const slog = new SplitLogger('to_json_arr');

         const elem_info_json = JSON.stringify(this.elem_info_by_key, null, 3);
         slog.log(`${to_suffixed(elem_info_json.length)} bytes of elem_info_json.`);

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
            `\n"version": ${RECORDING_VERSION},`,
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
         slog.log(`${to_suffixed(size)} bytes in ${to_suffixed(parts.length)} parts...`);

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
      'toDataURL': true,
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
               try {
                  fn_observe(this, 'set ' + k, [v], undefined);
               } catch (e) {
                  console.error(e);
                  throw e;
               }
            };
            continue;
         }
         if (typeof desc.value === 'function') {
            //console.log(`hooking func: ${obj.constructor.name}.${k}`);
            const was = desc.value;
            desc.value = function() {
               let ret;
               try {
                  ret = was.apply(this, arguments);
               } catch (e) {
                  console.error(e, 'from', obj, `.${k}(`, ...arguments, `)`);
               }
               try {
                  ret = fn_observe(this, k, arguments, ret);
               } catch (e) {
                  console.error(e);
                  throw e;
               }
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
      OffscreenCanvas,
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
      //'getParameter': true,
   };

   const is_hooked_set = new WeakSet();

   function inject_observer() {
      console.log(`[LogCanvas@${window.origin}] Injecting for`, window.location);

      function fn_observe(obj, k, args, ret) {
         if (should_ignore_set.has(obj)) return ret;
         if (!RECORDING_FRAMES) return ret;

         if (IGNORED_FUNCS[k]) return ret;

         RECORDING.pickle_call(obj, k, args, ret);

         if (k == 'getExtension') {
            if (ret && !is_hooked_set.has(ret.__proto__)) {
               //console.log(`[LogCanvas@${window.origin}] getExtension`, args);
               is_hooked_set.add(ret.__proto__);
               hook_props(ret.__proto__, fn_observe);
            }
         }

         if (k == 'getParameter') {
            const override = GET_PARAMETER_OVERRIDES[args[0]];
            if (override !== undefined) {
               console.log(`getParameter(0x${args[0].toString(16)}) -> ${ret} -> ${override}`);
               ret = override;
            }
         }

         if (LINK_PROGRAM_INJECT_BIND_ATTRIB_LOCATION && k == 'linkProgram') {
            const was = RECORDING_FRAMES;
            RECORDING_FRAMES = 0; // Prevent re-entrancy.

            const gl = obj;
            const prog = args[0];
            const n = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES);
            for (let i = 0; i < n; i++) {
               const aa = gl.getActiveAttrib(prog, i);
               const loc = gl.getAttribLocation(prog, aa.name);
               console.assert(loc != -1, {i, aa, loc});
               RECORDING.pickle_call(gl, 'bindAttribLocation', [prog, loc, aa.name]);
            }
            RECORDING.pickle_call(gl, 'linkProgram', [prog]);

            RECORDING_FRAMES = was;
         }

         return ret;
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
         if (RECORDING_FRAMES) {
            const cur_frame = RECORDING.frames[RECORDING.frames.length-1];
            if (SKIP_EMPTY_FRAMES && cur_frame && !cur_frame.length) {
               requestAnimationFrame(per_frame);
               return;
            }
            RECORDING_FRAMES -= 1;
            RECORDING_FRAMES |= 0;
         }
         if (!RECORDING_FRAMES) {
            let calls = 0;
            RECORDING.frames.forEach(frame_calls => {
               calls += frame_calls.length;
            });
            if (!calls) {
               console.log(`[LogCanvas@${window.origin}]`,
                           `Recording ended with 0 calls.`);
               return;
            }
            console.log(`[LogCanvas@${window.origin}]`,
                        `${RECORDING.frames.length}/${n} frames recorded!`,
                        `(${to_suffixed(calls)} calls)`);
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

   function stop() {
      RECORDING_FRAMES = 0;
      console.log(`[LogCanvas@${window.origin}] Stopping...`);
   }

   return {
      inject_observer: inject_observer,
      record_frames: record_frames,
      record_next_frames: record_next_frames,
      download: download,
      stop: stop,
   };
})();

LogCanvas.inject_observer();
