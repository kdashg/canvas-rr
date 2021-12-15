'use strict';

const RECORDING_VERSION = 2;

function split_once(str, delim) {
   const [left] = str.split(delim, 1);
   const right = str.slice(left.length + delim.length);
   return [left, right];
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

               let [type, data] = split_once(str, ':');
               if (type == 'Object') {
                  return JSON.parse(data);
               }

               if (data[0] == '*') {
                  data = parseInt(data.slice(1));
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

               const ctor = window[type];
               return new ctor(data);
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
      if (frame_id >= this.frames.length) return;
      this.play_calls(element_map, frame_id, call_id, end[1]);
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

   play_call(element_map, frame_id, call_id) {
      const call = this.frames[frame_id][call_id];
      const [elem_key, func_name, args, ret] = call;
      //console.log(call);

      let obj = window;
      if (elem_key) {
         obj = element_map[elem_key];
         if (!obj) throw new Error("Missing elem_key: " + elem_key);
      }

      const call_args = args.map(x => {
         if (typeof x != 'string') return x;
         const initial = x[0];
         if (initial == '"') return x.substring(1);
         if (initial == '@') {
            const ret = this.snapshots[x];
            if (!ret) new Error("Missing snapshot: " + x);
            return ret;
         }
         if (initial == '$') {
            const ret = element_map[x];
            if (!ret) new Error("Missing elem_key: " + x);
            return ret;
         }
         throw new Error(`[${frame_id},${call_id} ${func_name}] Bad arg "${x}"`);
      });

      if (func_name.startsWith('set ')) {
         const setter_name = func_name.substring(4);
         obj[setter_name] = call_args[0];
         if (window._CRR_REPLAY_SPEW) {
            console.log(`${obj}.${setter_name} = ${call_args[0]}`);
         }
         return;
      }

      if (func_name.startsWith('new ')) {
         const class_name = func_name.substring(4);
         if (window._CRR_REPLAY_SPEW) {
            console.log(`${ret} = new ${class_name}(`, ...call_args, `)`);
         }
         const func = window[class_name];
         const call_ret = new func(...call_args);
         console.assert(ret[0] == '$');
         element_map[ret] = call_ret;
         return call_ret;
      }
      const func = obj[func_name];
      if (!func) {
         console.log("Warning: Missing func: " + obj.constructor.name + '.' + func_name);
         return;
      }
      if (window._CRR_REPLAY_SPEW) {
         let pre = '';
         if (ret) {
            pre = `${ret} = `;
         }
         console.log(`${pre}${obj}.${func_name}(`, ...call_args, `)`);
      }
      const call_ret = func.apply(obj, call_args);
      if (ret && typeof ret == 'string') {
         if (ret[0] == '$') {
            element_map[ret] = call_ret;
         }
      }
      return call_ret;
   }
}
