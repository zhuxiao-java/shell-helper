"""生成应用图标: apps/desktop/build/icon.png (1024x1024, 透明背景)。

electron-builder 会依据 buildResources(build/) 下的 icon.png 自动产出
macOS 的 .icns 与 Windows 的 .ico，无需额外配置。

用法: .venv/bin/python scripts/make_icon.py
依赖: pillow (仅生成素材时使用，非运行时依赖)
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "apps" / "desktop" / "build" / "icon.png"

S = 4                      # 4x 超采样后缩放，保证边缘平滑
N = 1024 * S
RADIUS = int(1024 * 0.2237 * S)   # 类 macOS squircle 圆角比例
TOP = (52, 62, 86)         # 瓷砖渐变上沿: 深板岩蓝
BOTTOM = (15, 18, 24)      # 瓷砖渐变下沿: 石墨黑
GREEN = (62, 222, 130)     # 终端前景: 明亮翠绿
TEAL = (72, 200, 220)      # 连接点缀: 青色


def u(v: int) -> int:
    """把 1024 设计坐标换算为超采样坐标。"""
    return v * S


def tile_mask() -> Image.Image:
    mask = Image.new("L", (N, N), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([0, 0, N - 1, N - 1], radius=RADIUS, fill=255)
    return mask


def gradient_tile() -> Image.Image:
    grad = Image.new("RGB", (1, N))
    for y in range(N):
        t = y / (N - 1)
        # 轻微缓动，让下半部分更暗更沉稳
        t = t ** 1.25
        grad.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    img.paste(grad.resize((N, N)), (0, 0), tile_mask())
    return img


def add_inner_glow(img: Image.Image) -> None:
    """顶部柔和光晕，避免纯色块显得平淡。"""
    glow = Image.new("L", (N, N), 0)
    draw = ImageDraw.Draw(glow)
    draw.ellipse([u(-260), u(-620), u(1284), u(430)], fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(u(160)))
    light = Image.new("RGBA", (N, N), (255, 255, 255, 0))
    light.putalpha(glow)
    img.alpha_composite(Image.composite(light, Image.new("RGBA", light.size, (0, 0, 0, 0)), tile_mask()))


def add_border(img: Image.Image) -> None:
    """1.5px 极淡内描边，模拟玻璃切面。"""
    edge = Image.new("L", (N, N), 0)
    draw = ImageDraw.Draw(edge)
    w = max(2, int(1.5 * S))
    draw.rounded_rectangle([w // 2, w // 2, N - 1 - w // 2, N - 1 - w // 2],
                           radius=RADIUS - w, outline=255, width=w)
    alpha = edge.point(lambda v: int(v * 0.22))
    outline = Image.new("RGBA", (N, N), (255, 255, 255, 0))
    outline.putalpha(alpha)
    img.alpha_composite(outline)


def prompt_glyphs(layer: Image.Image, blur: int, color, width: int, alpha: int) -> None:
    """在指定层绘制 '>' 形折线与光标块。"""
    draw = ImageDraw.Draw(layer)
    line = (color[0], color[1], color[2], alpha)
    points = [(u(292), u(318)), (u(492), u(512)), (u(292), u(706))]
    draw.line(points, fill=line, width=width, joint="curve")
    for x, y in points:
        draw.ellipse([x - width // 2, y - width // 2, x + width // 2, y + width // 2], fill=line)
    draw.rounded_rectangle([u(560), u(444), u(764), u(580)], radius=u(18), fill=line)
    if blur:
        layer = layer.filter(ImageFilter.GaussianBlur(blur))
    return layer


def add_prompt(img: Image.Image) -> None:
    glow = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    sharp = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    img.alpha_composite(prompt_glyphs(glow, u(26), GREEN, int(96 * S), 120))
    img.alpha_composite(prompt_glyphs(sharp, 0, GREEN, int(96 * S), 255))


def add_link(img: Image.Image) -> None:
    """右上角两个节点 + 斜向连线，暗示远程 SSH 连接。"""
    layer = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    a, b = (u(700), u(236)), (u(810), u(346))
    dashed = [(u(x), u(y)) for x, y in [(700, 236), (736, 272), (772, 308), (810, 346)]]
    for (x1, y1), (x2, y2) in zip(dashed, dashed[1:]):
        draw.line([(x1, y1), (x2, y2)], fill=(72, 200, 220, 110), width=max(2, int(10 * S)))
    for (x, y), r in [(a, u(34)), (b, u(26))]:
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(72, 200, 220, 150))
    img.alpha_composite(Image.composite(
        layer.filter(ImageFilter.GaussianBlur(int(2 * S))),
        Image.new("RGBA", layer.size, (0, 0, 0, 0)), tile_mask()))


def main() -> None:
    img = gradient_tile()
    add_inner_glow(img)
    add_border(img)
    add_link(img)
    add_prompt(img)
    icon = img.resize((1024, 1024), Image.LANCZOS)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    icon.save(OUTPUT)
    print(f"图标已生成: {OUTPUT} ({icon.width}x{icon.height} {icon.mode})")


if __name__ == "__main__":
    main()
