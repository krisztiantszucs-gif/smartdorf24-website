#!/usr/bin/env python3
"""Render the combined ~30s SmartDorf24 screen ad (3 x 10s segments).
Usage: make-combined-ad.py --karamalz IMG --qr QR.png --stock data/stock.json
       --discounts data/discounts.json --out out.mp4 --preview preview.png
Frames rendered with Pillow and piped to ffmpeg (H.264 yuv420p 30fps)."""
import argparse, json, math, random, subprocess, io, urllib.request, os, datetime
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H, FPS, SEG = 1792, 1008, 30, 10
TEAL, BLUE, RED, YEL, BG, WHITE = (61,214,198), (110,168,255), (255,77,94), (255,208,64), (8,12,22), (240,245,255)
DEEP, PINK = (139, 0, 0), (255, 23, 68)
FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
_fc = {}
def font(sz, bold=True):
    k = (sz, bold)
    if k not in _fc: _fc[k] = ImageFont.truetype(FB if bold else FR, sz)
    return _fc[k]

def ease(x): x = max(0., min(1., x)); return 1 - (1 - x) ** 3
def pop(x):  # overshoot pop-in 0..1
    x = max(0., min(1., x)); return 1 + 2.7 * (x - 1) ** 3 + 1.7 * (x - 1) ** 2 if x < 1 else 1.

random.seed(24)
PARTS = [(random.random()*W, random.random()*H, random.uniform(2,6), random.uniform(10,40), random.random()*6.28) for _ in range(70)]

def background(t, c1=(10,18,36), c2=(14,44,52)):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    sh = (math.sin(t*0.6)+1)/2
    for y in range(0, H, 8):
        f = y/H
        c = tuple(int(c1[i]*(1-f)+c2[i]*f + 10*sh*f) for i in range(3))
        d.rectangle([0,y,W,y+8], fill=c)
    for (x,y,r,sp,ph) in PARTS:
        yy = (y - t*sp) % H; xx = x + 18*math.sin(t*0.8+ph)
        a = int(90 + 80*math.sin(t*2+ph))
        d.ellipse([xx-r,yy-r,xx+r,yy+r], fill=(min(255,61+a//3),214,198) if ph>3 else (110,168,min(255,180+a//4)))
    return img

def text_c(d, cx, y, s, f, fill, stroke=0, sfill=(0,0,0)):
    w = d.textlength(s, font=f); d.text((cx-w/2, y), s, font=f, fill=fill, stroke_width=stroke, stroke_fill=sfill)

def scaled_text(img, s, f, fill, cx, cy, scale, stroke=4):
    if scale <= 0.02: return
    d0 = ImageDraw.Draw(img); bw = int(d0.textlength(s, font=f)) + 40; bh = f.size + 40
    layer = Image.new("RGBA", (bw, bh), (0,0,0,0))
    ImageDraw.Draw(layer).text((20,10), s, font=f, fill=fill, stroke_width=stroke, stroke_fill=(0,0,0,200))
    nw, nh = max(1,int(bw*scale)), max(1,int(bh*scale))
    layer = layer.resize((nw, nh), Image.LANCZOS)
    img.paste(layer, (int(cx-nw/2), int(cy-nh/2)), layer)

def fetch_img(url):
    try:
        if os.path.exists(url): return Image.open(url).convert("RGB")
        return Image.open(io.BytesIO(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent":"sd24"}), timeout=20).read())).convert("RGB")
    except Exception: return None

def cover(img, w, h):
    s = max(w/img.width, h/img.height); im = img.resize((int(img.width*s)+1, int(img.height*s)+1), Image.LANCZOS)
    l, t = (im.width-w)//2, (im.height-h)//2; return im.crop((l,t,l+w,t+h))

def brand_bar(img, t):
    d = ImageDraw.Draw(img)
    d.rectangle([0,H-70,W,H], fill=(6,10,18))
    d.text((40,H-58), "SmartDorf24", font=font(36), fill=TEAL)
    d.text((W-460,H-52), "smartdorf24.de · 24/7", font=font(30,False), fill=WHITE)
    x = int((t*400) % (W+400)) - 200
    d.rectangle([x,H-72,x+200,H-68], fill=TEAL)

# --- segment 1: Karamalz Ken Burns ---
def seg_karamalz(t, src, price=None):
    z = 1.0 + 0.18*ease(t/SEG); pan = 60*math.sin(t*0.35)
    cw, ch = int(W/z), int(H/z)
    base = cover(src, W+160, H+160)
    l = int((base.width-cw)/2 + pan); tp = int((base.height-ch)/2 - pan*0.4)
    img = base.crop((l,tp,l+cw,tp+ch)).resize((W,H), Image.LANCZOS)
    if t < 0.6: img = Image.blend(Image.new("RGB",(W,H),BG), img, ease(t/0.6))
    ov = Image.new("RGBA",(W,H),(0,0,0,0)); od = ImageDraw.Draw(ov)
    od.rectangle([0,H-260,W,H], fill=(0,0,0,150))
    img = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
    d = ImageDraw.Draw(img)
    s = pop((t-1.0)/0.6)
    scaled_text(img, "Jetzt im Automaten!", font(78), YEL, W/2, H-200, s)
    if price and t > 1.4:
        old = f"{float(price['old']):.2f} €".replace(".", ","); new = f"{float(price['new']):.2f} €".replace(".", ",")
        label = price.get("label") or "Abverkauf"
        # price badge top-right
        bx, by, bw, bh = W-520, 60, 480, 200
        d.rounded_rectangle([bx, by, bx+bw, by+bh], 24, fill=(20, 10, 10), outline=YEL, width=4)
        d.text((bx+28, by+16), label, font=font(36), fill=YEL)
        ow = d.textlength(old, font=font(40, False))
        d.text((bx+28, by+70), old, font=font(40, False), fill=(190,190,200))
        d.line([bx+28, by+96, bx+28+ow, by+96], fill=RED, width=4)
        ps = 1 + 0.06*math.sin(t*6)
        scaled_text(img, new, font(72), YEL, bx+bw-140, by+130, ps*ease((t-1.4)/0.4), 4)
    if t > 2.2:
        p = 1 + 0.06*math.sin((t-2.2)*5)
        scaled_text(img, "Eiskalt · 24/7 · Kontaktlos zahlen", font(40), WHITE, W/2, H-120, p*ease((t-2.2)/0.5), 3)
    brand_bar(img, t); return img

# --- segment 2: Live stock ---
def seg_live(t, qr, thumbs):
    img = background(t, (10,22,48), (8,52,60)); d = ImageDraw.Draw(img)
    x0 = -900 + 1000*ease(t/0.8)
    d.text((x0+100, 120), "Live-Bestand", font=font(110), fill=TEAL, stroke_width=3, stroke_fill=(0,0,0))
    d.text((x0+100, 250), "jetzt online", font=font(110), fill=WHITE, stroke_width=3, stroke_fill=(0,0,0))
    if t > 0.9:
        a = ease((t-0.9)/0.6); d.text((100, 400), "See live stock online", font=font(48,False), fill=tuple(int(c*a) for c in BLUE))
    if t > 1.4:
        d.text((100, 480), "Vor dem Weg prüfen, was drin ist.", font=font(38,False), fill=WHITE)
    # thumbs carousel
    for i, th in enumerate(thumbs):
        st = 1.8 + i*0.25
        if t < st: continue
        sc = pop((t-st)/0.5); sz = int(150*sc)
        if sz < 4: continue
        x = 100 + i*175 + 75; y = 680 + int(10*math.sin(t*3+i))
        tile = Image.new("RGB",(170,170),(255,255,255)); tile.paste(th.resize((150,150)),(10,10))
        tile = tile.resize((int(170*sc),int(170*sc)))
        img.paste(tile,(x-tile.width//2, y-tile.height//2))
    # QR pulsing
    if t > 0.5:
        sc = pop((t-0.5)/0.7) * (1 + 0.04*math.sin(t*6))
        qs = int(440*sc)
        if qs > 10:
            q = qr.resize((qs,qs)); cx, cy = W-340, 430
            ImageDraw.Draw(img).rounded_rectangle([cx-qs/2-20,cy-qs/2-20,cx+qs/2+20,cy+qs/2+20], 24, fill=WHITE)
            img.paste(q,(int(cx-qs/2),int(cy-qs/2)))
    if t > 2.5:
        g = int(127+127*math.sin(t*6)); text_c(d, W-340, 700, "Scan → smartdorf24.de", font(36), (g,255,230))
    brand_bar(img, t); return img

# --- segment 3: Deals ---
def burst(img, cx, cy, r, t, col):
    d = ImageDraw.Draw(img); pts = []
    n = 18; rot = t*0.8
    for i in range(n*2):
        rr = r if i%2==0 else r*0.72; a = rot + i*math.pi/n
        pts.append((cx+rr*math.cos(a), cy+rr*math.sin(a)))
    d.polygon(pts, fill=col)

def seg_deals(t, deals):
    img = background(t, (40,8,20), (60,20,10)); d = ImageDraw.Draw(img)
    top = max([dl["pct"] for dl in deals], default=0)
    # −70% gets a deeper red, faster "flash" pulse
    pulse = (1+0.12*math.sin(t*(14 if top>=70 else 5)))
    r = 230*pop(t/0.6)*pulse
    if r > 5:
        c1, c2 = (DEEP, PINK) if top >= 70 else (RED, YEL)
        burst(img, 330, 360, r, t, c1); burst(img, 330, 360, r*0.82, -t, c2); burst(img, 330, 360, r*0.68, t, c1)
        scaled_text(img, f"−{top}%" if deals else "TOP", font(130), WHITE, 330, 360, min(1,r/230), 5)
    if deals:
        if top >= 70: headline = "Kurz vor MHD – bis −70%!"
        elif any(x["pct"]==50 for x in deals): headline = "Kurz vor MHD – bis −50%!"
        else: headline = "Kurz vor MHD – −20%!"
        d.text((640, 90), headline, font=font(58), fill=YEL, stroke_width=2, stroke_fill=(0,0,0))
        for i, dl in enumerate(deals[:5]):
            st = 0.8 + i*0.45
            if t < st: continue
            x = 640 + int(1200*(1-ease((t-st)/0.5))); y = 190 + i*122
            d.rounded_rectangle([x,y,x+1080,y+108], 18, fill=(20,20,30), outline=YEL, width=3)
            name = dl["name"] if len(dl["name"]) < 27 else dl["name"][:25]+"…"
            d.text((x+24,y+12), name, font=font(40), fill=WHITE)
            d.text((x+24,y+64), f"−{dl['pct']}%  ·  nur noch bis {dl['until']}", font=font(28,False), fill=(255,190,190))
            old = f"{dl['old']:.2f} €".replace(".",","); new = f"{dl['new']:.2f} €".replace(".",",")
            ow = d.textlength(old, font=font(38,False)); ox = x+690
            d.text((ox,y+36), old, font=font(38,False), fill=(180,180,190)); d.line([ox,y+60,ox+ow,y+60], fill=RED, width=4)
            ps = 1+0.08*math.sin((t-st)*7)
            scaled_text(img, new, font(52), YEL, x+990, y+56, ps*ease((t-st)/0.4), 3)
    else:
        d.text((640, 220), "Tagesangebote", font=font(110), fill=YEL, stroke_width=3, stroke_fill=(0,0,0))
        if t > 1: d.text((640, 380), "24/7 Snacks & Getränke", font=font(64), fill=WHITE)
    if t > 3:
        p = 1+0.07*math.sin(t*6)
        scaled_text(img, "Jetzt zugreifen!  smartdorf24.de", font(56), TEAL, W/2, H-120, p, 4)
    brand_bar(img, t); return img


GREEN = (60, 220, 120)
PER_PAGE, MAX_SALE = 6, 12

def seg_sale(t, items, thumbs):
    img = background(t, (8,30,20), (10,48,40)); d = ImageDraw.Draw(img)
    pages = [items[i:i+PER_PAGE] for i in range(0, min(len(items), MAX_SALE), PER_PAGE)] or [[]]
    plen = SEG/max(1,len(pages)); pi = min(len(pages)-1, int(t//plen)); pt = t - pi*plen
    top = max([x["pct"] for x in items], default=0)
    r = 120*pop(t/0.6)*(1+0.08*math.sin(t*6))
    if r > 5:
        burst(img, 150, 120, r, t, RED); burst(img, 150, 120, r*0.8, -t, YEL)
        scaled_text(img, f"−{top}%", font(64), WHITE, 150, 120, min(1, r/120), 4)
    x0 = -900 + 1190*ease(t/0.7)
    d.text((x0, 40), "Schnäppchen / Sale", font=font(86), fill=YEL, stroke_width=3, stroke_fill=(0,0,0))
    d.text((300, 150), "Restposten – solange der Vorrat reicht", font=font(36, False), fill=WHITE)
    if len(pages) > 1: d.text((W-170, 160), f"{pi+1}/{len(pages)}", font=font(34), fill=TEAL)
    for i, it in enumerate(pages[pi]):
        st = 0.25 + i*0.18
        if pt < st: continue
        col, row = i % 2, i // 2
        x = 80 + col*830 + int(900*(1-ease((pt-st)/0.45))) * (1 if col else -1)
        y = 220 + row*225
        d.rounded_rectangle([x, y, x+800, y+205], 22, fill=(16,24,30), outline=GREEN, width=3)
        th = thumbs.get(it.get("lane") or it.get("key") or i)
        if th is not None:
            tile = Image.new("RGB", (175,175), (255,255,255)); tile.paste(cover(th,165,165), (5,5)); img.paste(tile, (x+15, y+15))
        name = it["name"].replace(" inkl. pfand","").replace(" inkl pfand.","")
        name = name if len(name) < 24 else name[:22] + "…"
        d.text((x+205, y+18), name, font=font(38), fill=WHITE)
        old = f"{it['old']:.2f} €".replace(".", ","); new = f"{it['new']:.2f} €".replace(".", ",")
        f2 = font(36, False); ow = d.textlength(old, font=f2)
        d.text((x+205, y+92), old, font=f2, fill=(170,175,185)); d.line([x+205, y+114, x+205+ow, y+114], fill=RED, width=4)
        d.rounded_rectangle([x+205, y+145, x+330, y+190], 12, fill=RED); d.text((x+218, y+148), f"−{it['pct']}%", font=font(34), fill=WHITE)
        ps = 1 + 0.07*math.sin((pt-st)*6)
        scaled_text(img, new, font(64), YEL, x+640, y+110, ps*ease((pt-st)/0.35), 3)
    brand_bar(img, t); return img

def transition(a, b, x):  # slide + fade
    x = ease(x); off = int(W*0.25*(1-x))
    out = Image.blend(a, b, x)
    if off: out.paste(Image.blend(a, b, x).crop((0,0,W-off,H)), (off,0))
    return out

def main():
    ap = argparse.ArgumentParser()
    for a in ["qr","stock","discounts","out","preview"]: ap.add_argument("--"+a, required=True)
    ap.add_argument("--karamalz", default="")
    ap.add_argument("--karamalz-old", type=float, default=0)
    ap.add_argument("--karamalz-new", type=float, default=0)
    ap.add_argument("--karamalz-label", default="Abverkauf")
    ap.add_argument("--rtus", default="all")
    ap.add_argument("--segments", default="karamalz,live,deals",
                    help="comma-separated: karamalz,live,deals,sale")
    ap.add_argument("--deals-json", default="",
                    help="optional verified deals JSON from combined.mjs")
    ap.add_argument("--sale-json", default="",
                    help="optional verified clearance/sale JSON")
    o = ap.parse_args()
    kar = fetch_img(o.karamalz) if o.karamalz else None
    kar_price = {"old": o.karamalz_old, "new": o.karamalz_new, "label": o.karamalz_label} if o.karamalz_new else None
    qr = Image.open(o.qr).convert("RGB")
    wanted = [x.strip() for x in o.segments.split(",") if x.strip()]
    stock = json.load(open(o.stock)); disc = json.load(open(o.discounts)) if os.path.exists(o.discounts) else {}
    rtus = None if o.rtus == "all" else set(o.rtus.split(","))
    thumbs = []
    for loc in stock.get("locations",[]):
        for m in loc["machines"]:
            if rtus and str(m.get("rtuNumber")) not in rtus: continue
            for it in m["items"]:
                if it.get("image") and it.get("stock",0) > 0 and not it.get("expired") and len(thumbs) < 5:
                    im = fetch_img(it["image"])
                    if im: thumbs.append(im)
    # Berlin "today" — Actions runners are UTC
    today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=2))).date()  # CEST approx; overridden below
    try:
        from zoneinfo import ZoneInfo
        today = datetime.datetime.now(ZoneInfo("Europe/Berlin")).date()
    except Exception:
        pass
    deals = []
    if o.deals_json and os.path.exists(o.deals_json):
        raw = json.load(open(o.deals_json)).get("deals") or []
        for a in raw:
            try:
                dd = datetime.date.fromisoformat(str(a["until"])[:10]) if "-" in str(a.get("until","")) else None
                until = dd.strftime("%d.%m.") if dd else str(a.get("until",""))
                deals.append({"name":a["name"],"old":float(a["old"]),"new":float(a["new"]),"until":until,"pct":int(a.get("pct") or 50)})
            except Exception: pass
    else:
        for a in (disc.get("active") or {}).values():
            if rtus and str(a.get("rtuNumber")) not in rtus: continue
            try:
                if datetime.date.fromisoformat(a["effDate"]) >= today:
                    dd = datetime.date.fromisoformat(a["effDate"])
                    deals.append({"name":a["name"],"old":float(a["originalPrice"]),"new":float(a["discountPrice"]),"until":dd.strftime("%d.%m."),"pct":int(a.get("percent") or 50)})
            except Exception: pass
    sale_items = []
    sale_thumbs = {}
    if o.sale_json and os.path.exists(o.sale_json):
        for a in (json.load(open(o.sale_json)).get("sale") or [])[:MAX_SALE]:
            try:
                it = {"name": a["name"], "old": float(a["old"]), "new": float(a["new"]),
                      "pct": int(a.get("pct") or 20), "lane": f"{a.get('rtuNumber','')}:{a.get('lane','')}",
                      "until": str(a.get("until") or "")}
                sale_items.append(it)
                if a.get("image"):
                    im = fetch_img(a["image"])
                    if im: sale_thumbs[it["lane"]] = im
            except Exception: pass
    # Also try stock images by lane if missing
    if sale_items and stock.get("locations"):
        for loc in stock["locations"]:
            for m in loc["machines"]:
                for it in m["items"]:
                    k = f"{m.get('rtuNumber')}:{it.get('lane')}"
                    if k in sale_thumbs: continue
                    if any(s["lane"] == k for s in sale_items) and it.get("image"):
                        im = fetch_img(it["image"])
                        if im: sale_thumbs[k] = im
    builders = {}
    if kar is not None:
        builders["karamalz"] = lambda t, _k=kar, _p=kar_price: seg_karamalz(t, _k, _p)
    builders["live"] = lambda t: seg_live(t, qr, thumbs)
    builders["deals"] = lambda t: seg_deals(t, deals)
    builders["sale"] = lambda t: seg_sale(t, sale_items, sale_thumbs)
    segs = []
    for name in wanted:
        if name not in builders:
            raise SystemExit(f"unknown/unavailable segment: {name}")
        segs.append(builders[name])
    if not segs:
        raise SystemExit("no segments selected")
    p = subprocess.Popen(["ffmpeg","-y","-loglevel","error","-f","rawvideo","-pix_fmt","rgb24","-s",f"{W}x{H}","-r",str(FPS),"-i","-",
        "-c:v","libx264","-preset","medium","-crf","26","-pix_fmt","yuv420p","-color_range","tv","-movflags","+faststart","-an",o.out], stdin=subprocess.PIPE)
    frames, TR = [], 0.5
    for si, seg in enumerate(segs):
        for f in range(SEG*FPS):
            t = f/FPS; fr = seg(t)
            if si < len(segs) - 1 and t > SEG-TR:  # crossfade into next segment
                fr = transition(fr, segs[si+1](0.0), (t-(SEG-TR))/TR)
            if f == int(5.5*FPS): frames.append(fr.copy())
            p.stdin.write(fr.tobytes())
    p.stdin.close(); p.wait()
    n = max(1, len(frames))
    tw, th = W//3, H//3
    sheet = Image.new("RGB", (tw*n + 10*(n+1), th+20), (20,20,20))
    for i, fr in enumerate(frames): sheet.paste(fr.resize((tw,th)), (10+i*(tw+10), 10))
    sheet.save(o.preview)
    print(json.dumps({"segments": wanted, "deals": len(deals), "sale": len(sale_items), "thumbs": len(thumbs), "duration_s": len(segs)*SEG, "karamalzPrice": kar_price}))

if __name__ == "__main__": main()
