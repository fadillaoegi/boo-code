"""
Merender logo Boo menjadi ANSI half-block dan menuliskannya sebagai konstanta
TypeScript di packages/cli/src/logo.ts.

Dijalankan manual saat logo berubah:
    python3 scripts/gen-logo.py

Hasilnya ditanam sebagai string agar CLI tidak butuh decoder PNG saat runtime.
Butuh Pillow: pip install pillow
"""
from pathlib import Path
from PIL import Image, ImageEnhance

SRC = Path('/Users/boo/Github/project/web/boo-ai-chat-web/src/assets/logoBooAgent.png')
OUT = Path(__file__).resolve().parent.parent / 'packages/cli/src/logo.ts'

ROWS = 6
# Kotak kepala panda; badan dan teks "BOO" dibuang karena banner sudah menulisnya.
CROP = (0.20, 0.06, 0.80, 0.52)
ALPHA_THRESHOLD = 12
# Pada 13x12 piksel yang membuat panda terbaca adalah kontras wajah putih
# terhadap lingkar mata hitam, bukan siluetnya. Mengangkat nada gelap agar
# terlihat di latar gelap justru meratakan kontras itu dan hasilnya jadi bubur,
# jadi warna dibiarkan apa adanya dan kontrasnya dinaikkan sedikit. Telinga
# hitam memang menyatu dengan latar terminal, dan itu terlihat disengaja.
CONTRAST = 1.5


def load() -> Image.Image:
    image = Image.open(SRC).convert('RGBA')
    width, height = image.size
    x0, y0, x1, y1 = CROP
    image = image.crop((int(width * x0), int(height * y0), int(width * x1), int(height * y1)))
    pixel_height = ROWS * 2
    pixel_width = max(1, round(image.width / image.height * pixel_height))
    image = image.resize((pixel_width, pixel_height), Image.LANCZOS)
    alpha = image.split()[3]
    boosted = ImageEnhance.Contrast(image.convert('RGB')).enhance(CONTRAST)
    return Image.merge('RGBA', (*boosted.split(), alpha))


def render(image: Image.Image) -> list[str]:
    pixels = image.load()
    lines = []
    for row in range(ROWS):
        parts = []
        for x in range(image.width):
            tr, tg, tb, ta = pixels[x, row * 2]
            br, bg, bb, ba = pixels[x, row * 2 + 1]
            top, bottom = ta > ALPHA_THRESHOLD, ba > ALPHA_THRESHOLD
            fg = f'\\u001b[38;2;{tr};{tg};{tb}m'
            bg_ = f'\\u001b[48;2;{br};{bg};{bb}m'
            if not top and not bottom:
                parts.append(' ')
            elif top and bottom:
                parts.append(f'{fg}{bg_}\u2580\\u001b[0m')
            elif top:
                parts.append(f'{fg}\u2580\\u001b[0m')
            else:
                parts.append(f'\\u001b[38;2;{br};{bg};{bb}m\u2584\\u001b[0m')
        lines.append(''.join(parts))
    return lines


def main() -> None:
    lines = render(load())
    width = load().width
    body = ''.join(f"  '{line}',\n" for line in lines)
    OUT.write_text(
        '/**\n'
        ' * DIGENERATE OTOMATIS oleh scripts/gen-logo.py — jangan diedit manual.\n'
        ' *\n'
        ' * Logo Boo sebagai ANSI half-block: satu karakter memuat dua piksel\n'
        ' * (atas lewat warna depan, bawah lewat warna latar), sehingga resolusi\n'
        ' * vertikalnya dua kali lipat. Ditanam sebagai string agar CLI tidak\n'
        ' * memerlukan decoder PNG saat runtime.\n'
        ' *\n'
        ' * Telinga hitam menyatu dengan latar terminal gelap; yang membuat panda\n'
        ' * terbaca adalah kontras wajah putih terhadap lingkar mata.\n'
        ' */\n\n'
        f'/** Lebar logo dalam kolom terminal. */\nexport const LOGO_COLUMNS = {width}\n\n'
        f'export const LOGO_ROWS: readonly string[] = [\n{body}]\n'
    )
    print(f'[boo-logo] {OUT} — {ROWS} baris x {width} kolom')


if __name__ == '__main__':
    main()
