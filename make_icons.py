#!/usr/bin/env python3
"""アプリアイコン(icon-192.png / icon-512.png)を外部ライブラリなしで生成する。

Pillow等を入れずに済ませるため、図形をベタで塗ってzlibでPNGに固める。
デザイン: 紺(#1B4F72)地に白のカート、車輪だけアクセント色(#D4573B)。
"""
import math
import struct
import zlib

NAVY = (0x1B, 0x4F, 0x72)
ACCENT = (0xD4, 0x57, 0x3B)
WHITE = (0xFF, 0xFF, 0xFF)

SS = 4  # スーパーサンプリング倍率（アンチエイリアス用）


def seg_dist(px, py, ax, ay, bx, by):
    """点(px,py)と線分ab の距離。"""
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy)


# カートの形（0..1の正規化座標）
HALF = 0.030                     # 線の太さの半分
BASKET = [                       # かご: 上辺 → 右辺 → 下辺 → 左辺
    (0.335, 0.395), (0.790, 0.395),
    (0.790, 0.395), (0.715, 0.605),
    (0.715, 0.605), (0.430, 0.605),
    (0.430, 0.605), (0.335, 0.395),
]
HANDLE = [                       # 取っ手: 左上から かご左上へ
    (0.200, 0.290), (0.290, 0.290),
    (0.290, 0.290), (0.335, 0.395),
]
WHEELS = [(0.470, 0.735), (0.690, 0.735)]
WHEEL_R = 0.052


def cart_coverage(x, y):
    """カート本体(白)の被覆量 0/1 を返す。"""
    d = 1e9
    for i in range(0, len(BASKET), 2):
        ax, ay = BASKET[i]
        bx, by = BASKET[i + 1]
        d = min(d, seg_dist(x, y, ax, ay, bx, by))
    for i in range(0, len(HANDLE), 2):
        ax, ay = HANDLE[i]
        bx, by = HANDLE[i + 1]
        d = min(d, seg_dist(x, y, ax, ay, bx, by))
    return 1.0 if d <= HALF else 0.0


def wheel_coverage(x, y):
    for cx, cy in WHEELS:
        if math.hypot(x - cx, y - cy) <= WHEEL_R:
            return 1.0
    return 0.0


def render(size):
    """RGBのバイト列(size x size)を返す。"""
    rows = []
    inv = 1.0 / (size * SS)
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px * SS + sx + 0.5) * inv
                    y = (py * SS + sy + 0.5) * inv
                    if wheel_coverage(x, y):
                        c = ACCENT
                    elif cart_coverage(x, y):
                        c = WHITE
                    else:
                        c = NAVY
                    r += c[0]; g += c[1]; b += c[2]
            n = SS * SS
            row += bytes((round(r / n), round(g / n), round(b / n)))
        rows.append(bytes(row))
    return rows


def write_png(path, size):
    rows = render(size)
    raw = b''.join(b'\x00' + r for r in rows)  # 各行のフィルタタイプは0(None)

    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))  # 8bit truecolor
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)
    print(path, size, 'x', size, len(png), 'bytes')


if __name__ == '__main__':
    write_png('icon-512.png', 512)
    write_png('icon-192.png', 192)
