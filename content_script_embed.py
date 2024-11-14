#! /usr/bin/env python3

def to_js_string(src):
   src = src.replace(b'\\', b'\\\\')
   src = src.replace(b'`', b'\\`')
   src = src.replace(b'$', b'\\$')
   src = b'`' + src + b'`'
   return src


def from_script(src):
   src = to_js_string(src)

   dest = [b'''\
(() => {
   if (!(document instanceof HTMLDocument)) return;
   console.log('[canvas-rr] Injecting rr-record.js inline...');

   // -

   const blob = new self.Blob([escaped_file()], // Move this big string to the end.
                              { type: 'text/javascript' });
   const url = self.URL.createObjectURL(blob);
   let script = document.createElement('script');
   script.src = url;
   script.async = false;

   document.documentElement.append(script);

   // -

   function escaped_file() {
      return ''', src, b''';
   }
})();
   ''']
   return b''.join(dest)


if __name__ == '__main__':
   import sys

   src = sys.stdin.buffer.read()
   dest = from_script(src)
   sys.stdout.buffer.write(dest)

   exit(0)
