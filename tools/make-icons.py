#!/usr/bin/env python3
"""Make the PNG icons (iPad/iPhone home screen, installed app) from icons/icon.svg. Needs rsvg-convert (librsvg).
Run after changing icons/icon.svg, then run tools/build.py.
  icon-180.png           apple-touch-icon: full square (iOS rounds the corners itself)
  icon-192.png, icon-512.png   the rounded icon, for the web app manifest
  icon-maskable-512.png  full square with the artwork inside the central 80% (Android crops it to its own shape)"""
import os, re, subprocess, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
svg = open(os.path.join(root, 'icons/icon.svg')).read()
inner = re.search(r'<svg[^>]*>(.*)</svg>', svg, re.S).group(1)
body = re.sub(r'<rect width="64" height="64" rx="14" fill="(#[0-9a-fA-F]+)"/>', '', inner, count=1)   # the background tile; the rest is the artwork
bg = re.search(r'<rect width="64" height="64" rx="14" fill="(#[0-9a-fA-F]+)"/>', inner).group(1)
def wrap(content, rx):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="{rx}" fill="{bg}"/>{content}</svg>'
def png(name, markup, size):
    p = subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size), '-o', os.path.join(root, 'icons', name)], input=markup.encode())
    if p.returncode: sys.exit('rsvg-convert failed for ' + name)
png('icon-180.png', wrap(body, 0), 180)
png('icon-192.png', wrap(body, 14), 192)
png('icon-512.png', wrap(body, 14), 512)
png('icon-maskable-512.png', wrap(f'<g transform="translate(6.4 6.4) scale(.8)">{body}</g>', 0), 512)
print('icons written')
