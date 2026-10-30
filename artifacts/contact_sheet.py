from PIL import Image, ImageDraw
from pathlib import Path
pages=sorted(Path('artifacts/integration-guide-render-v5').glob('page-*.png'))
thumbs=[]
for f in pages:
    im=Image.open(f).convert('RGB'); im.thumbnail((425,550))
    canvas=Image.new('RGB',(445,585),'#d9dfdc')
    canvas.paste(im,((445-im.width)//2,12))
    ImageDraw.Draw(canvas).text((12,560),f.stem,fill='#173f37')
    thumbs.append(canvas)
out=Image.new('RGB',(890,585*((len(thumbs)+1)//2)),'white')
for i,im in enumerate(thumbs): out.paste(im,((i%2)*445,(i//2)*585))
out.save('artifacts/integration-guide-render-v5/contact.png')
