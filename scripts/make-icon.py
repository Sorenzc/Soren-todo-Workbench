# 生成打包用的 .ico：蓝色圆角方块 + 白色勾，16/32/48/64/128/256 多尺寸
import sys
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else "build/app.ico"
SIZE = 256
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角底：iOS 风格蓝，留 6px 外边距
pad, radius = 8, 56
d.rounded_rectangle([pad, pad, SIZE - pad, SIZE - pad], radius=radius, fill=(37, 99, 235, 255))

# 勾：两段粗线 + 圆头
w = 26
d.line([(76, 132), (116, 172)], fill=(255, 255, 255, 255), width=w, joint="curve")
d.line([(116, 172), (182, 92)], fill=(255, 255, 255, 255), width=w, joint="curve")
for cx, cy in ((76, 132), (116, 172), (182, 92)):
    d.ellipse([cx - w // 2, cy - w // 2, cx + w // 2, cy + w // 2], fill=(255, 255, 255, 255))

img.save(OUT, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icon ->", OUT)
