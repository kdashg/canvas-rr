'use strict';

const RECORDING_VERSION = 4;
let SPEW_ON_GL_ERROR;
const BAKE_AND_REHEAT_CALLS = false;
const BAKE_ASSUME_OBJ_FUNC_LOOKUP_IMMUTABLE = true;
//SPEW_ON_GL_ERROR = true;
//SPEW_ON_GL_ERROR = ['bufferSubData'];

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

   if (data[0] == '*') {
      data = parseInt(data.slice(1));
   } else if (data[0] == '^') {
      data = Base64.decode(data.slice(1));
   } else {
      data = JSON.parse('[' + data + ']');
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

   play_call(_element_map, frame_id, call_id) {
      const call = this.frames[frame_id][call_id];
      const [elem_key, func_name, args, ret] = call;
      //console.log(call);

      // `call` is fixed. as is `this.snapshots`.
      // `element_map` is mutable though!
      // Replaying of baked calls must be based on the *this*
      // play_call's `element_map`, not whatever was in `element_map`
      // when it was baked!

      // `call._is_baked || invoke(...` maens that we won't bother to
      // even define these functions when we know they're closure'd into
      // the baked call.
      const reheat_obj = call._is_baked || invoke(() => { // Bake
         // Probably not worth baking out this branch.
         return (element_map) => { // Reheat
            let obj = window;
            if (elem_key) {
               obj = element_map[elem_key];
               if (!obj) throw new Error("Missing elem_key: " + elem_key);
            }
            return obj;
         };
      });

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
            return (element_map) => { // Reheat `set `
               const obj = reheat_obj(element_map);
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
            return (element_map) => { // Reheat `new `
               const obj = reheat_obj(element_map);
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

         let func;
         if (BAKE_ASSUME_OBJ_FUNC_LOOKUP_IMMUTABLE) {
            // We're not supposed to have `obj` during bake
            const obj = reheat_obj(_element_map);
            func = obj[func_name];
         }

         return (element_map) => { // Reheat `obj.func_name(...)`
            const obj = reheat_obj(element_map);
            const call_args = reheat_call_args(element_map);
            if (!func) {
               func = obj[func_name];
               if (!func) {
                  console.log("Warning: Missing func: " + obj.constructor.name + '.' + func_name);
                  return;
               }
            }

            if (window._CRR_REPLAY_SPEW) {
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

      return reheat_call(_element_map);
   }
}
