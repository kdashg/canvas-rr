#! /usr/bin/env python3

import content_script_embed

import os
import pathlib
import shutil

DIR = pathlib.Path(__file__).parent
OUT = DIR / 'out'

def write_to(dest, data):
  print(f'   ({len(data)} bytes) => {dest}')
  dest.write_bytes(data)


def clean():
  print('[clean]')

  if OUT.exists():
    shutil.rmtree(OUT)

  os.mkdir(OUT)


def build_content_script(src, dest):
  print(f'[build_content_script {src}]')

  data = src.read_bytes()
  data = content_script_embed.from_script(data)
  write_to(dest, data)

# -

clean();
build_content_script(DIR / 'rr-record.js', OUT / 'rr-record.content.js')
print('Build complete.')
