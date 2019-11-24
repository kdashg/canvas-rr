'use strict';

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

      const decode_proms = [];
      for (const k in ret.snapshots) {
         const v = ret.snapshots[k];
         const elem = document.createElement('img');
         elem.src = v;
         decode_proms.push(elem.decode());
         ret.snapshots[k] = elem;
      }
      await Promise.all(decode_proms);

      return ret;
   }

   make_elems() {
      const elem_map = {};
      for (const k in this.elem_info_by_key) {
         const info = this.elem_info_by_key[k];
         if (info.type == 'HTMLCanvasElement') {
            const elem = document.createElement('canvas');
            elem.width = info.width;
            elem.height = info.height;
            elem_map[k] = elem;
            continue;
         }
         console.log('Warning: Unrecognized elem_info_by_key[k].type:', info.type);
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
      this.play_calls(element_map, frame_id, call_id, end[1]);
   }

   play_calls(element_map, frame_id, call_begin, call_end) {
      console.log(`play_calls(${[].slice.call(arguments)})`);
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
         console.log(`${obj}.${setter_name} = ${call_args[0]}`);
         return;
      }
      const func = obj[func_name];
      if (!func) {
         console.log("Warning: Missing func: " + obj.constructor.name + '.' + func_name);
         return;
      }
      console.log(`${obj}.${func_name}(${call_args})`);
      const call_ret = func.apply(obj, call_args);
      if (ret && typeof ret == 'string') {
         if (ret[0] == '$') {
            element_map[ret] = call_ret;
         }
      }
      return call_ret;
   }
}
