import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

# Fonts
MONTSERRAT = r"D:\Work\mental-empire-studio\.kilo\worktrees\bronze-bromine\resources\fonts\Montserrat-ExtraBold.ttf"
IMPACT = r"C:\Windows\Fonts\impact.ttf"

def heal_arrow_region(im, box, sample_offset):
    """Cleanly heals the old tiny arrow by sampling nearby background."""
    w, h = im.size
    healed = im.copy().convert("RGBA")
    
    # Mask red pixels
    mask = Image.new("L", (w, h), 0)
    for y in range(box[1], box[3]):
        for x in range(box[0], box[2]):
            px = im.getpixel((x, y))
            r, g, b = px[0], px[1], px[2]
            if r > 150 and g < 65 and b < 65:
                mask.putpixel((x, y), 255)
                
    mask = mask.filter(ImageFilter.MaxFilter(5))
    
    dx, dy = sample_offset
    for y in range(box[1], box[3]):
        for x in range(box[0], box[2]):
            if mask.getpixel((x, y)) > 0:
                sx = max(0, min(w - 1, x + dx))
                sy = max(0, min(h - 1, y + dy))
                healed.putpixel((x, y), im.getpixel((sx, sy)))
                
    cropped = healed.crop(box)
    blurred = cropped.filter(ImageFilter.GaussianBlur(1.5))
    healed.paste(blurred, box)
    return healed

def apply_thumbnail_grade(im):
    """Boosts contrast and vibrance to make thumbnail pop on mobile feeds."""
    # Contrast
    enhancer = ImageEnhance.Contrast(im.convert("RGB"))
    graded = enhancer.enhance(1.16)
    # Color vibrance
    enhancer = ImageEnhance.Color(graded)
    graded = enhancer.enhance(1.18)
    # Sharpness
    enhancer = ImageEnhance.Sharpness(graded)
    graded = enhancer.enhance(1.2)
    return graded.convert("RGBA")

def create_curved_arrow_layer(size, points, arrow_head_len=80, arrow_head_w=75, shaft_w=28, fill_color=(255, 20, 40), stroke_color=(255, 255, 255), stroke_w=4):
    """
    Renders a bold, professional curved YouTube curiosity arrow with drop shadow.
    points: list of (x, y) along bezier curve from tail to tip
    """
    w, h = size
    # Create high-res layer for smooth rendering
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    
    # Draw thick shaft using overlapping circles along curve
    tip = points[-1]
    prev = points[-2]
    dx = tip[0] - prev[0]
    dy = tip[1] - prev[1]
    angle = math.atan2(dy, dx)
    
    # Stop shaft before the tip to attach head cleanly
    head_back_x = tip[0] - arrow_head_len * 0.75 * math.cos(angle)
    head_back_y = tip[1] - arrow_head_len * 0.75 * math.sin(angle)
    
    # Draw shaft
    for pt in points:
        dist_to_tip = math.hypot(pt[0] - tip[0], pt[1] - tip[1])
        if dist_to_tip > arrow_head_len * 0.6:
            r = shaft_w / 2
            draw.ellipse([pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r], fill=fill_color)
            
    # Calculate arrowhead polygon points
    # Tip of arrow
    p_tip = tip
    # Base perpendicular
    perp_angle = angle + math.pi / 2
    half_w = arrow_head_w / 2
    
    base_x = tip[0] - arrow_head_len * math.cos(angle)
    base_y = tip[1] - arrow_head_len * math.sin(angle)
    
    p_left = (base_x + half_w * math.cos(perp_angle), base_y + half_w * math.sin(perp_angle))
    p_right = (base_x - half_w * math.cos(perp_angle), base_y - half_w * math.sin(perp_angle))
    
    # Barbed indent at center of base
    indent_x = base_x + (arrow_head_len * 0.25) * math.cos(angle)
    indent_y = base_y + (arrow_head_len * 0.25) * math.sin(angle)
    p_indent = (indent_x, indent_y)
    
    head_poly = [p_tip, p_left, p_indent, p_right]
    draw.polygon(head_poly, fill=fill_color)
    
    # Create shadow
    shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    s_draw = ImageDraw.Draw(shadow)
    # Extract alpha mask of arrow
    alpha = layer.split()[3]
    # Dilate slightly for black border
    border_mask = alpha.filter(ImageFilter.MaxFilter(stroke_w * 2 + 1))
    
    # Shadow mask
    shadow_mask = border_mask.filter(ImageFilter.GaussianBlur(10))
    s_draw.bitmap((8, 10), shadow_mask, fill=(0, 0, 0, 200))
    
    # White/Black outline layer
    outline_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    o_draw = ImageDraw.Draw(outline_layer)
    if stroke_w > 0:
        o_draw.bitmap((0, 0), border_mask, fill=(stroke_color[0], stroke_color[1], stroke_color[2], 255))
        
    # Composite: shadow -> outline -> arrow
    result = Image.alpha_composite(shadow, outline_layer)
    result = Image.alpha_composite(result, layer)
    return result

def draw_youtube_text(base, lines, origin, font_size=105, line_height=115, rotation=0):
    """
    Draws high-impact, thick outlined YouTube thumbnail text with drop shadow.
    lines: list of tuples [(text, fill_color), ...]
    """
    w, h = base.size
    font = ImageFont.truetype(MONTSERRAT, font_size)
    
    # Render text onto dedicated transparent canvas so we can rotate and shadow
    txt_canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(txt_canvas)
    
    cur_y = origin[1]
    for text, fill_color in lines:
        x = origin[0]
        # Draw heavy black stroke
        draw.text((x, cur_y), text, font=font, fill=fill_color,
                  stroke_width=14, stroke_fill=(0, 0, 0, 255))
        cur_y += line_height

    # Deep drop shadow
    alpha = txt_canvas.split()[3]
    shadow_mask = alpha.filter(ImageFilter.GaussianBlur(8))
    
    shadow_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    s_draw = ImageDraw.Draw(shadow_layer)
    s_draw.bitmap((8, 10), shadow_mask, fill=(0, 0, 0, 220))
    
    # Composite shadow then text
    comp = Image.alpha_composite(shadow_layer, txt_canvas)
    
    if rotation != 0:
        comp = comp.rotate(rotation, resample=Image.BICUBIC, center=origin)
        
    return Image.alpha_composite(base, comp)

def bezier_curve(p0, p1, p2, p3, steps=100):
    points = []
    for i in range(steps + 1):
        t = i / float(steps)
        u = 1 - t
        x = u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0]
        y = u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1]
        points.append((x, y))
    return points

def make_tupac_thumbnail():
    src_path = r"D:\Work\youtube-analytics-hub\outputs\tupac\2026-09-17-rejected-tough-guy-label\thumbnails\thumb-tupac-1280x720.jpg"
    im = Image.open(src_path)
    
    # 1. Clean heal old arrow
    healed = heal_arrow_region(im, (640, 350, 740, 520), (-45, 0))
    
    # 2. Apply YouTube contrast & vibrance pop
    graded = apply_thumbnail_grade(healed)
    
    # 3. Add Big Bold High-CTR Red Arrow
    # Arrow swoops from lower center-left curving upward towards Tupac's calm, peaceful face
    # or curving towards Tupac across the table!
    p0 = (620, 560)
    p1 = (690, 470)
    p2 = (800, 380)
    p3 = (940, 330) # Pointing right at Tupac's face!
    points = bezier_curve(p0, p1, p2, p3, steps=80)
    arrow = create_curved_arrow_layer(graded.size, points, arrow_head_len=85, arrow_head_w=80, shaft_w=30,
                                     fill_color=(255, 20, 35), stroke_color=(255, 255, 255), stroke_w=4)
    graded = Image.alpha_composite(graded, arrow)
    
    # 4. Add Bold YouTube Thumbnail Headline in top-left negative space
    # "HE" (white) \n "REFUSED." (vibrant golden yellow)
    lines = [
        ("HE", (255, 255, 255, 255)),
        ("REFUSED.", (255, 222, 0, 255))
    ]
    graded = draw_youtube_text(graded, lines, origin=(85, 75), font_size=115, line_height=125, rotation=-2)
    
    # Resize to exact 1280x720 standard YouTube thumbnail
    final = graded.resize((1280, 720), Image.Resampling.LANCZOS).convert("RGB")
    
    out_path = r"D:\Work\youtube-analytics-hub\outputs\tupac\2026-09-17-rejected-tough-guy-label\thumbnails\thumb-tupac-1280x720.jpg"
    final.save(out_path, quality=95)
    artifact_path = r"C:\Users\261-0\.gemini\antigravity\brain\ea63eec0-1d54-4f23-ac68-a12ab7fd557c\tupac_thumbnail_v2.jpg"
    final.save(artifact_path, quality=95)
    print("Tupac thumbnail generated successfully!")

def make_prince_thumbnail():
    src_path = r"D:\Work\youtube-analytics-hub\outputs\prince\2026-09-18-purple-rain-guitar-climax\thumbnails\thumb-prince-1280x720.jpg"
    im = Image.open(src_path)
    
    # 1. Clean heal old arrow
    healed = heal_arrow_region(im, (930, 540, 1100, 650), (0, 40))
    
    # 2. Apply YouTube contrast & vibrance pop
    graded = apply_thumbnail_grade(healed)
    
    # 3. Add Big Bold High-CTR Red Arrow
    # Swooping from bottom right curving directly into the guitar pickups and Prince's hands
    p0 = (1280, 660)
    p1 = (1180, 590)
    p2 = (1040, 540)
    p3 = (890, 535) # Pointing directly into the guitar solo
    points = bezier_curve(p0, p1, p2, p3, steps=80)
    arrow = create_curved_arrow_layer(graded.size, points, arrow_head_len=88, arrow_head_w=82, shaft_w=32,
                                     fill_color=(255, 20, 35), stroke_color=(255, 255, 255), stroke_w=4)
    graded = Image.alpha_composite(graded, arrow)
    
    # 4. Add Bold YouTube Thumbnail Headline in top-left dark stage space
    # "THEY" (white) \n "CRIED." (vibrant golden yellow)
    lines = [
        ("THEY", (255, 255, 255, 255)),
        ("CRIED.", (255, 222, 0, 255))
    ]
    graded = draw_youtube_text(graded, lines, origin=(95, 110), font_size=115, line_height=125, rotation=-2)
    
    # Resize to exact 1280x720 standard YouTube thumbnail
    final = graded.resize((1280, 720), Image.Resampling.LANCZOS).convert("RGB")
    
    out_path = r"D:\Work\youtube-analytics-hub\outputs\prince\2026-09-18-purple-rain-guitar-climax\thumbnails\thumb-prince-1280x720.jpg"
    final.save(out_path, quality=95)
    artifact_path = r"C:\Users\261-0\.gemini\antigravity\brain\ea63eec0-1d54-4f23-ac68-a12ab7fd557c\prince_thumbnail_v2.jpg"
    final.save(artifact_path, quality=95)
    print("Prince thumbnail generated successfully!")

if __name__ == "__main__":
    make_tupac_thumbnail()
    make_prince_thumbnail()
