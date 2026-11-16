import sys
from PIL import Image, ImageChops, ImageDraw
a = Image.open(sys.argv[1]).convert('RGB'); b = Image.open(sys.argv[2]).convert('RGB')
if a.size != b.size:
    print('size'); sys.exit()
for im in (a, b):
    ImageDraw.Draw(im).rectangle([a.size[0] - 260, 0, a.size[0], 110], fill=(0, 0, 0))
box = ImageChops.difference(a, b).getbbox()
print('same' if box is None else f'differs {box}')
