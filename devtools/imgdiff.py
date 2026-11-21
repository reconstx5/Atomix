import sys
from PIL import Image, ImageChops, ImageDraw
a = Image.open(sys.argv[1]).convert('RGB'); b = Image.open(sys.argv[2]).convert('RGB')
if a.size != b.size:
    print('size'); sys.exit()
for im in (a, b):
    ImageDraw.Draw(im).rectangle([a.size[0] - 260, 0, a.size[0], 110], fill=(0, 0, 0))
import os
tol = int(os.environ.get('TOLERANCE', '0'))  # a channel off by no more than this still counts as the same (a blurred backdrop can be 1 off)
d = ImageChops.difference(a, b)
if tol: d = d.point(lambda v: 255 if v > tol else 0)
box = d.getbbox()
print('same' if box is None else f'differs {box}')
