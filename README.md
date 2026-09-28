# Sistema de Detección y Clasificación del Estado de Huevos (YOLO11)

Sistema end-to-end de Visión por Computadora para la detección y clasificación del estado físico de huevos (limpio, sucio, agrietado/roto, etc.) mediante el modelo **YOLO11**, expuesto a través de una API de inferencia en **FastAPI** / **Flask** y desplegado en infraestructura cloud (**AWS EC2**).

---

## Características Principales

- **Detección en Tiempo Real:** Identificación de la condición del huevo a partir de imágenes o transmisiones de cámara.
- **Modelo de Última Generación:** Entrenado con la arquitectura **YOLO11** (Ultralytics) adaptada a dataset especializado de Kaggle.
- **API REST:** Endpoint backend de alta eficiencia para procesar solicitudes HTTP POST con imágenes y retornar bounding boxes y clasificaciones con su porcentaje de confianza.
- **Despliegue Cloud:** Servidor alojado en una instancia AWS EC2 optimizado para inferencias de baja latencia.

---

## Requisitos Previos

-Python: 3.9 o superior
-Entorno Virtual: venv o conda.
-GPU (Opcional): Compatible con CUDA para inferencia acelerada por hardware.

---

## 📂 Estructura del Proyecto

```bash
Detecci-n-de-Huevos/
├── backend/
│   ├── app.py              # API REST en Flask para inferencias de YOLO
│   └── best.pt             # Pesos entrenados del modelo YOLO11
├── app/
│   ├── App.js              # Componente principal de React Native
│   ├── app.json            # Configuración de Expo
│   ├── index.js            # Punto de entrada de la aplicación móvil
│   ├── package.json        # Dependencias de Node.js / React Native
│   └── package-lock.json   # Árbol de dependencias bloqueado
├── .gitignore
├── AGENTS.md
├── CLAUDE.md
├── LICENSE
└── README.md
