"""Reproducible image fixtures; no external image service is needed at runtime."""
from pathlib import Path
from PIL import Image, ImageDraw

directory = Path(__file__).parent / 'images'
directory.mkdir(exist_ok=True)
for index in range(12):
    image = Image.new('RGB', (480, 360), (244, 239 - index * 3, 228 + index))
    draw = ImageDraw.Draw(image)
    accent = [(41, 100, 83), (227, 139, 60), (82, 108, 154), (174, 70, 75)][index % 4]
    draw.ellipse((85, 260, 395, 325), fill=(209, 209, 195))
    if index % 3 == 0:
        draw.rounded_rectangle((155, 70, 300, 295), 30, fill=accent)
        draw.rounded_rectangle((145, 55, 310, 90), 12, fill=(40, 45, 46))
        draw.rectangle((165, 120, 290, 135), fill=(230, 227, 217))
    elif index % 3 == 1:
        draw.rounded_rectangle((115, 90, 340, 290), 48, fill=accent)
        draw.arc((160, 40, 295, 145), 180, 360, fill=accent, width=18)
        draw.rounded_rectangle((150, 185, 305, 275), 25, fill=(237, 210, 159))
    else:
        draw.rounded_rectangle((80, 120, 390, 285), 20, fill=accent)
        draw.rounded_rectangle((70, 100, 400, 140), 15, fill=(218, 181, 128))
        draw.rounded_rectangle((195, 175, 280, 205), 8, fill=(241, 234, 209))
    draw.text((26, 24), f'CITY LAB / {index + 1:02d}', fill=(52, 61, 60), font_size=22)
    image.save(directory / f'product-{index}.png', optimize=True)
