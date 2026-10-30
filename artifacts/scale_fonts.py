import re
from pathlib import Path
p=Path('src/styles.css')
s=p.read_text(encoding='utf-8').replace(r'\n', '\n')
s=re.sub(r'font-size:\s*([0-9.]+px)', r'font-size: calc(\1 * var(--font-scale, 1))', s)
s=re.sub(r'font:(\s*(?:(?:bold|normal|[0-9]{3})\s+)*)([0-9.]+px)(\s+[^;{}]+)', r'font:\1calc(\2 * var(--font-scale, 1))\3', s)
p.write_text(s,encoding='utf-8')
print('scaled font declarations',s.count('var(--font-scale, 1)'))
