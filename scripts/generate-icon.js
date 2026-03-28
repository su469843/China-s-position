const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUTPUT_DIR = path.join(__dirname, '..', 'assets');
const SVG_PATH = path.join(OUTPUT_DIR, 'icon-generated-1024.svg');

const COLORS = {
  bgOuter: [8, 20, 33, 255],
  bgInner: [12, 32, 52, 255],
  stroke: [157, 243, 233, 255],
  ringOuter: [26, 69, 107, 255],
  ringMid: [25, 120, 142, 255],
  ringInner: [48, 187, 163, 255],
  pin: [244, 246, 248, 255],
  stone: [35, 45, 63, 255],
  highlight: [255, 255, 255, 255],
  path: [255, 190, 92, 255],
  glow: [95, 211, 204, 255],
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function mixColor(a, b, t) {
  return [
    Math.round(mix(a[0], b[0], t)),
    Math.round(mix(a[1], b[1], t)),
    Math.round(mix(a[2], b[2], t)),
    Math.round(mix(a[3], b[3], t)),
  ];
}

class Painter {
  constructor(size) {
    this.size = size;
    this.pixels = Buffer.alloc(size * size * 4, 0);
  }

  blendPixel(x, y, color, alpha = 1) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) {
      return;
    }

    const idx = (y * this.size + x) * 4;
    const srcA = (color[3] / 255) * alpha;
    const dstA = this.pixels[idx + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);

    if (outA <= 0) {
      return;
    }

    for (let i = 0; i < 3; i += 1) {
      const src = color[i] / 255;
      const dst = this.pixels[idx + i] / 255;
      const out = (src * srcA + dst * dstA * (1 - srcA)) / outA;
      this.pixels[idx + i] = Math.round(out * 255);
    }
    this.pixels[idx + 3] = Math.round(outA * 255);
  }

  fill(fn) {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        const pixel = fn(x + 0.5, y + 0.5);
        if (pixel) {
          this.blendPixel(x, y, pixel.color, pixel.alpha ?? 1);
        }
      }
    }
  }

  drawSupersampled(bounds, fn) {
    const minX = clamp(Math.floor(bounds.minX), 0, this.size - 1);
    const maxX = clamp(Math.ceil(bounds.maxX), 0, this.size - 1);
    const minY = clamp(Math.floor(bounds.minY), 0, this.size - 1);
    const maxY = clamp(Math.ceil(bounds.maxY), 0, this.size - 1);
    const offsets = [0.25, 0.75];

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        let coverage = 0;
        for (const oy of offsets) {
          for (const ox of offsets) {
            if (fn(x + ox, y + oy)) {
              coverage += 0.25;
            }
          }
        }
        if (coverage > 0) {
          this.blendPixel(x, y, bounds.color, coverage * (bounds.alpha ?? 1));
        }
      }
    }
  }
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcBuffer), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function writePng(filePath, size, rgba) {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  const png = Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  fs.writeFileSync(filePath, png);
}

function roundedRectSdf(x, y, cx, cy, width, height, radius) {
  const dx = Math.abs(x - cx) - width / 2 + radius;
  const dy = Math.abs(y - cy) - height / 2 + radius;
  const qx = Math.max(dx, 0);
  const qy = Math.max(dy, 0);
  return Math.hypot(qx, qy) + Math.min(Math.max(dx, dy), 0) - radius;
}

function circleInside(x, y, cx, cy, radius) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function polygonInside(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i][0];
    const yi = points[i][1];
    const xj = points[j][0];
    const yj = points[j][1];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function capsuleInside(x, y, x1, y1, x2, y2, radius) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : clamp(((x - x1) * dx + (y - y1) * dy) / lenSq, 0, 1);
  const px = x1 + dx * t;
  const py = y1 + dy * t;
  return Math.hypot(x - px, y - py) <= radius;
}

function renderIcon(size) {
  const painter = new Painter(size);
  const center = size / 2;
  const scale = size / 1024;

  const sx = value => value * scale;
  const bgRadius = 174;

  painter.fill((x, y) => {
    const sdf = roundedRectSdf(x, y, center, center, size - sx(28), size - sx(28), sx(148));
    if (sdf > 0) {
      return null;
    }

    const dx = x - center;
    const dy = y - center;
    const dist = Math.hypot(dx, dy);
    const t = clamp(dist / (size * 0.7), 0, 1);
    const color = mixColor(COLORS.bgInner, COLORS.bgOuter, t);
    return { color };
  });

  painter.fill((x, y) => {
    const sdf = roundedRectSdf(x, y, center, center, size - sx(38), size - sx(38), sx(144));
    if (Math.abs(sdf) > sx(6)) {
      return null;
    }
    const alpha = clamp(1 - Math.abs(sdf) / sx(6), 0, 1) * 0.95;
    return { color: COLORS.stroke, alpha };
  });

  const rings = [
    { radius: sx(398), width: sx(108), color: COLORS.ringOuter },
    { radius: sx(298), width: sx(86), color: COLORS.ringMid },
    { radius: sx(214), width: sx(80), color: COLORS.ringInner },
  ];

  for (const ring of rings) {
    painter.fill((x, y) => {
      const dist = Math.hypot(x - center, y - center);
      const edge = Math.abs(dist - ring.radius);
      if (edge > ring.width / 2) {
        return null;
      }
      const alpha = clamp(1 - edge / (ring.width / 2), 0, 1);
      return { color: ring.color, alpha: 0.95 * alpha };
    });
  }

  painter.fill((x, y) => {
    const dist = Math.hypot(x - center, y - center);
    if (dist > sx(228)) {
      return null;
    }
    const alpha = clamp(1 - dist / sx(228), 0.15, 1);
    return { color: COLORS.glow, alpha: 0.18 * alpha };
  });

  painter.drawSupersampled(
    {
      minX: sx(310),
      maxX: sx(740),
      minY: sx(160),
      maxY: sx(875),
      color: COLORS.pin,
    },
    (x, y) => {
      const circle = circleInside(x, y, center, sx(360), sx(192));
      const point = polygonInside(x, y, [
        [sx(378), sx(470)],
        [sx(646), sx(470)],
        [sx(512), sx(820)],
      ]);
      return circle || point;
    },
  );

  painter.fill((x, y) => {
    if (!capsuleInside(x, y, sx(390), sx(610), sx(650), sx(468), sx(26))) {
      return null;
    }
    return { color: COLORS.path, alpha: 0.9 };
  });

  painter.fill((x, y) => {
    if (!capsuleInside(x, y, sx(650), sx(468), sx(700), sx(410), sx(20))) {
      return null;
    }
    return { color: COLORS.path, alpha: 0.9 };
  });

  painter.drawSupersampled(
    {
      minX: sx(422),
      maxX: sx(602),
      minY: sx(410),
      maxY: sx(590),
      color: COLORS.stone,
    },
    (x, y) => roundedRectSdf(x, y, sx(512), sx(500), sx(160), sx(180), sx(48)) <= 0,
  );

  painter.drawSupersampled(
    {
      minX: sx(470),
      maxX: sx(554),
      minY: sx(452),
      maxY: sx(540),
      color: COLORS.highlight,
    },
    (x, y) => {
      const vertical = x >= sx(494) && x <= sx(530) && y >= sx(436) && y <= sx(560);
      const horizontal = x >= sx(454) && x <= sx(570) && y >= sx(482) && y <= sx(518);
      return vertical || horizontal;
    },
  );

  painter.fill((x, y) => {
    const glow = capsuleInside(x, y, sx(380), sx(612), sx(650), sx(468), sx(46));
    if (!glow) {
      return null;
    }
    return { color: COLORS.path, alpha: 0.15 };
  });

  return painter.pixels;
}

function writeIcon(filePath, size) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writePng(filePath, size, renderIcon(size));
}

function writeSvg() {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(512 456) rotate(90) scale(640)">
      <stop stop-color="#0C2034"/>
      <stop offset="1" stop-color="#081421"/>
    </radialGradient>
    <radialGradient id="glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(512 512) rotate(90) scale(228)">
      <stop stop-color="#5FD3CC" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#5FD3CC" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect x="14" y="14" width="996" height="996" rx="148" fill="url(#bg)"/>
  <rect x="19" y="19" width="986" height="986" rx="144" stroke="#9DF3E9" stroke-width="10"/>
  <circle cx="512" cy="512" r="398" stroke="#1A456B" stroke-width="108"/>
  <circle cx="512" cy="512" r="298" stroke="#19788E" stroke-width="86"/>
  <circle cx="512" cy="512" r="214" stroke="#30BBA3" stroke-width="80"/>
  <circle cx="512" cy="512" r="228" fill="url(#glow)"/>
  <path d="M512 168C618.039 168 704 253.961 704 360C704 415.052 680.83 464.691 643.648 499.699L512 820L380.352 499.699C343.17 464.691 320 415.052 320 360C320 253.961 405.961 168 512 168Z" fill="#F4F6F8"/>
  <path d="M390 610L650 468" stroke="#FFBE5C" stroke-width="52" stroke-linecap="round"/>
  <path d="M650 468L700 410" stroke="#FFBE5C" stroke-width="40" stroke-linecap="round"/>
  <rect x="432" y="410" width="160" height="180" rx="48" fill="#232D3F"/>
  <rect x="494" y="436" width="36" height="124" fill="white"/>
  <rect x="454" y="482" width="116" height="36" fill="white"/>
</svg>
`;

  fs.writeFileSync(SVG_PATH, svg);
}

const targets = [
  { size: 1024, file: path.join(OUTPUT_DIR, 'icon-generated-1024.png') },
  { size: 48, file: path.join(__dirname, '..', 'android/app/src/main/res/mipmap-mdpi/ic_launcher.png') },
  { size: 48, file: path.join(__dirname, '..', 'android/app/src/main/res/mipmap-mdpi/ic_launcher_round.png') },
  { size: 72, file: path.join(__dirname, '..', 'android/app/src/main/res/mipmap-hdpi/ic_launcher.png') },
  { size: 72, file: path.join(__dirname, '..', 'android/app/src/main/res/mipmap-hdpi/ic_launcher_round.png') },
  { size: 96, file: path.join(__dirname, '..', 'android/app/src/main/res/mipmap-xhdpi/ic_launcher.png') },
  { size: 96, file: path.join(__dirname, '..', 'android/app/src/main/res/mipmap-xhdpi/ic_launcher_round.png') },
  { size: 144, file: path.join(__dirname, '..', 'android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png') },
  { size: 144, file: path.join(__dirname, '..', 'android/app/src/main/res/mipmap-xxhdpi/ic_launcher_round.png') },
  { size: 192, file: path.join(__dirname, '..', 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png') },
  { size: 192, file: path.join(__dirname, '..', 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png') },
  { size: 40, file: path.join(__dirname, '..', 'ios/ChinaPositionApp/Images.xcassets/AppIcon.appiconset/Icon-App-20x20@2x.png') },
  { size: 60, file: path.join(__dirname, '..', 'ios/ChinaPositionApp/Images.xcassets/AppIcon.appiconset/Icon-App-20x20@3x.png') },
  { size: 58, file: path.join(__dirname, '..', 'ios/ChinaPositionApp/Images.xcassets/AppIcon.appiconset/Icon-App-29x29@2x.png') },
  { size: 87, file: path.join(__dirname, '..', 'ios/ChinaPositionApp/Images.xcassets/AppIcon.appiconset/Icon-App-29x29@3x.png') },
  { size: 80, file: path.join(__dirname, '..', 'ios/ChinaPositionApp/Images.xcassets/AppIcon.appiconset/Icon-App-40x40@2x.png') },
  { size: 120, file: path.join(__dirname, '..', 'ios/ChinaPositionApp/Images.xcassets/AppIcon.appiconset/Icon-App-40x40@3x.png') },
  { size: 120, file: path.join(__dirname, '..', 'ios/ChinaPositionApp/Images.xcassets/AppIcon.appiconset/Icon-App-60x60@2x.png') },
  { size: 180, file: path.join(__dirname, '..', 'ios/ChinaPositionApp/Images.xcassets/AppIcon.appiconset/Icon-App-60x60@3x.png') },
  { size: 1024, file: path.join(__dirname, '..', 'ios/ChinaPositionApp/Images.xcassets/AppIcon.appiconset/Icon-App-1024x1024@1x.png') },
];

for (const target of targets) {
  writeIcon(target.file, target.size);
  console.log(`Generated ${target.file}`);
}

writeSvg();
console.log(`Generated ${SVG_PATH}`);
