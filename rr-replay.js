'use strict';

const RECORDING_VERSION = 5;
const BAKE_AND_REHEAT_CALLS = false;
const BAKE_ASSUME_OBJ_FUNC_LOOKUP_IMMUTABLE = true;
const DEDUPE_STRINGS = true;
const DEDUPE_CALLS = true;

let SPEW_ON_GL_ERROR;
//SPEW_ON_GL_ERROR = true;
//SPEW_ON_GL_ERROR = ['bufferSubData'];

// -

function split_once(str, delim) {
   const [left] = str.split(delim, 1);
   const right = str.slice(left.length + delim.length);
   return [left, right];
}

/// Prefer `invoke(() => { ... })` to `(() => { ... })()`
/// This way, it's clear up-front that we're calling not just defining.
function invoke(fn) {
    return fn();
}

const Base64 = {
   encode: dec_ab => {
      const dec_u8a = new Uint8Array(dec_ab);
      const dec_bstr = String.fromCodePoint(...dec_u8a);
      const enc = btoa(dec_bstr);
      return enc;
   },
   decode: enc => {
      const dec_bstr = atob(enc);
      const dec_u8a = new Uint8Array([].map.call(dec_bstr, x => x.codePointAt(0)));
      return dec_u8a.buffer;
   },
};

function from_data_snapshot(str) {
   let [type, data] = split_once(str, ':');
   if (type == 'Object') {
      return JSON.parse(data);
   }

   try {
      if (data[0] == '*') {
         data = parseInt(data.slice(1));
      } else if (data[0] == '^') {
         data = Base64.decode(data.slice(1));
      } else {
         data = JSON.parse('[' + data + ']');
      }
   } catch (e) {
      console.error('Unexpected', e, 'while parsing data:', data);
      throw e;
   }

   if (type === 'ArrayBuffer') {
      const typed = new Uint8Array(data);
      return typed.buffer;
   }
   if (type === 'DataView') {
      const typed = new Uint8Array(data);
      return new DataView(typed.buffer);
   }

   // Assume e.g. Uint8Array
   const ctor = window[type];
   return new ctor(data);
}

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

class Recording {
   // String prefixes:
   // @: snapshot key
   // $: element key
   // ": actual string
   snapshots = {};
   elem_info_by_key = [];
   frames = [];

   static async from_json(json) {
      const ret = Object.assign(new Recording(), json);
      ret.version = json.version;
      if (ret.version != RECORDING_VERSION) {
         console.error(`Warning: Recording has version:${ret.version}, but decoder has version ${RECORDING_VERSION}!`);
      }

      const decode_proms = [];
      for (const k in ret.snapshots) {
         decode_proms.push( (async () => {
            const str = ret.snapshots[k].join('');
            const obj = await (async () => {
               if (str.startsWith('data:')) {
                  const elem = document.createElement('img');
                  elem.src = str;
                  try {
                     await elem.decode();
                  } catch (e) {
                     console.error('Failed to load:', elem, 'str:', str);
                     //throw e;
                  }
                  return elem;
               }

               return from_data_snapshot(str);
            })();
            ret.snapshots[k] = obj;
         })() );
      }
      await Promise.all(decode_proms);

      if (DEDUPE_STRINGS) {
         // Previously, in about:memory for an 800MB Aquarium recording:
         // > 124.27 MB (02.64%) - string(length=9, copies=5429600, "uniform1f")/gc-heap/latin1
         // > 123.57 MB (02.63%) - string(length=10, copies=5398791, "uniform3fv")/gc-heap/latin1
         // >  62.12 MB (01.32%) - string(length=12, copies=2714163, "drawElements")/gc-heap/latin1
         // >  61.15 MB (01.30%) - string(length=4, copies=2671851, "$431")/gc-heap/latin1
         // >  61.15 MB (01.30%) - string(length=4, copies=2671851, "$433")/gc-heap/latin1
         // >  61.15 MB (01.30%) - string(length=4, copies=2671851, "$435")/gc-heap/latin1
         // >  61.15 MB (01.30%) - string(length=4, copies=2671851, "$437")/gc-heap/latin1
         // 124MB / 5.4M is just under(?) 23 bytes, we just have a ton
         // of them.
         // I'm sure the data locality is just great, too!
         const dedupe_map = {};
         let before_count = 0;
         function dedupe(val) {
            if (typeof val == 'string') {
               before_count += 1;
               return dedupe_map[val] || (dedupe_map[val] = val);
            }
            return val;
         }
         for (const frame of ret.frames) {
            for (const call of frame) {
               //const [elem_key, func_name, args, ret] = call;
               call[0] = dedupe(call[0]);
               call[1] = dedupe(call[1]);
               const args = call[2];
               for (const i in args) {
                  args[i] = dedupe(args[i]);
               }
               call[3] = dedupe(call[3]);
            }
         }
         const after_count = Object.keys(dedupe_map).length;
         console.log(`Deduped ${to_suffixed(before_count)} strings`,
                     `down to ${to_suffixed(after_count)}.`);
      }

      if (DEDUPE_CALLS) {
         let before_count = 0;
         const dedupe_map = {};
         // We probably want to prune the map of one-offs, so that we
         // don't need to store every call in the map. (oom hazard)
         // But for recordings >1000 frames, it would be ideal to dedupe
         // once-per-frame calls.
         for (const frame of ret.frames) {
            for (const call_i in frame) {
               before_count += 1;
               const call = frame[call_i];
               const json = JSON.stringify(call);
               frame[call_i] = dedupe_map[json] || (dedupe_map[json] = call);
            }
         }
         const after_count = Object.keys(dedupe_map).length;
         console.log(`Deduped ${to_suffixed(before_count)} calls`,
                     `down to ${to_suffixed(after_count)}.`);
      }

      return ret;
   }

   make_elems() {
      const elem_map = {};

      const outer = this;

      function make_elem(k) {
         let elem = elem_map[k];
         if (elem !== undefined) return elem;

         const info = outer.elem_info_by_key[k];
         if (info.type == 'HTMLCanvasElement') {
            elem = document.createElement('canvas');
            elem.width = info.width;
            elem.height = info.height;
         } else if (info.type == 'OffscreenCanvas') {
            elem = new OffscreenCanvas(1,1);
            elem.width = info.width;
            elem.height = info.height;
         } else if (info.type == 'CanvasRenderingContext2D') {
            if (info.canvas) {
               const c = make_elem(info.canvas);
               elem = c.getContext('2d');
            }
         } else if (info.type == 'CanvasRenderingContextGL2D') {
            if (info.canvas) {
               const c = make_elem(info.canvas);
               elem = c.getContext('gl-2d');
            }
         } else {
            console.log('Warning: Unrecognized elem_info_by_key[k].type:', info.type);
         }
         return elem_map[k] = elem;
      }

      for (const k in this.elem_info_by_key) {
         make_elem(k);
      }
      return elem_map;
   }

   play(element_map, begin, end) {
      if (!begin.length) {
         begin = [begin, 0];
      }
      end = end || Infinity;
      if (!end.length) {
         end = [end, 0];
      }

      let frame_id = begin[0];
      let call_id = begin[1];
      for (; frame_id < end[0]; ++frame_id) {
         if (frame_id >= this.frames.length) return;
         this.play_calls(element_map, frame_id, call_id);
         call_id = 0;
      }
   }

   play_calls(element_map, frame_id, call_begin, call_end) {
      //console.log(`play_calls(${[].slice.call(arguments)})`);
      call_end = call_end || Infinity;
      const frame = this.frames[frame_id];
      for (let i = call_begin; i < call_end; ++i) {
         if (i >= frame.length) return;
         this.play_call(element_map, frame_id, i);
      }
   }

   play_call(element_map_mut, frame_id, call_id) {
      const call = this.frames[frame_id][call_id];
      const [elem_key, func_name, args, ret] = call;
      //console.log(call);
      if (func_name == 'throw') throw {frame_id, call_id, call};

      // `call` is fixed. as is `this.snapshots`.
      // `element_map` is mutable though!
      // Mutable vars are suffixed with _mut, and should not be used
      // during baking, because they might be different at reheat time.

      // Replaying of baked calls must be based on the *this*
      // play_call's `element_map`, not whatever was in `element_map`
      // when it was baked!

      let obj_mut = window;
      if (elem_key) {
         obj_mut = element_map_mut[elem_key];
         if (!obj_mut) throw new Error("Missing elem_key: " + elem_key);
      }

      // `call._is_baked || invoke(...` means that we won't bother to
      // even define these functions when we know they're closure'd into
      // the baked call.
      const reheat_call_args = call._is_baked || invoke(() => { // Bake first
         const fix_ups = [];
         const baked_call_args = args.map((x,i) => {
            if (typeof x != 'string') return x;
            const initial = x[0];
            if (initial == '"') return x.substring(1);
            if (initial == '=') return from_data_snapshot(x.substring(1));
            if (initial == '@') {
               const ret = this.snapshots[x];
               if (!ret) new Error("Missing snapshot: " + x);
               return ret;
            }
            if (initial == '$') {
               const fix_up = (baked_call_args, element_map) => {
                  const ret = element_map[x];
                  if (!ret) new Error("Missing elem_key: " + x);
                  baked_call_args[i] = ret;
               };
               fix_ups.push(fix_up);
               return '<unbaked>';
            }
            throw new Error(`[${frame_id},${call_id} ${func_name}] Bad arg "${x}"`);
         });
         return (element_map) => { // Then reheat
            for (const f of fix_ups) {
               f(baked_call_args, element_map);
            }
            return baked_call_args;
         };
      });

      // -

      const reheat_call = call._reheat_call || invoke(() => { // Bake
         if (func_name.startsWith('set ')) {
            const setter_name = func_name.substring(4);
            return (element_map, obj) => { // Reheat `set `
               const call_args = reheat_call_args(element_map);

               obj[setter_name] = call_args[0];
               if (window._CRR_REPLAY_SPEW) {
                  console.log(`${obj}.${setter_name} = ${call_args[0]}`);
               }
            };
         }

         if (func_name.startsWith('new ')) {
            const class_name = func_name.substring(4);
            const func = window[class_name];
            return (element_map, obj) => { // Reheat `new `
               const call_args = reheat_call_args(element_map);

               if (window._CRR_REPLAY_SPEW) {
                  console.log(`${ret} = new ${class_name}(`, ...call_args, `)`);
               }
               const call_ret = new func(...call_args);
               console.assert(ret[0] == '$');
               element_map[ret] = call_ret;
               return call_ret;
            };
         }

         // -
         // Actual member function calls!

         function enum_from_val(v, obj) {
            obj = obj || WebGL2RenderingContext;
            for (const [k,cur_v] of Object.entries(WebGLRenderingContext)) {
               if (v == cur_v) {
                  return k;
               }
            }
            return `0x${v.toString(16)}`;
         }

         function check_error(when_str, obj, call_args) {
            if (!SPEW_ON_GL_ERROR) return;
            if (!obj.getError) return;
            if (SPEW_ON_GL_ERROR.includes && !SPEW_ON_GL_ERROR.includes(func_name)) {
               return;
            }
            const err = obj.getError();
            if (!err) return;

            const str = enum_from_val(err);
            console.log(`[SPEW_ON_GL_ERROR] getError() -> ${str}`);
            console.error(`[SPEW_ON_GL_ERROR] ...${when_str} `,
               {frame_id, call_id, ret, obj, func_name, call_args});
         }

         const func_mut = obj_mut[func_name];
         let baked_func;
         if (BAKE_ASSUME_OBJ_FUNC_LOOKUP_IMMUTABLE) {
            // Assume that obj
            baked_func = func_mut;
         }

         const replay_spew = window._CRR_REPLAY_SPEW;

         return (element_map, obj, frame_id, call_id) => { // Reheat an actual call!
            const call_args = reheat_call_args(element_map);
            const func = baked_func || obj[func_name];
            if (!func) {
               console.log("Warning: Missing func: " + obj.constructor.name + '.' + func_name);
               return;
            }


            if (replay_spew) {
               console.log(`${ret || '()'} = ${obj}.${func_name}(`, ...call_args, `)`);
            }

            if (SPEW_ON_GL_ERROR) {
               check_error('before', obj, call_args);
            }

            const call_ret = func.apply(obj, call_args);
            if (ret && typeof ret == 'string') {
               if (ret[0] == '$') {
                  element_map[ret] = call_ret;
               }
            }
            if (ret && typeof ret == 'number') {
               if (call_ret != ret) {
                  console.error(
                     `[${+frame_id+1}:${+call_id+1}]` +
                     ` ${obj}.${func_name}(${call_args.join(', ')})` +
                     ` -> ${call_ret}, expected ${ret}!`);
               }
            }
            if (SPEW_ON_GL_ERROR) {
               check_error('after', obj, call_args);
            }

            return call_ret;
         };
      });
      if (BAKE_AND_REHEAT_CALLS && !call._is_baked) {
         call._reheat_call = reheat_call;
         call._is_baked = true;
      }

      return reheat_call(element_map_mut, obj_mut, frame_id, call_id);
   }
}
