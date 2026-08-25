import sys

def parse_png(filename):
    with open(filename, 'rb') as f:
        data = f.read()
    iend_idx = data.find(b'IEND')
    if iend_idx != -1:
        trailing = data[iend_idx + 8:]
        text = trailing.decode('utf-16-le', errors='ignore')
        
        current_layer = {}
        layers = {}
        for line in text.split('\n'):
            line = line.strip()
            if not line or line.startswith('ImgBmp'):
                continue
            if line.startswith('[Layer'):
                name = line[1:-1]
                current_layer = {}
                layers[name] = current_layer
            elif '=' in line:
                k, v = line.split('=', 1)
                current_layer[k] = v
                
        for name, l in layers.items():
            print(f"--- {name} ---")
            print("Primitive:", l.get('Primitive'))
            print("Color:", l.get('ColR'), l.get('ColG'), l.get('ColB'))
            print("Zoom1, Zoom2:", l.get('Zoom1'), l.get('Zoom2'))
            print("AnimAngle:", l.get('AnimateAngle'), "Angle1, Angle2:", l.get('Angle1'), l.get('Angle2'))
            print("Mask:", l.get('UseMask'), "AnimateMaskStop:", l.get('AnimateMaskStop'), l.get('MaskStop1'), l.get('MaskStop2'))
            print("Emboss:", l.get('PrimEmboss'))

parse_png('KNOB2624.knob')
