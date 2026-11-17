"""Builds small test files with known metadata into tests/fixtures. Needs Pillow and ffmpeg."""
import io, os, struct, subprocess, sys, zlib
from PIL import Image, PngImagePlugin
from PIL.TiffImagePlugin import IFDRational

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
os.makedirs(OUT, exist_ok=True)

XMP = (
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">'
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description '
    'xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" '
    'xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmp:CreatorTool="Adobe Lightroom 7.0" '
    'photoshop:City="Roma" exif:GPSLatitude="41,53.4N">'
    '<dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator>'
    '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
).encode()


def picture(size=(64, 48)):
    img = Image.new("RGB", size)
    img.putdata([((x * 4) % 256, (y * 5) % 256, 120) for y in range(size[1]) for x in range(size[0])])
    return img


def exif_bytes(img, orientation=6):
    exif = img.getexif()
    exif[0x010F] = "TestMake"
    exif[0x0110] = "TestModel X"
    exif[0x0131] = "Camera FW 1.0"
    exif[0x013B] = "Jane Doe"
    exif[0x0112] = orientation
    ifd = exif.get_ifd(0x8769)
    ifd[0x9003] = "2024:06:15 19:42:10"
    ifd[0x9004] = "2024:06:15 19:42:10"
    ifd[0x829A] = IFDRational(1, 250)
    ifd[0x829D] = IFDRational(18, 10)
    ifd[0x8827] = 200
    ifd[0xA431] = "SN123456"
    gps = exif.get_ifd(0x8825)
    gps[1] = "N"
    gps[2] = (41.0, 53.0, 24.72)
    gps[3] = "E"
    gps[4] = (12.0, 29.0, 32.28)
    gps[5] = 0
    gps[6] = 50.0
    return exif.tobytes()


def jpeg():
    img = picture()
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90, exif=exif_bytes(img))
    data = buf.getvalue()
    # Insert XMP (APP1), IPTC (APP13) and a comment after the EXIF segment; append a trailer after EOI.
    at = 2
    while data[at + 1] in (0xE0, 0xE1):
        at += 2 + struct.unpack(">H", data[at + 2:at + 4])[0]
    xmp = b"http://ns.adobe.com/xap/1.0/\x00" + XMP
    iim = b"\x1c\x01\x5a\x00\x03\x1b\x25\x47" + b"\x1c\x02\x19\x00\x05beach" + b"\x1c\x02\x5a\x00\x04Roma"
    iptc = b"Photoshop 3.0\x00" + b"8BIM\x04\x04\x00\x00" + struct.pack(">I", len(iim)) + iim + (b"\x00" if len(iim) % 2 else b"")
    com = b"secret note"
    seg = lambda marker, body: b"\xff" + bytes([marker]) + struct.pack(">H", len(body) + 2) + body
    data = data[:at] + seg(0xE1, xmp) + seg(0xED, iptc) + seg(0xFE, com) + data[at:] + b"TRAILER-DATA-WITH-GPS"
    open(os.path.join(OUT, "photo.jpg"), "wb").write(data)
    plain = io.BytesIO()
    img.save(plain, "JPEG", quality=90)
    open(os.path.join(OUT, "plain.jpg"), "wb").write(plain.getvalue())


def png():
    img = picture()
    info = PngImagePlugin.PngInfo()
    info.add_text("parameters", "a cat\nNegative prompt: blurry\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1")
    info.add_text("Software", "Stable Diffusion web UI", zip=True)
    info.add_itxt("XML:com.adobe.xmp", XMP.decode())
    buf = io.BytesIO()
    img.save(buf, "PNG", pnginfo=info, exif=exif_bytes(img, 1))
    open(os.path.join(OUT, "ai.png"), "wb").write(buf.getvalue() + b"AFTER-IEND")


def webp():
    img = picture()
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=80, exif=exif_bytes(img, 1), xmp=XMP)
    open(os.path.join(OUT, "photo.webp"), "wb").write(buf.getvalue())


def gif():
    frames = [picture((32, 24)).convert("P"), picture((32, 24)).rotate(180).convert("P")]
    buf = io.BytesIO()
    frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:], loop=0, duration=100, comment=b"made by tester")
    open(os.path.join(OUT, "anim.gif"), "wb").write(buf.getvalue() + b"TAIL")


def video():
    base = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=5:duration=1",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "mpeg4", "-c:a", "aac", "-shortest"]
    meta = ["-metadata", "title=Holiday clip", "-metadata", "location=+41.8902+012.4923/", "-metadata", "make=TestMake",
            "-metadata", "artist=Jane Doe", "-metadata", "creation_time=2024-06-15T19:42:10Z"]
    subprocess.run(base + meta + [os.path.join(OUT, "clip.mp4")], check=True)
    subprocess.run(base + meta + ["-movflags", "use_metadata_tags", "-f", "mov", os.path.join(OUT, "clip.mov")], check=True)
    subprocess.run(base + ["-movflags", "frag_keyframe+empty_moov", os.path.join(OUT, "fragmented.mp4")], check=True)


if __name__ == "__main__":
    jpeg(); png(); webp(); gif(); video()
    print("fixtures:", ", ".join(sorted(os.listdir(OUT))))
