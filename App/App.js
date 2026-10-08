import React, { useState, useRef, useEffect } from 'react';
import {
  StyleSheet, Text, View, Button, ActivityIndicator,
  Image, ScrollView, TouchableOpacity, Animated, Easing,
  TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';

// La IP se pide al abrir la app. Este valor solo aparece como sugerencia inicial.
const IP_POR_DEFECTO = '98.89.22.92';
const PUERTO = 8080;
const INTERVALO_MS = 1500;   // espera antes de capturar el siguiente huevo
const RESULTADO_MS = 2500;   // tiempo que se muestra el resultado
const TIMEOUT_MS = 10000;
const ZONA = 200;            // lado (px) del cuadro guía (mismo tamaño de antes)
const RECORTAR = true;       // true: envía solo lo que hay dentro del cuadro; false: envía la foto completa como antes

const C = {
  bg: '#14110f', panel: '#1f1a17', linea: '#3a322d', texto: '#f3ece4',
  suave: '#a99d92', ok: '#3fbf7f', mal: '#e5484d', aviso: '#f5a524',
};

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);
  const scanningRef = useRef(false);

  // Conexión al servidor (EC2)
  const [ipInput, setIpInput] = useState(IP_POR_DEFECTO);
  const [servidor, setServidor] = useState(null);   // ej: "http://1.2.3.4:8080" cuando ya está conectado
  const [conectando, setConectando] = useState(false);
  const [errorIP, setErrorIP] = useState('');
  const [camSize, setCamSize] = useState(null); // tamaño del preview en pantalla

  const [tab, setTab] = useState('inspeccion');
  const [isScanning, setIsScanning] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [msg, setMsg] = useState('Sistema listo. Inicia la banda.');
  const [ultimo, setUltimo] = useState(null); // { uri, w, h, insp }
  const [historial, setHistorial] = useState([]);
  const [stats, setStats] = useState({
    a: 0, b: 0, esperando: 0, errores: 0, sumaConf: 0, sumaMs: 0, n: 0, inicio: null,
  });

  const eggX = useRef(new Animated.Value(0)).current;
  const eggY = useRef(new Animated.Value(0)).current;

  useEffect(() => { scanningRef.current = isScanning; }, [isScanning]);

  const construirUrl = (texto) => {
    let host = texto.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!host) return null;
    if (!host.includes(':')) host = `${host}:${PUERTO}`;
    return `http://${host}`;
  };

  // Comprueba que el servidor responde en /health antes de entrar
  const conectar = async () => {
    const url = construirUrl(ipInput);
    if (!url) { setErrorIP('Escribe la IP del servidor.'); return; }
    setConectando(true);
    setErrorIP('');
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 6000);
    try {
      const resp = await fetch(`${url}/health`, { signal: controller.signal });
      const json = await resp.json();
      if (json.status !== 'ok') throw new Error('Respuesta inesperada');
      setServidor(url);
      setMsg('Sistema listo. Inicia la banda.');
    } catch (e) {
      setErrorIP(e.name === 'AbortError'
        ? 'El servidor no respondió en 6 segundos. Revisa la IP, que la instancia esté encendida y que el puerto 8080 esté abierto.'
        : 'No se pudo conectar. Revisa la IP y que app.py esté corriendo en la instancia.');
    } finally {
      clearTimeout(to);
      setConectando(false);
    }
  };

  const cambiarIP = () => {
    setIsScanning(false);
    setServidor(null);
    setErrorIP('');
  };

  // Ciclo automático de la banda
  useEffect(() => {
    let id;
    if (isScanning && !isProcessing) {
      id = setTimeout(captureAndAnalyze, INTERVALO_MS);
    }
    return () => clearTimeout(id);
  }, [isScanning, isProcessing]);

  const animarHuevo = (ruta) => {
    eggX.setValue(0); eggY.setValue(0);
    const destinoX = ruta === 'A' ? -70 : ruta === 'B' ? 70 : 0;
    Animated.sequence([
      Animated.timing(eggY, { toValue: 1, duration: 350, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(eggX, { toValue: destinoX, duration: 450, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
  };

  const registrar = (insp, ms) => {
    const rutaLetra = insp.ruta === 'RUTA A' ? 'A' : insp.ruta === 'RUTA B' ? 'B' : null;
    setStats((s) => ({
      ...s,
      inicio: s.inicio || Date.now(),
      a: s.a + (rutaLetra === 'A' ? 1 : 0),
      b: s.b + (rutaLetra === 'B' ? 1 : 0),
      esperando: s.esperando + (rutaLetra ? 0 : 1),
      sumaConf: s.sumaConf + (rutaLetra ? insp.confianza || 0 : 0),
      n: s.n + (rutaLetra ? 1 : 0),
      sumaMs: s.sumaMs + ms,
    }));
    setHistorial((h) => [
      { hora: new Date().toLocaleTimeString(), ruta: rutaLetra, conf: insp.confianza || 0 },
      ...h,
    ].slice(0, 15));
    return rutaLetra;
  };

  const captureAndAnalyze = async () => {
    if (!cameraRef.current) return;
    setIsProcessing(true);
    setMsg('📸 Capturando y enviando a AWS...');

    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.7 });

      // Recorta el centro de la foto para que coincida con el cuadro amarillo.
      // El preview usa "cover", así que la escala es la mayor de las dos proporciones.
      const escala = camSize ? Math.max(camSize.w / photo.width, camSize.h / photo.height) : 1;
      const lado = Math.round(camSize
        ? Math.min(ZONA / escala, photo.width, photo.height)
        : Math.min(photo.width, photo.height));
      const recorte = {
        crop: {
          originX: Math.round((photo.width - lado) / 2),
          originY: Math.round((photo.height - lado) / 2),
          width: lado,
          height: lado,
        },
      };

      // Luego 640 px (el modelo se entrenó a 640)
      const img = await ImageManipulator.manipulateAsync(
        photo.uri, RECORTAR ? [recorte, { resize: { width: 640 } }] : [{ resize: { width: 640 } }],
        { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );

      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const t0 = Date.now();

      const response = await fetch(`${servidor}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: img.base64 }),
        signal: controller.signal,
      });
      clearTimeout(to);

      const json = await response.json();
      if (!json.inspeccion) throw new Error(json.error || 'Respuesta inválida');
      const insp = json.inspeccion;
      const ms = Date.now() - t0;

      const letra = registrar(insp, ms);
      animarHuevo(letra);
      setUltimo({ uri: img.uri, w: img.width, h: img.height, insp, ms });
      setMsg(`${insp.estado}\nConfianza: ${insp.confianza != null ? Math.round(insp.confianza * 100) + '%' : '—'} | ${insp.ruta}`);
    } catch (e) {
      setStats((s) => ({ ...s, errores: s.errores + 1 }));
      setMsg(e.name === 'AbortError'
        ? '⏳ AWS no respondió. Toca 📡 arriba para revisar o cambiar la IP.'
        : '❌ Error de red. Toca 📡 arriba para revisar o cambiar la IP.');
    } finally {
      setTimeout(() => {
        if (scanningRef.current) setMsg('Acomodando siguiente huevo...');
        setIsProcessing(false);
      }, RESULTADO_MS);
    }
  };

  const reiniciarStats = () => {
    setStats({ a: 0, b: 0, esperando: 0, errores: 0, sumaConf: 0, sumaMs: 0, n: 0, inicio: null });
    setHistorial([]);
  };

  // Pantalla inicial: pedir la IP del servidor
  if (!servidor) {
    return (
      <KeyboardAvoidingView
        style={[st.container, { justifyContent: 'center', padding: 24 }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Text style={st.ipTitulo}>Conectar al servidor</Text>
        <Text style={st.ipAyuda}>
          Escribe la IP pública de la instancia EC2. Si la apagaste y la volviste a encender, la IP puede haber cambiado.
        </Text>
        <TextInput
          style={st.ipInput}
          value={ipInput}
          onChangeText={setIpInput}
          placeholder="Ej: 98.89.22.92"
          placeholderTextColor={C.suave}
          keyboardType="numbers-and-punctuation"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!conectando}
          onSubmitEditing={conectar}
        />
        <Text style={st.nota}>Puerto {PUERTO} por defecto. También puedes escribir IP:puerto.</Text>
        {!!errorIP && <Text style={st.ipError}>{errorIP}</Text>}
        <View style={{ marginTop: 16 }}>
          {conectando
            ? <ActivityIndicator size="large" color={C.aviso} />
            : <Button title="Conectar" onPress={conectar} color="#28a745" />}
        </View>
      </KeyboardAvoidingView>
    );
  }

  if (!permission) return <View />;
  if (!permission.granted) {
    return (
      <View style={[st.container, { justifyContent: 'center', padding: 20 }]}>
        <Text style={{ color: C.texto, textAlign: 'center', marginBottom: 10 }}>Permite el acceso a la cámara</Text>
        <Button onPress={requestPermission} title="Otorgar permiso" />
      </View>
    );
  }

  const ruta = ultimo?.insp?.ruta;
  const esA = ruta === 'RUTA A';
  const esB = ruta === 'RUTA B';
  const total = stats.a + stats.b;

  return (
    <View style={st.container}>
      <View style={st.header}>
        <Text style={st.titulo}>Inspección de huevos · YOLO11</Text>
        <TouchableOpacity onPress={cambiarIP} style={st.ipChip}>
          <Text style={st.ipChipTxt}>📡 {servidor.replace('http://', '')}</Text>
        </TouchableOpacity>
      </View>

      {tab === 'inspeccion' ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 16 }}>
          {/* Cámara */}
          <View
            style={st.cameraContainer}
            onLayout={(e) => setCamSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
          >
            <CameraView style={st.camera} facing="back" ref={cameraRef} />
            <View style={[st.targetBox, { width: ZONA, height: ZONA }]}>
              <Text style={st.targetText}>Zona de inspección</Text>
            </View>
          </View>

          <View style={st.controls}>
            <Button
              title={isScanning ? '🛑 Detener banda' : '▶️ Iniciar inspección'}
              onPress={() => setIsScanning(!isScanning)}
              color={isScanning ? C.mal : '#28a745'}
              disabled={isProcessing && !isScanning}
            />
          </View>

          {/* Resultado */}
          <View style={[st.panel, { borderColor: esB ? C.mal : esA ? C.ok : C.linea }]}>
            {isProcessing && msg.includes('Capturando') && (
              <ActivityIndicator size="small" color={C.aviso} style={{ marginBottom: 6 }} />
            )}
            <Text style={st.resultado}>{msg}</Text>
          </View>

          {/* Confianza y calidad */}
          {ultimo && (
            <View style={st.panel}>
              <Text style={st.sub}>Confianza del modelo</Text>
              <Barra valor={ultimo.insp.confianza || 0} color={esB ? C.mal : C.ok} />
              <Text style={st.sub}>Índice de calidad (estimado)</Text>
              <Barra valor={parseFloat(ultimo.insp.calidad) / 100 || 0} color={C.aviso} />
              <Text style={st.nota}>
                El índice se calcula a partir de la confianza del modelo; no es una medición física del huevo.
                Latencia: {ultimo.ms} ms
              </Text>
            </View>
          )}

          {/* Todas las detecciones (para diagnosticar) */}
          {ultimo && (
            <View style={st.panel}>
              <Text style={st.sub}>Detecciones del modelo</Text>
              {(ultimo.insp.detecciones || []).length === 0 && <Text style={st.nota}>Ninguna</Text>}
              {(ultimo.insp.detecciones || []).map((d, i) => (
                <Text key={i} style={st.filaTxt}>
                  {['b', 'damaged'].includes(d.clase.toLowerCase()) ? '🔴 Dañado' : '🟢 Normal'}: {Math.round(d.confianza * 100)}%
                </Text>
              ))}
            </View>
          )}

          {/* Foto con cajas */}
          {ultimo && (
            <View style={st.panel}>
              <Text style={st.sub}>Dónde detectó el problema</Text>
              <View style={{ width: '100%', aspectRatio: ultimo.w / ultimo.h }}>
                <Image source={{ uri: ultimo.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
                {(ultimo.insp.detecciones || []).map((d, i) => {
                  const danado = ['b', 'damaged'].includes(d.clase.toLowerCase()) || ultimo.insp.ruta === 'RUTA B';
                  const [x1, y1, x2, y2] = d.bbox;
                  return (
                    <View
                      key={i}
                      style={{
                        position: 'absolute',
                        left: `${(x1 / ultimo.w) * 100}%`,
                        top: `${(y1 / ultimo.h) * 100}%`,
                        width: `${((x2 - x1) / ultimo.w) * 100}%`,
                        height: `${((y2 - y1) / ultimo.h) * 100}%`,
                        borderWidth: 3,
                        borderColor: danado ? C.mal : C.ok,
                      }}
                    >
                      <Text style={[st.etiqueta, { backgroundColor: danado ? C.mal : C.ok }]}>
                        {danado ? 'Dañado' : 'Normal'}{['b', 'damaged'].includes(d.clase.toLowerCase()) || !danado ? ` ${Math.round(d.confianza * 100)}%` : ''}
                      </Text>
                    </View>
                  );
                })}
                {(ultimo.insp.zonas_sospechosas || []).map((z, i) => {
                  const [x1, y1, x2, y2] = z.bbox;
                  return (
                    <View
                      key={`z${i}`}
                      style={{
                        position: 'absolute',
                        left: `${(x1 / ultimo.w) * 100}%`,
                        top: `${(y1 / ultimo.h) * 100}%`,
                        width: `${((x2 - x1) / ultimo.w) * 100}%`,
                        height: `${((y2 - y1) / ultimo.h) * 100}%`,
                        borderWidth: 2,
                        borderColor: C.aviso,
                        borderRadius: 999,
                        backgroundColor: 'rgba(245,165,36,0.25)',
                      }}
                    />
                  );
                })}
              </View>
              {(ultimo.insp.zonas_sospechosas || []).length > 0 && (
                <Text style={st.nota}>
                  🟠 Zona sospechosa de grieta (estimada con análisis de imagen, no la detecta el modelo).
                </Text>
              )}
              {ultimo.insp.ruta === 'RUTA B' && (ultimo.insp.zonas_sospechosas || []).length === 0 && (
                <Text style={st.nota}>
                  El modelo marcó el huevo como dañado, pero no se pudo aislar la grieta.
                </Text>
              )}
              {(ultimo.insp.detecciones || []).length === 0 && (
                <Text style={st.nota}>No se detectó ningún huevo en la foto.</Text>
              )}
            </View>
          )}

          {/* Simulación de la banda */}
          <View style={st.panel}>
            <Text style={st.sub}>Simulación de la banda</Text>
            <View style={st.sim}>
              <View style={st.simHuevoZona}>
                <Animated.Text
                  style={{
                    fontSize: 30,
                    transform: [
                      { translateX: eggX },
                      { translateY: eggY.interpolate({ inputRange: [0, 1], outputRange: [0, 34] }) },
                    ],
                  }}
                >🥚</Animated.Text>
              </View>
              <View style={st.simYolo}><Text style={st.simYoloTxt}>YOLO11</Text></View>
              <View style={st.simRamas}>
                <View style={[st.rama, esA && { backgroundColor: C.ok, borderColor: C.ok }]}>
                  <Text style={st.ramaTxt}>🟢 Bueno</Text>
                  <Text style={st.ramaRuta}>Ruta A</Text>
                </View>
                <View style={[st.rama, esB && { backgroundColor: C.mal, borderColor: C.mal }]}>
                  <Text style={st.ramaTxt}>🔴 Dañado</Text>
                  <Text style={st.ramaRuta}>Ruta B</Text>
                </View>
              </View>
            </View>
          </View>
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 12 }}>
          <View style={st.grid}>
            <Tarjeta titulo="Inspeccionados" valor={total} />
            <Tarjeta titulo="Ruta A (buenos)" valor={stats.a} color={C.ok} />
            <Tarjeta titulo="Ruta B (dañados)" valor={stats.b} color={C.mal} />
            <Tarjeta titulo="% dañados" valor={total ? `${((stats.b / total) * 100).toFixed(1)}%` : '0%'} color={C.aviso} />
            <Tarjeta titulo="Confianza media" valor={stats.n ? `${((stats.sumaConf / stats.n) * 100).toFixed(1)}%` : '0%'} />
            <Tarjeta
              titulo="Latencia media"
              valor={total + stats.esperando ? `${Math.round(stats.sumaMs / (total + stats.esperando))} ms` : '0 ms'}
            />
            <Tarjeta
              titulo="Huevos por minuto"
              valor={stats.inicio && total ? (total / Math.max((Date.now() - stats.inicio) / 60000, 0.1)).toFixed(1) : '0'}
            />
            <Tarjeta titulo="Sin huevo / errores" valor={`${stats.esperando} / ${stats.errores}`} />
          </View>

          <View style={st.panel}>
            <Text style={st.sub}>Proporción A vs B</Text>
            <View style={st.barraDoble}>
              <View style={{ flex: stats.a || 0.0001, backgroundColor: C.ok }} />
              <View style={{ flex: stats.b || 0.0001, backgroundColor: C.mal }} />
            </View>
          </View>

          <View style={st.panel}>
            <Text style={st.sub}>Últimas inspecciones</Text>
            {historial.length === 0 && <Text style={st.nota}>Aún no hay inspecciones.</Text>}
            {historial.map((h, i) => (
              <View key={i} style={st.fila}>
                <Text style={st.filaTxt}>{h.hora}</Text>
                <Text style={[st.filaTxt, { color: h.ruta === 'B' ? C.mal : h.ruta === 'A' ? C.ok : C.suave }]}>
                  {h.ruta ? `Ruta ${h.ruta}` : 'Sin huevo'}
                </Text>
                <Text style={st.filaTxt}>{Math.round(h.conf * 100)}%</Text>
              </View>
            ))}
          </View>

          <Button title="Reiniciar estadísticas" onPress={reiniciarStats} color={C.mal} />
        </ScrollView>
      )}

      {/* Pestañas */}
      <View style={st.tabs}>
        <TouchableOpacity style={st.tab} onPress={() => setTab('inspeccion')}>
          <Text style={[st.tabTxt, tab === 'inspeccion' && st.tabActivo]}>🥚 Inspección</Text>
        </TouchableOpacity>
        <TouchableOpacity style={st.tab} onPress={() => setTab('stats')}>
          <Text style={[st.tabTxt, tab === 'stats' && st.tabActivo]}>📊 Producción</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Barra({ valor, color }) {
  const pct = Math.max(0, Math.min(1, valor)) * 100;
  return (
    <View style={st.barraFondo}>
      <View style={[st.barraRelleno, { width: `${pct}%`, backgroundColor: color }]} />
      <Text style={st.barraTxt}>{pct.toFixed(1)}%</Text>
    </View>
  );
}

function Tarjeta({ titulo, valor, color }) {
  return (
    <View style={st.tarjeta}>
      <Text style={[st.tarjetaValor, color && { color }]}>{valor}</Text>
      <Text style={st.tarjetaTitulo}>{titulo}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: { paddingTop: 44, paddingBottom: 10, paddingHorizontal: 14, backgroundColor: C.panel, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  ipChip: { borderWidth: 1, borderColor: C.linea, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  ipChipTxt: { color: C.suave, fontSize: 12 },
  ipTitulo: { color: C.texto, fontSize: 22, fontWeight: 'bold', marginBottom: 8 },
  ipAyuda: { color: C.suave, fontSize: 14, marginBottom: 16 },
  ipInput: { backgroundColor: C.panel, color: C.texto, borderColor: C.linea, borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 18 },
  ipError: { color: C.mal, fontSize: 13, marginTop: 10 },
  titulo: { color: C.texto, fontSize: 17, fontWeight: 'bold' },
  cameraContainer: { height: 300, justifyContent: 'center', alignItems: 'center' },
  camera: { width: '100%', height: '100%', position: 'absolute' },
  targetBox: { width: 200, height: 200, borderWidth: 2, borderColor: 'rgba(255,255,0,0.6)', borderStyle: 'dashed', alignItems: 'center' },
  targetText: { color: 'yellow', backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 5, marginTop: 5, fontSize: 12 },
  controls: { padding: 12 },
  panel: { backgroundColor: C.panel, borderColor: C.linea, borderWidth: 1, borderRadius: 10, marginHorizontal: 12, marginBottom: 10, padding: 12 },
  resultado: { color: C.texto, fontSize: 18, fontWeight: 'bold', textAlign: 'center' },
  sub: { color: C.suave, fontSize: 13, marginBottom: 6, marginTop: 4 },
  nota: { color: C.suave, fontSize: 12, marginTop: 8 },
  barraFondo: { height: 22, backgroundColor: C.bg, borderRadius: 6, overflow: 'hidden', justifyContent: 'center', marginBottom: 6 },
  barraRelleno: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  barraTxt: { color: '#fff', fontWeight: 'bold', textAlign: 'center', fontSize: 12 },
  etiqueta: { color: '#fff', fontSize: 11, fontWeight: 'bold', alignSelf: 'flex-start', paddingHorizontal: 4, marginTop: -18 },
  sim: { alignItems: 'center' },
  simHuevoZona: { height: 74, justifyContent: 'flex-start', alignItems: 'center' },
  simYolo: { backgroundColor: '#2c4a7c', paddingVertical: 8, paddingHorizontal: 26, borderRadius: 8 },
  simYoloTxt: { color: '#fff', fontWeight: 'bold' },
  simRamas: { flexDirection: 'row', gap: 16, marginTop: 14 },
  rama: { borderWidth: 2, borderColor: C.linea, borderRadius: 8, padding: 10, width: 120, alignItems: 'center' },
  ramaTxt: { color: C.texto, fontWeight: 'bold' },
  ramaRuta: { color: C.texto, fontSize: 12, marginTop: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  tarjeta: { width: '48%', backgroundColor: C.panel, borderColor: C.linea, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 10 },
  tarjetaValor: { color: C.texto, fontSize: 24, fontWeight: 'bold' },
  tarjetaTitulo: { color: C.suave, fontSize: 12, marginTop: 2 },
  barraDoble: { flexDirection: 'row', height: 18, borderRadius: 6, overflow: 'hidden' },
  fila: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.linea },
  filaTxt: { color: C.texto, fontSize: 13 },
  tabs: { flexDirection: 'row', backgroundColor: C.panel, borderTopWidth: 1, borderTopColor: C.linea, paddingBottom: 18 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  tabTxt: { color: C.suave, fontSize: 14 },
  tabActivo: { color: C.texto, fontWeight: 'bold' },
});
