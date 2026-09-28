from flask import Flask, request, jsonify
from ultralytics import YOLO
import cv2
import numpy as np
import base64
import os
import time

app = Flask(__name__)

model = YOLO('best.pt')
print("Modelo cargado. Tarea:", model.task, "| Clases:", model.names)

CONF_MINIMA = 0.25
LARGO_MIN = 0.12           
SENSIBILIDAD_OSCURO = 15   
SENSIBILIDAD_COLOR = 28    
MARGEN_CAJA = 0.08         
VERSION = 'v3-rayas'
RESPALDO_LINEAS = True   
GUARDAR_DEBUG = True   
CONF_DANADO = 0.30   
CLASES_DANADAS = {'b', 'damaged'}
CLASES_BUENAS = {'a', 'normal'}


def iou(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(ix2 - ix1, 0) * max(iy2 - iy1, 0)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0


def decodificar_imagen(b64):
    if ',' in b64[:100]:
        b64 = b64.split(',', 1)[1]
    nparr = np.frombuffer(base64.b64decode(b64), np.uint8)
    return cv2.imdecode(nparr, cv2.IMREAD_COLOR)


def zonas_sospechosas(img, bbox, max_zonas=3, debug=None):
    x1, y1, x2, y2 = [int(v) for v in bbox]
    mx, my = int((x2 - x1) * MARGEN_CAJA), int((y2 - y1) * MARGEN_CAJA)
    x1, y1, x2, y2 = max(x1 - mx, 0), max(y1 - my, 0), min(x2 + mx, w), min(y2 + my, h)
    crop = img[y1:y2, x1:x2]
    if crop.size == 0:
        return []
    ch, cw = crop.shape[:2]
    lado = min(cw, ch)

    blur = cv2.GaussianBlur(crop, (5, 5), 0)

    # Zona interior del huevo (evita sombras del borde)
    interior = np.zeros((ch, cw), np.uint8)
    cv2.ellipse(interior, (cw // 2, ch // 2), (int(cw * 0.42), int(ch * 0.42)), 0, 0, 360, 255, -1)

    # A) Líneas oscuras y finas (blackhat)
    gris = cv2.cvtColor(blur, cv2.COLOR_BGR2GRAY)
    k = max(9, int(lado * 0.06)) | 1
    realce = cv2.morphologyEx(gris, cv2.MORPH_BLACKHAT,
                              cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    tA, _ = cv2.threshold(realce, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bin_a = (realce > max(tA, SENSIBILIDAD_OSCURO)).astype(np.uint8) * 255

    # B) Diferencia con el color típico de la cáscara (detecta también rojo/azul)
    lab = cv2.cvtColor(blur, cv2.COLOR_BGR2LAB).astype(np.float32)
    dentro = interior > 0
    med = np.median(lab[dentro], axis=0)
    oscuro = med[0] - lab[:, :, 0]                       # positivo si es más oscuro que la cáscara
    croma = np.hypot(lab[:, :, 1] - med[1], lab[:, :, 2] - med[2])
    puntaje = np.maximum(oscuro, croma * 1.5)
    p = puntaje[dentro]
    mediana = np.median(p)
    mad = np.median(np.abs(p - mediana)) * 1.4826
    umbral = max(mediana + 6 * mad, SENSIBILIDAD_COLOR)
    bin_b = (puntaje > umbral).astype(np.uint8) * 255

    binaria = cv2.bitwise_and(cv2.bitwise_or(bin_a, bin_b), interior)
    binaria = cv2.morphologyEx(binaria, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))  # une trazos cortados

    contornos, _ = cv2.findContours(binaria, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    candidatos = []
    largo_min = LARGO_MIN * max(cw, ch)
    for c in contornos:
        largo = cv2.arcLength(c, True) / 2
        if largo < largo_min:
            continue
        grosor = cv2.contourArea(c) / max(largo, 1)
        if grosor > 0.10 * lado:          # manchas anchas o sombras: no son rayas
            continue
        bx, by, bw, bh = cv2.boundingRect(c)
        pad = 6
        candidatos.append({
            'bbox': [x1 + max(bx - pad, 0), y1 + max(by - pad, 0),
                     x1 + min(bx + bw + pad, cw), y1 + min(by + bh + pad, ch)],
            'largo': largo,
        })

    if debug is not None:
        debug.append((x1, y1, binaria))

    candidatos.sort(key=lambda z: z['largo'], reverse=True)
    return [{'bbox': [round(float(v), 1) for v in z['bbox']]} for z in candidatos[:max_zonas]]


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'clases': model.names, 'version': VERSION,
                    'respaldo_lineas': RESPALDO_LINEAS})


@app.route('/predict', methods=['POST'])
def predict():
    data = request.get_json(silent=True)
    if not data or 'image' not in data:
        return jsonify({'error': 'No se recibió imagen'}), 400

    try:
        img = decodificar_imagen(data['image'])
        if img is None:
            return jsonify({'error': 'Imagen inválida o corrupta'}), 400

        r = model.predict(img, conf=CONF_MINIMA, imgsz=640, verbose=False)[0]

        detecciones = []
        for box in r.boxes:
            detecciones.append({
                'clase': r.names[int(box.cls)],
                'confianza': round(float(box.conf), 3),
                'bbox': [round(v, 1) for v in box.xyxy[0].tolist()],
            })

        if not detecciones:
            return jsonify({'status': 'success', 'inspeccion': {
                'estado': '⏳ UBICANDO HUEVO', 'ruta': 'ESPERANDO', 'calidad': '0.0%',
                'confianza': 0.0, 'detecciones': [], 'zonas_sospechosas': []}})

        print("Detecciones:", [(d['clase'], d['confianza']) for d in detecciones])

        buenos = [d for d in detecciones if d['clase'].lower() in CLASES_BUENAS]

        # Criterio original: cualquier "dañado" con confianza suficiente manda a B
        danados = [d for d in detecciones
                   if d['clase'].lower() in CLASES_DANADAS and d['confianza'] >= CONF_DANADO]
        zonas = []
        mascaras = []

        if danados:
            mejor = max(danados, key=lambda d: d['confianza'])
            estado, ruta = '❌ DAÑADO', 'RUTA B'
            confianza = mejor['confianza']
            calidad = round((1 - confianza) * 100, 1)
            for d in danados:
                zonas += zonas_sospechosas(img, d['bbox'])
        elif buenos:
            mejor = max(buenos, key=lambda d: d['confianza'])
            estado, ruta = '✅ BUEN ESTADO', 'RUTA A'
            confianza = mejor['confianza']
            calidad = round(confianza * 100, 1)
            if RESPALDO_LINEAS:
                for b in buenos:
                    zonas += zonas_sospechosas(img, b['bbox'], debug=mascaras)
                if zonas:
                    estado, ruta = '❌ DAÑADO', 'RUTA B'
                    # No se inventa un porcentaje: se usa el del modelo para "dañado"
                    # si existe; si no, queda sin valor
                    conf_dan = [d['confianza'] for d in detecciones
                                if d['clase'].lower() in CLASES_DANADAS]
                    confianza = max(conf_dan) if conf_dan else None
                    calidad = round((1 - confianza) * 100, 1) if confianza is not None else None
        else:
            estado, ruta = '⏳ UBICANDO HUEVO', 'ESPERANDO'
            confianza, calidad = 0.0, 0.0

        print(f"{estado} | {ruta} | conf={confianza} | zonas={len(zonas)}")

        if GUARDAR_DEBUG:
            os.makedirs('debug', exist_ok=True)
            base = f"debug/{int(time.time() * 1000)}_{ruta.replace(' ', '')}_{confianza}"
            cv2.imwrite(base + '.jpg', img)
            # Imagen para ajustar el detector: magenta = píxeles candidatos, naranja = zonas marcadas
            vis = img.copy()
            for (ox, oy, m) in mascaras:
                zona = vis[oy:oy + m.shape[0], ox:ox + m.shape[1]]
                zona[m > 0] = (255, 0, 255)
            for z in zonas:
                zx1, zy1, zx2, zy2 = [int(v) for v in z['bbox']]
                cv2.rectangle(vis, (zx1, zy1), (zx2, zy2), (0, 165, 255), 2)
            cv2.imwrite(base + '_analisis.jpg', vis)

        return jsonify({'status': 'success', 'inspeccion': {
            'estado': estado, 'ruta': ruta,
            'calidad': f"{calidad}%" if calidad is not None else '—',
            'confianza': confianza, 'detecciones': detecciones,
            'zonas_sospechosas': zonas}})

    except Exception as e:
        print(f"Error procesando imagen: {e}")
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, threaded=True)
