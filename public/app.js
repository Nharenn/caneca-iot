'use strict';

// La página y el servidor van juntos: server.js tiene la misma versión. Si no coinciden, se avisa arriba.
const VERSION_PAGINA = '2026-10-18.5';
// El programa de la placa que espera esta página (la calibración necesita este o uno más nuevo)
const FIRMWARE_ESPERADO = '2026-10-17.9';
// Zona sugerida para la caja de MDF (en % de la imagen)
const ZONA_SUGERIDA = { x0: 22, x1: 74, y0: 7, y1: 60 };

// Nombres de las clases: llegan del servidor (clases.json)
let NOMBRE_CLASE = { error: 'Sin respuesta de la IA' };
const CANECA = {
  blanca: { titulo: 'Caneca blanca', nota: 'Aprovechables' },
  verde: { titulo: 'Caneca verde', nota: 'Orgánicos aprovechables' },
  negra: { titulo: 'Caneca negra', nota: 'No aprovechables' },
  especial: { titulo: 'Residuos especiales', nota: 'Mejor llevarlos a un punto de recolección' },
  ninguna: { titulo: 'Bandeja vacía', nota: 'La bandeja no se mueve' },
};
// Ángulos fijos de la placa (calibrados en la caja)
const ANGULO = { aprovechables: 150, no_aprovechables: 30 };
const NOMBRE_ORIGEN = {
  auto: 'Automático (cámara)',
  boton: 'Botón Clasificar de la caneca',
  monitor: 'Desde el monitor',
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const coma = (n, dec = 1) => Number(n).toFixed(dec).replace('.', ',');
const limitar = (v, min, max) => Math.min(max, Math.max(min, v));
const LADOS_ZONA = ['x0', 'x1', 'y0', 'y1'];

const app = {
  servidor: false,
  online: false,
  versionServidor: null,
  estado: null,
  conteos: {},
  eventos: [],
  umbralCamara: null,
  zona: null,
  flashFoto: null, // % del flash en la foto para la IA (0 = sin flash)
  detalleIA: null, // 'bajo' o 'alto'
  fotoPrueba: null, // fecha de la última "Probar foto"
  calibracion: null, // la última calibración con la bandeja vacía
  referencia: null, // fecha de la foto de la bandeja vacía que usa la IA
  // Quién maneja: 'mirando' (solo ver), 'espera' (en la fila, con PIN) o 'tuyo' (tienes el control)
  control: { estado: 'mirando', puesto: 0, ocupado: false, enFila: 0, mirando: 0 },
  lados: { blanca: 'aprovechables', verde: 'no_aprovechables', negra: 'no_aprovechables', especial: 'no_aprovechables', ninguna: 'nivel' },
  clases: [],
  estadisticas: { ultimas24h: [], tiempoIA: null },
  capturas: [],
  tiposCaptura: {},
  ultimaImagen: 0,
  imagenesSegundo: 0,
  urlImagen: null,
};

const manejo = () => app.control.estado === 'tuyo';

let ws = null;
let esperaReconexion = 1000;

// ---------------------------------------------------------------------------
// Conexión con el servidor
// ---------------------------------------------------------------------------
function conectar() {
  const protocolo = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocolo}://${location.host}/ws/monitor`);
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    esperaReconexion = 1000;
    app.servidor = true;
    pintarConexion();
    // Si tenías el control y se cayó la conexión (o recargaste), lo vuelve a pedir con el mismo PIN
    const pin = leerSesion('pin-caneca');
    if (pin && leerSesion('control-caneca') === '1') mandar({ t: 'pedirControl', pin });
    depurarEnviado = false;
    actualizarDepurar();
  });

  ws.addEventListener('close', () => {
    app.servidor = false;
    app.online = false;
    pintarConexion();
    setTimeout(conectar, esperaReconexion);
    esperaReconexion = Math.min(esperaReconexion * 2, 15000);
  });

  ws.addEventListener('message', (evento) => {
    if (typeof evento.data !== 'string') {
      const bytes = new Uint8Array(evento.data);
      if (bytes[0] === 0x44) recibirCuadro(bytes); // 'D': miniaturas de la calibración
      else mostrarImagen(evento.data); // JPEG en vivo
      return;
    }
    let mensaje;
    try {
      mensaje = JSON.parse(evento.data);
    } catch {
      return;
    }
    manejar(mensaje);
  });
}

function manejar(m) {
  switch (m.t) {
    case 'resumen': {
      app.versionServidor = m.version || null;
      app.online = m.online;
      app.estado = m.estado;
      app.conteos = m.conteos || {};
      app.eventos = m.eventos || [];
      app.capturas = m.capturas || [];
      app.tiposCaptura = m.tiposCaptura || app.tiposCaptura;
      if (m.lados) app.lados = m.lados;
      if (m.estadisticas) app.estadisticas = m.estadisticas;
      if (m.clases) {
        app.clases = m.clases;
        NOMBRE_CLASE = { error: 'Sin respuesta de la IA', ...Object.fromEntries(m.clases.map((c) => [c.id, c.nombre])) };
      }
      app.calibracion = m.calibracion || null;
      app.referencia = m.referencia || null;
      app.flashFoto = m.flashFoto ?? app.flashFoto;
      app.detalleIA = m.detalleIA ?? app.detalleIA;
      app.fotoPrueba = m.fotoPrueba || app.fotoPrueba;
      recibirAjustes(m.umbralCamara ?? app.umbralCamara, m.zona || app.zona);
      pintarTodo();
      break;
    }
    case 'online':
      app.online = m.valor;
      pintarConexion();
      pintarControl();
      break;
    case 'estado':
      app.estado = m.estado;
      pintarEstado();
      break;
    case 'evento':
      app.eventos = [m.evento, ...app.eventos].slice(0, 30);
      app.conteos = m.conteos || app.conteos;
      if (m.estadisticas) app.estadisticas = m.estadisticas;
      pintarConteos();
      pintarHistorial();
      pintarUltima();
      break;
    case 'ajustes':
      app.flashFoto = m.flashFoto ?? app.flashFoto;
      app.detalleIA = m.detalleIA ?? app.detalleIA;
      recibirAjustes(m.umbralCamara, m.zona);
      cal.historia = []; // los % cambian con la zona nueva
      pintarEstado();
      pintarCal();
      break;
    case 'control':
      app.control = m;
      // recordar si manejabas o esperabas, para volver a pedirlo si se cae la conexión
      guardarSesion('control-caneca', m.estado === 'mirando' ? null : '1');
      pintarControl();
      pintarConexion();
      break;
    case 'depuracion':
      recibirNumeros(m);
      break;
    case 'capturas':
      app.capturas = m.lista || [];
      break;
    case 'calibracion':
      app.calibracion = m.calibracion;
      dep.calibrando = 0;
      pintarCal();
      avisar('Calibración lista: la caneca ya conoce su bandeja vacía.', 'ok');
      break;
    case 'referencia':
      app.referencia = m.fecha;
      pintarCal();
      break;
    case 'fotoPrueba':
      app.fotoPrueba = m.fecha;
      dep.probando = 0;
      pintarFotoIA();
      break;
    case 'eventoActualizado': {
      // una clasificación que revisaron
      const i = app.eventos.findIndex((e) => e.id === m.evento.id);
      if (i >= 0) app.eventos[i] = m.evento;
      if (m.estadisticas) app.estadisticas = m.estadisticas;
      pintarHistorial();
      pintarPrecision();
      break;
    }
    case 'ok':
      avisar(m.msg, 'ok');
      break;
    case 'error':
      avisar(m.msg, 'error');
      if (/PIN/i.test(m.msg || '')) marcarPinMalo();
      break;
    default:
      break;
  }
}

function mandar(mensaje) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    avisar('No hay conexión con el servidor. Espera a que vuelva (arriba dice cuándo).', 'error');
    return false;
  }
  ws.send(JSON.stringify(mensaje));
  return true;
}

// sessionStorage puede fallar (ventana privada, previsualización): sin él solo no se recuerda el PIN
function leerSesion(clave) {
  try {
    return sessionStorage.getItem(clave);
  } catch {
    return null;
  }
}
function guardarSesion(clave, valor) {
  try {
    if (valor === null) sessionStorage.removeItem(clave);
    else sessionStorage.setItem(clave, valor);
  } catch {
    /* sin almacenamiento */
  }
}

// ---------------------------------------------------------------------------
// Pestañas
// ---------------------------------------------------------------------------
const PANELES = ['vivo', 'calibrar', 'analisis', 'historial'];
let panelActual = 'vivo';

function mostrarPanel(nombre, { enfocar = false, subir = true } = {}) {
  if (!PANELES.includes(nombre)) nombre = 'vivo';
  const cambio = nombre !== panelActual;
  panelActual = nombre;
  for (const p of PANELES) {
    const activo = p === nombre;
    const tab = $(`#tab-${p}`);
    tab.setAttribute('aria-selected', String(activo));
    tab.tabIndex = activo ? 0 : -1;
    $(`#panel-${p}`).hidden = !activo;
  }
  if (enfocar) $(`#tab-${nombre}`).focus();
  if (location.hash !== `#${nombre}`) history.replaceState(null, '', `#${nombre}`);
  if (nombre === 'calibrar') {
    if (cambio) dep.pedidoDesde = Date.now();
    pintarCal();
  }
  if (nombre === 'analisis') pintarActividad();
  actualizarDepurar();
  if (cambio && subir) window.scrollTo(0, 0);
}

$('#pestanas').addEventListener('click', (ev) => {
  const tab = ev.target.closest('[role="tab"]');
  if (tab) mostrarPanel(tab.dataset.panel);
});

$('#pestanas').addEventListener('keydown', (ev) => {
  const i = PANELES.indexOf(panelActual);
  let j = null;
  if (ev.key === 'ArrowRight') j = (i + 1) % PANELES.length;
  else if (ev.key === 'ArrowLeft') j = (i - 1 + PANELES.length) % PANELES.length;
  else if (ev.key === 'Home') j = 0;
  else if (ev.key === 'End') j = PANELES.length - 1;
  if (j === null) return;
  ev.preventDefault();
  mostrarPanel(PANELES[j], { enfocar: true });
});

window.addEventListener('hashchange', () => mostrarPanel(location.hash.slice(1)));

// La caneca solo manda las imágenes de calibración mientras alguien tiene abierta esa pestaña
let depurarEnviado = false;
function actualizarDepurar() {
  const activo = panelActual === 'calibrar' && document.visibilityState === 'visible';
  if (activo === depurarEnviado || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ t: 'depurar', activo }));
  depurarEnviado = activo;
  if (activo) dep.pedidoDesde = Date.now();
}
document.addEventListener('visibilitychange', actualizarDepurar);

// ---------------------------------------------------------------------------
// Imagen en vivo
// ---------------------------------------------------------------------------
function mostrarImagen(buffer) {
  const url = URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }));
  const anterior = app.urlImagen;
  const img = $('#camara-img');
  img.onload = () => {
    if (anterior) URL.revokeObjectURL(anterior);
    if (panelActual === 'calibrar' && !dep.viendoCaptura) {
      pintarColorMini();
      if (dep.vista === 'color' && !dep.congelado) pintarGrande();
    }
  };
  img.src = url;
  app.urlImagen = url;
  app.ultimaImagen = Date.now();
  app.imagenesSegundo += 1;
  $('#camara').dataset.estado = 'vivo';
}

setInterval(() => {
  const vivo = Date.now() - app.ultimaImagen < 3000;
  $('#camara').dataset.estado = vivo ? 'vivo' : 'sin-imagen';
  $('#en-vivo').textContent = vivo && app.imagenesSegundo > 0 ? `En vivo, ${app.imagenesSegundo} img/s` : 'En vivo';
  app.imagenesSegundo = 0;
  if (!vivo) {
    $('#camara-vacia').textContent = !app.servidor
      ? 'Sin conexión con el servidor'
      : app.online
        ? 'Esperando imagen de la cámara'
        : 'La caneca no está conectada. Revisa que esté prendida y con Wi-Fi.';
  }
  if (panelActual === 'calibrar') pintarEstadoCal();
}, 1000);

// ---------------------------------------------------------------------------
// Pintar la página
// ---------------------------------------------------------------------------
function pintarTodo() {
  pintarVersion();
  pintarConexion();
  pintarControl();
  pintarLados();
  pintarEstado();
  pintarConteos();
  pintarHistorial();
  pintarUltima();
  pintarCal();
}

// Página y servidor de versiones distintas = casi siempre un servidor viejo que sigue prendido
function pintarVersion() {
  const aviso = $('#aviso-version');
  const igual = app.versionServidor === VERSION_PAGINA;
  aviso.hidden = !app.servidor || igual;
  aviso.textContent = igual
    ? ''
    : `El servidor tiene otra versión (${app.versionServidor || 'vieja'}) que esta página (${VERSION_PAGINA}), y por eso algunos botones pueden fallar. ` +
      'Si el servidor está en tu computador: ciérralo con Ctrl+C, ábrelo otra vez con npm start y recarga esta página. Si está en el hosting, espera un minuto a que termine de desplegar y recarga (Cmd+Shift+R en Mac, Ctrl+F5 en Windows).';
}

// Comparar versiones tipo 2026-10-17.5 (número por número)
function compararVersion(a, b) {
  const pa = String(a).split(/[-.]/).map(Number);
  const pb = String(b).split(/[-.]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
const firmwareViejo = () => !app.estado?.fw || compararVersion(app.estado.fw, FIRMWARE_ESPERADO) < 0;

// Por qué no se pueden usar los botones (o null si sí se puede)
function motivoBloqueo({ necesitaCaneca = true } = {}) {
  if (!app.servidor) return 'Sin conexión con el servidor: los botones vuelven solos cuando se conecte.';
  if (app.control.estado === 'espera') return 'Estás en la fila: los botones se activan cuando sea tu turno.';
  if (!manejo()) {
    return app.control.ocupado
      ? 'Otra persona está manejando la caneca. Puedes mirar, o escribir el PIN arriba para ponerte en la fila.'
      : 'Estás mirando. Para usar los botones, escribe el PIN arriba y toca Tomar el control.';
  }
  if (necesitaCaneca && !app.online) return 'La caneca no está conectada: los botones se activan solos cuando se conecte.';
  return null;
}

function pintarConexion() {
  const caja = $('#conexion');
  let texto;
  if (!app.servidor) {
    caja.dataset.estado = 'conectando';
    texto = 'Conectando con el servidor…';
  } else if (app.online) {
    caja.dataset.estado = 'online';
    texto = 'Caneca conectada';
  } else {
    caja.dataset.estado = 'offline';
    texto = 'Caneca sin conexión';
  }
  $('#conexion-texto').textContent = texto;
  // Los botones solo funcionan para quien tiene el control (y con la caneca conectada)
  for (const boton of $$('[data-orden]')) boton.disabled = !app.online || !manejo() || (boton.dataset.orden === 'calibrar' && Boolean(dep.calibrando));
  $('#btn-no-detecto').disabled = !app.online || !manejo();
  $('#btn-reiniciar').disabled = !manejo();
  $('#control').hidden = !app.servidor;

  const motivo = motivoBloqueo();
  $('#bloqueo').hidden = !motivo;
  $('#bloqueo').textContent = motivo || '';
  const motivoHistorial = manejo() ? null : motivoBloqueo({ necesitaCaneca: false });
  $('#historial-bloqueo').hidden = !motivoHistorial;
  $('#historial-bloqueo').textContent = motivoHistorial
    ? motivoHistorial.replace('para usar los botones', 'para marcar si la caneca acertó').replace('los botones', 'los botones para marcar')
    : '';
  pintarGuardar();
  pintarFotoIA();
  if (app.eventos.length) pintarHistorial(); // los botones de revisar dependen del control
}

function pintarControl() {
  const c = app.control;
  const caja = $('#control');
  caja.dataset.estado = c.estado;
  // cuántas personas (aparte de ti) solo miran: ni manejan ni están en la fila
  const soloMiran = Math.max(0, c.mirando - (c.ocupado ? 1 : 0) - c.enFila - (c.estado === 'mirando' ? 1 : 0));
  const otros = soloMiran ? ` ${soloMiran} ${soloMiran === 1 ? 'persona más está mirando' : 'personas más están mirando'}.` : '';
  let titulo;
  let texto;
  if (c.estado === 'tuyo') {
    titulo = 'Tienes el control';
    texto = (c.enFila ? `${c.enFila} ${c.enFila === 1 ? 'persona espera' : 'personas esperan'} su turno. ` : 'Los demás solo pueden mirar. ') +
      'Cuando termines, deja el control.' + otros;
    if (!app.online) texto = 'La caneca no está conectada: los botones se activan solos cuando se conecte. ' + texto;
  } else if (c.estado === 'espera') {
    titulo = `Estás en la fila, puesto ${c.puesto}`;
    texto = 'Otra persona está manejando la caneca. Cuando termine, el control pasa a ti solo: deja esta página abierta.' + otros;
  } else if (c.ocupado) {
    titulo = 'Otra persona está manejando la caneca';
    texto = 'Puedes mirar todo. Si escribes el PIN quedas en la fila' + (c.enFila ? ` (hay ${c.enFila} esperando)` : '') + '.' + otros;
  } else {
    titulo = 'Estás mirando';
    texto = 'Nadie está manejando la caneca. Escribe el PIN para tomar el control.' + otros;
  }
  $('#control-titulo').textContent = titulo;
  $('#control-texto').textContent = texto;
  $('#form-control').hidden = c.estado !== 'mirando';
  $('#btn-control').textContent = c.ocupado ? 'Ponerme en la fila' : 'Tomar el control';
  const soltar = $('#btn-soltar');
  soltar.hidden = c.estado === 'mirando';
  soltar.textContent = c.estado === 'tuyo' ? 'Terminar y dejar el control' : 'Salir de la fila';
}

function marcarPinMalo() {
  const caja = $('.pin');
  caja.dataset.error = 'si';
  $('#pin').select();
  setTimeout(() => delete caja.dataset.error, 1200);
}

function irAlPin() {
  $('#control').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => $('#pin').focus({ preventScroll: true }), 300);
}

// Los dos botones grandes: cada lado se llama por su caneca
const LADO_UI = {
  aprovechables: { boton: '#btn-si', destino: '#destino-si', porDefecto: 'blanca' },
  no_aprovechables: { boton: '#btn-no', destino: '#destino-no', porDefecto: 'negra' },
};

function pintarLados() {
  for (const [lado, ui] of Object.entries(LADO_UI)) {
    const canecas = Object.keys(app.lados).filter((k) => app.lados[k] === lado);
    const boton = $(ui.boton);
    const tipo = canecas.includes('blanca') ? 'blanca' : canecas.includes('negra') ? 'negra' : canecas.includes('verde') ? 'verde' : ui.porDefecto;
    for (const t of ['blanca', 'verde', 'negra']) boton.classList.toggle(`lado-${t}`, t === tipo);
    let texto = 'Sin caneca asignada';
    if (canecas.includes('verde') && canecas.includes('negra')) texto = 'Caneca negra y verde';
    else if (canecas.length) texto = canecas.map((k) => CANECA[k].titulo).join(' y ');
    $(ui.destino).textContent = `${texto}, ${ANGULO[lado]}°`;
  }
}

const NOMBRE_VACIAR = { aprovechables: 'aprovechables', no_aprovechables: 'no aprovechables' };

function textoDeteccion(e) {
  if (e.atascado) return ['Esperando que quede libre', 'Si quedó algo en la bandeja, sácalo a mano o toca Nivelar.'];
  if (e.vaciar) return ['Modo vaciar', `La bandeja está de canto hacia ${NOMBRE_VACIAR[e.vaciarLado] || 'un lado'}. Toca Nivelar al terminar.`];
  if (e.pausa) return ['En pausa', 'No clasifica sola. Toca Reanudar.'];
  if (e.mano) return ['Una mano', 'La IA vio una mano: la bandeja no se mueve hasta que la quiten.'];
  if (e.esperando && e.cam) return ['Ya se clasificó', 'Espera a que la bandeja quede libre.'];
  if (e.cam) return ['Llegó algo', 'Lo ve la cámara; la IA decide qué es.'];
  return ['Bandeja libre', 'La cámara no ve nada nuevo en la bandeja.'];
}

function pintarMedidor(relleno, raya, valor, umbral, escala) {
  $(relleno).style.width = `${limitar(valor / escala, 0, 1) * 100}%`;
  $(raya).style.left = `${limitar(umbral / escala, 0, 1) * 100}%`;
}

function pintarEstado() {
  const e = app.estado;
  if (!e) return;
  // Cámara
  const umbralCam = app.umbralCamara ?? 3;
  $('#s-cam').dataset.ve = e.cam ? 'si' : 'no';
  if (e.camPct === null || e.camPct === undefined) {
    $('#s-campct').textContent = '—';
    $('#s-cam-sub').textContent = 'Guardando la foto de la bandeja vacía…';
    pintarMedidor('#m-cam', '#m-cam-raya', 0, umbralCam, umbralCam * 3);
  } else {
    $('#s-campct').textContent = `${e.camPct} %`;
    $('#s-cam-sub').textContent = `de la zona cambió frente a la bandeja vacía. Hay residuo desde ${umbralCam} %.`;
    pintarMedidor('#m-cam', '#m-cam-raya', e.camPct, umbralCam, Math.max(10, umbralCam * 3));
  }
  // Detección y bandeja
  const [det, detSub] = textoDeteccion(e);
  $('#s-detec').textContent = det;
  $('#s-detec-sub').textContent = detSub;
  $('#s-det').dataset.ve = e.atascado ? 'alerta' : e.cam ? 'si' : 'no';
  $('#s-servo').textContent = `${e.servo}°`;
  $('#s-modo').textContent = e.servo === 90 ? 'A nivel' : e.servo >= 140 ? 'Inclinada hacia aprovechables' : e.servo <= 40 ? 'Inclinada hacia no aprovechables' : 'Moviéndose';
  $('#s-bandeja').style.transform = `rotate(${limitar((e.servo || 90) - 90, -65, 65)}deg)`;

  const calidad = e.rssi === null || e.rssi === undefined ? '' : e.rssi > -60 ? ' (buena)' : e.rssi > -72 ? ' (regular)' : ' (débil)';
  $('#s-pie').textContent =
    `Wi-Fi: ${e.rssi === null || e.rssi === undefined ? 'sin datos' : `${e.rssi} dBm${calidad}`}.` + (e.fw ? ` Programa de la caneca: ${e.fw}.` : '');
  const avisoFw = $('#aviso-fw');
  const fwViejo = app.online && firmwareViejo();
  avisoFw.hidden = !fwViejo;
  avisoFw.textContent = fwViejo
    ? `La caneca tiene un programa más viejo (${e.fw || 'sin versión'}) que el que espera esta página (${FIRMWARE_ESPERADO}). Vuelve a cargarle el programa de la carpeta Caneca3 para que la calibración funcione.`
    : '';
  const avisoCal = $('#cal-aviso-fw');
  avisoCal.hidden = !fwViejo;
  avisoCal.textContent = fwViejo
    ? `La caneca tiene el programa ${e.fw || 'sin versión'} y esta pestaña necesita el ${FIRMWARE_ESPERADO}. Con el programa viejo la foto de la bandeja vacía casi nunca se guarda (el ruido de la cámara parece movimiento), así que la cámara no compara y mover la zona o la sensibilidad no cambia nada. ` +
      'Cárgale el programa de Caneca3 › 3_codigo › esp32cam con el Arduino IDE.'
    : '';

  // La página de la caneca (Wi-Fi) también se abre desde la misma red, por su IP
  const pagina = $('#e-pagina');
  pagina.replaceChildren('Página de la caneca: ');
  if (e.ip) {
    const enlace = document.createElement('a');
    enlace.href = `http://${e.ip}/`;
    enlace.target = '_blank';
    enlace.rel = 'noopener';
    enlace.textContent = `http://${e.ip}`;
    pagina.append(enlace, ' desde tu misma red Wi-Fi, o');
  }
  pagina.append(' http://192.168.4.1 conectado a la red Caneca-IoT (siempre prendida; no tiene internet, así que en el celular apágale la conexión automática).');

  $('#btn-pausa').textContent = e.pausa ? 'Reanudar' : 'Pausar';
  $('#btn-pausa').title = e.pausa ? 'Vuelve a clasificar sola' : 'Deja de clasificar sola (los botones siguen funcionando)';
  $('#btn-flash').setAttribute('aria-pressed', String(Boolean(e.flash)));
  $('#btn-flash').textContent = e.flash ? 'Flash prendido' : 'Flash';
}

// ---------------------------------------------------------------------------
// Análisis
// ---------------------------------------------------------------------------
const fmt = new Intl.NumberFormat('es-CO');
const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);
const esAprovechable = (clase) => app.clases.find((c) => c.id === clase)?.caneca === 'blanca';
// mano y bandeja vacía: la IA dijo que no había residuo (la bandeja no se movió)
const sinResiduo = (clase) => clase === 'vacio' || clase === 'mano' || app.clases.find((c) => c.id === clase)?.caneca === 'ninguna';
const cuenta = (clase) => app.conteos[clase] ?? 0;

function filaBarra(nombre, n, max, totalGrupo) {
  const li = document.createElement('li');
  if (!n) li.className = 'cero';
  const nom = document.createElement('span');
  nom.className = 'nombre';
  nom.textContent = nombre;
  const pista = document.createElement('span');
  pista.className = 'pista';
  const relleno = document.createElement('span');
  relleno.className = 'relleno';
  relleno.style.width = `${max ? (n / max) * 100 : 0}%`;
  pista.append(relleno);
  const numero = document.createElement('span');
  numero.className = 'num';
  numero.textContent = fmt.format(n);
  const p = document.createElement('span');
  p.className = 'pct';
  p.textContent = totalGrupo ? `${pct(n, totalGrupo)}%` : '';
  li.title = `${nombre}: ${fmt.format(n)} (${pct(n, totalGrupo)}% del grupo)`;
  li.append(nom, pista, numero, p);
  return li;
}

function pintarBarras(lista, clases, mostrarCeros) {
  const datos = clases.map((c) => ({ nombre: c.nombre, n: cuenta(c.id) })).sort((x, y) => y.n - x.n);
  const total = datos.reduce((a, d) => a + d.n, 0);
  const max = Math.max(0, ...datos.map((d) => d.n));
  lista.replaceChildren();
  const visibles = mostrarCeros ? datos : datos.filter((d) => d.n > 0);
  if (!visibles.length) {
    const p = document.createElement('p');
    p.className = 'vacio-nota';
    p.textContent = 'Aún no ha caído nada de este grupo.';
    lista.append(p);
    return;
  }
  for (const d of visibles) lista.append(filaBarra(d.nombre, d.n, max, total));
}

function pintarActividad() {
  const cols = $('#columnas');
  const eje = $('#columnas-eje');
  const horaActual = new Date();
  horaActual.setMinutes(0, 0, 0);
  const inicio = horaActual.getTime() - 23 * 3600 * 1000;
  const cubos = Array.from({ length: 24 }, (_, i) => ({ t: inicio + i * 3600 * 1000, si: 0, no: 0 }));
  for (const [t, clase] of app.estadisticas.ultimas24h || []) {
    const i = Math.floor((t - inicio) / 3600000);
    if (i < 0 || i > 23 || sinResiduo(clase)) continue;
    if (esAprovechable(clase)) cubos[i].si++;
    else cubos[i].no++;
  }
  const max = Math.max(1, ...cubos.map((c) => c.si + c.no));
  cols.replaceChildren();
  eje.replaceChildren();
  cubos.forEach((c, i) => {
    const col = document.createElement('div');
    col.className = 'columna';
    const h = new Date(c.t).getHours();
    col.title = `${String(h).padStart(2, '0')}:00, ${c.si} aprovechables y ${c.no} no aprovechables`;
    for (const [clave, n] of [['si', c.si], ['no', c.no]]) {
      if (!n) continue;
      const parte = document.createElement('span');
      parte.className = `parte parte-${clave}`;
      parte.style.height = `${(n / max) * 100}%`;
      col.append(parte);
    }
    cols.append(col);
    const etq = document.createElement('span');
    etq.textContent = i % 3 === 2 || i === 23 ? `${h}h` : '';
    eje.append(etq);
  });
}

function pintarConteos() {
  const aprovechables = app.clases.filter((c) => c.caneca === 'blanca');
  const noAprovechables = app.clases.filter((c) => c.caneca !== 'blanca' && c.caneca !== 'ninguna');
  const si = aprovechables.reduce((a, c) => a + cuenta(c.id), 0);
  const no = noAprovechables.reduce((a, c) => a + cuenta(c.id), 0);
  const total = si + no;

  $('#tasa-pct').textContent = total ? `${pct(si, total)} %` : '—';
  $('#tasa-sub').textContent = total
    ? `${fmt.format(si)} de ${fmt.format(total)} residuos clasificados fueron a aprovechables.`
    : 'Todavía no hay residuos clasificados. Cuando la caneca clasifique, aquí se ve cuánto se puede reciclar.';
  $('#seg-si').style.width = `${total ? (si / total) * 100 : 0}%`;
  $('#seg-no').style.width = `${total ? (no / total) * 100 : 0}%`;
  $('#tasa-barra').setAttribute('aria-label', `${pct(si, total)}% aprovechables, ${pct(no, total)}% no aprovechables`);
  $('#n-si').textContent = `${fmt.format(si)} (${pct(si, total)}%)`;
  $('#n-no').textContent = `${fmt.format(no)} (${pct(no, total)}%)`;

  const ult = (app.estadisticas.ultimas24h || []).filter(([, c]) => !sinResiduo(c));
  const haceHora = Date.now() - 3600 * 1000;
  $('#k-total').textContent = fmt.format(total);
  $('#k-24h').textContent = fmt.format(ult.length);
  $('#k-hora').textContent = fmt.format(ult.filter(([t]) => t >= haceHora).length);
  $('#k-ia').textContent = app.estadisticas.tiempoIA ? `${coma(app.estadisticas.tiempoIA / 1000)} s` : '—';

  pintarBarras($('#barras-si'), aprovechables, true);
  pintarBarras($('#barras-no'), noAprovechables, false);
  pintarActividad();
  pintarPrecision();
}

// Qué tan bien decide: sale de lo que se marca en el Historial (Sí / No, y qué era)
const NOMBRE_GRUPO = {
  aprovechables: 'aprovechables', no_aprovechables: 'no aprovechables', mano: 'una mano', vacio: 'bandeja vacía',
  error: 'sin respuesta', nivel: 'no mover',
};
function pintarPrecision() {
  const p = app.estadisticas.precision;
  if (!p) return;
  const acierto = p.revisadas ? Math.round((100 * p.aciertos) / p.revisadas) : null;
  $('#p-acierto').textContent = acierto === null ? '—' : `${acierto} %`;
  $('#p-sub').textContent = p.revisadas
    ? `${p.aciertos} de ${p.revisadas} revisadas fueron al lado correcto o, si era una mano o estaba vacía, no se movieron. Error: ${100 - acierto} %.` +
      (p.claseMal ? ` De las que acertaron, ${p.claseMal} ${p.claseMal === 1 ? 'fue' : 'fueron'} con otra clase del mismo lado (por ejemplo, dijo metal y era papel).` : '')
    : 'Marca en el Historial si cada clasificación acertó (Sí / No) y aquí sale el porcentaje de error.';
  $('#p-seg-ok').style.width = `${acierto ?? 0}%`;
  $('#p-seg-mal').style.width = `${acierto === null ? 0 : 100 - acierto}%`;
  $('#p-barra').setAttribute('aria-label', acierto === null ? 'Sin revisiones' : `${acierto}% aciertos, ${100 - acierto}% errores`);
  $('#p-revisadas').textContent = fmt.format(p.revisadas);
  $('#p-sinrevisar').textContent = fmt.format(p.sinRevisar);
  const manos = p.sinResiduo?.mano || 0;
  const vacias = p.sinResiduo?.vacio || 0;
  $('#p-falsos').textContent = fmt.format(manos + vacias);
  $('#p-falsos-sub').textContent = `${manos} ${manos === 1 ? 'mano' : 'manos'} y ${vacias} con la bandeja vacía: la IA no movió la bandeja`;
  $('#p-nodetecto').textContent = fmt.format(p.noDetecto || 0);

  // Detección con la cámara. Precisión: de los avisos automáticos, los que tenían algo (residuo o mano).
  // Sensibilidad: de los residuos que pusieron, los que vio sola (los otros se avisan con "Puse algo y no lo detectó").
  const d = p.deteccion || { avisos: 0, residuo: 0, mano: 0, vacio: 0 };
  const conAlgo = d.residuo + d.mano;
  $('#p-cam-precision').textContent = d.avisos ? `${pct(conAlgo, d.avisos)} %` : '—';
  $('#p-cam-precision-sub').textContent = d.avisos
    ? `${conAlgo} de ${d.avisos} avisos automáticos tenían algo en la bandeja; ${d.vacio} con la bandeja vacía`
    : 'de los avisos automáticos tenían algo en la bandeja';
  const puestos = d.residuo + (p.noDetecto || 0);
  $('#p-cam-sensibilidad').textContent = puestos ? `${pct(d.residuo, puestos)} %` : '—';
  $('#p-cam-sensibilidad-sub').textContent = puestos
    ? `vio sola ${d.residuo} de ${puestos} residuos (${p.noDetecto || 0} ${(p.noDetecto || 0) === 1 ? 'avisado' : 'avisados'} con "Puse algo y no lo detectó")`
    : 'de los residuos los vio sola';
  $('#p-cam-avisos').textContent = fmt.format(d.avisos);
  $('#p-cam-avisos-sub').textContent = `${d.residuo} ${d.residuo === 1 ? 'residuo' : 'residuos'}, ${d.mano} ${d.mano === 1 ? 'mano' : 'manos'} y ${d.vacio} con la bandeja vacía`;

  const lista = $('#p-pordijo');
  lista.replaceChildren();
  const grupos = Object.entries(p.porDijo || {}).sort((a, b) => b[1].n - a[1].n);
  if (!grupos.length) {
    const vacio = document.createElement('p');
    vacio.className = 'vacio-nota';
    vacio.textContent = 'Todavía no hay clasificaciones revisadas.';
    lista.append(vacio);
  }
  for (const [grupo, d] of grupos) {
    const li = filaBarra(`Dijo ${NOMBRE_GRUPO[grupo] || grupo}`, d.ok, d.n, d.n);
    li.querySelector('.num').textContent = `${d.ok}/${d.n}`;
    li.title = `Cuando dijo ${NOMBRE_GRUPO[grupo] || grupo}: acertó ${d.ok} de ${d.n}`;
    lista.append(li);
  }

  const errores = $('#p-errores');
  errores.replaceChildren();
  if (!p.errores?.length) {
    const vacio = document.createElement('p');
    vacio.className = 'vacio-nota';
    vacio.textContent = p.revisadas ? 'Ningún error marcado.' : 'Aquí salen los errores que marques.';
    errores.append(vacio);
  }
  for (const [clave, n] of p.errores || []) {
    const [dijo, era] = clave.split('>');
    const li = document.createElement('li');
    const veces = document.createElement('b');
    veces.textContent = `${n}×`;
    const real = era === 'vacio' ? 'estaba vacía' : `era ${NOMBRE_REAL[era] || NOMBRE_GRUPO[era] || NOMBRE_CLASE[era] || era}`;
    // dijo una clase y era otra del mismo lado: la bandeja igual acertó
    const mismoLado = !NOMBRE_GRUPO[dijo] && NOMBRE_CLASE[dijo] && NOMBRE_CLASE[era] ? ' (fue al lado correcto)' : '';
    li.append(veces, ` dijo ${NOMBRE_GRUPO[dijo] || NOMBRE_CLASE[dijo] || dijo} y ${real}${mismoLado}`);
    errores.append(li);
  }
}

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------
function hora(iso) {
  const fecha = new Date(iso);
  const hhmm = fecha.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  if (fecha.toDateString() === new Date().toDateString()) return hhmm;
  return `${fecha.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}, ${hhmm}`;
}

function textoLado(lado) {
  if (lado === 'aprovechables') return 'fue a aprovechables';
  if (lado === 'no_aprovechables') return 'fue a no aprovechables';
  if (lado === 'izquierda' || lado === 'derecha') return `fue a la ${lado}`; // eventos viejos
  return 'se quedó en la bandeja';
}

const QUE_HACER = {
  negra: 'va a la caneca negra: retíralo a mano',
  especial: 'residuo especial: llévalo a un punto de recolección',
};

function describir(evento) {
  if (evento.tipo === 'aviso') return `Aviso: ${evento.msg}`;
  if (evento.tipo === 'captura') {
    const tipo = app.tiposCaptura[evento.capturaTipo] || 'Captura';
    return `${tipo}${evento.nota ? ` («${evento.nota}»)` : ''}`;
  }
  if (evento.tipo === 'clasificacion') {
    if (evento.clase === 'mano') return 'Una mano: la bandeja no se movió';
    if (evento.clase === 'vacio') return 'Bandeja vacía: no se movió';
    if (evento.clase === 'error') return 'La IA no respondió: la bandeja no se movió';
    const accion = evento.lado === 'nivel' && QUE_HACER[evento.caneca] ? QUE_HACER[evento.caneca] : textoLado(evento.lado);
    return `${NOMBRE_CLASE[evento.clase] || evento.clase}, ${accion}`;
  }
  if (evento.lado === 'nivel') return 'Bandeja nivelada';
  if (evento.lado === 'vaciar_aprovechables') return 'Bandeja de canto para vaciar aprovechables';
  if (evento.lado === 'vaciar_no_aprovechables' || evento.lado === 'vaciar') return 'Bandeja de canto para vaciar no aprovechables';
  return `Bandeja inclinada: ${textoLado(evento.lado).replace('fue ', '')}`;
}

function tipoEvento(evento) {
  if (evento.tipo === 'clasificacion') {
    if (evento.clase === 'error') return 'aviso';
    if (sinResiduo(evento.clase) || evento.lado === 'nivel') return 'vacio';
    return evento.lado === 'aprovechables' ? 'si' : 'no';
  }
  return evento.tipo === 'aviso' ? 'aviso' : evento.tipo === 'captura' ? 'captura' : 'mov';
}

function miniatura(src, texto) {
  const boton = document.createElement('button');
  boton.type = 'button';
  boton.className = 'miniatura';
  boton.setAttribute('aria-label', `Ver la foto: ${texto}`);
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('error', () => boton.remove());
  boton.append(img);
  boton.addEventListener('click', () => abrirVisor(src, texto));
  return boton;
}

function chip(texto, tipo) {
  const c = document.createElement('span');
  c.className = 'chip';
  c.dataset.tipo = tipo;
  c.textContent = texto;
  return c;
}

function boton(texto, clase, alClic) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = clase;
  b.textContent = texto;
  b.addEventListener('click', alClic);
  return b;
}

// Qué decidió la IA, en el mismo idioma de las opciones de revisar
const grupoDecision = (e) => (sinResiduo(e.clase) ? e.clase : e.lado);
const NOMBRE_REAL = { aprovechables: 'aprovechable', no_aprovechables: 'no aprovechable', mano: 'una mano', vacio: 'vacía' };
const OPCIONES_REVISAR = [
  ['aprovechables', 'Era aprovechable'],
  ['no_aprovechables', 'Era no aprovechable'],
  ['mano', 'Era una mano'],
  ['vacio', 'Estaba vacía'],
];
let revisionAbierta = null; // id de la clasificación en la que se tocó "No"
let revisionOtra = null; // id de la clasificación en la que se tocó "Era otro aprovechable": falta elegir cuál

// Las clases que van al mismo lado de la bandeja (el servidor manda el lado de cada una)
const ladoDeClase = (c) => c.lado || (c.caneca === 'blanca' ? 'aprovechables' : 'no_aprovechables');
const clasesDelLado = (lado, menos) =>
  app.clases.filter((c) => c.id !== menos && !sinResiduo(c.id) && ladoDeClase(c) === lado);
// Fue al lado correcto, pero la persona marcó que era otra clase (dijo metal y era papel)
const otraClaseMismoLado = (evento, r) => r.ok && r.real !== evento.clase && Boolean(NOMBRE_CLASE[r.real]) && !sinResiduo(r.real);
const cerrarRevision = () => {
  revisionAbierta = null;
  revisionOtra = null;
};

// Botones para decir si la caneca acertó (solo quien tiene el control)
function controlesRevision(evento) {
  if (evento.clase === 'error') return null;
  const caja = document.createElement('div');
  caja.className = 'revisar';
  if (evento.revision && revisionAbierta !== evento.id) {
    const r = evento.revision;
    if (otraClaseMismoLado(evento, r)) caja.append(chip(`Era ${NOMBRE_CLASE[r.real]}: fue al lado correcto`, 'medio'));
    else caja.append(chip(r.ok ? 'Acertó' : `Error: era ${NOMBRE_REAL[r.real] || NOMBRE_CLASE[r.real] || r.real}`, r.ok ? 'ok' : 'mal'));
    if (manejo()) caja.append(boton('Cambiar', 'boton-texto', () => mandar({ t: 'revisar', id: evento.id, real: '' })));
    return caja;
  }
  if (!manejo()) return null;
  const lado = evento.lado;
  const otras = sinResiduo(evento.clase) || !NOMBRE_REAL[lado] ? [] : clasesDelLado(lado, evento.clase);
  if (revisionOtra === evento.id) {
    // "Era otro aprovechable": la persona elige cuál era (papel, cartón...)
    const pregunta = document.createElement('span');
    pregunta.className = 'revisar-pregunta';
    pregunta.textContent = '¿Cuál era?';
    caja.append(pregunta);
    for (const c of otras) {
      caja.append(boton(c.nombre, 'boton boton-chico', () => {
        cerrarRevision();
        mandar({ t: 'revisar', id: evento.id, real: c.id });
      }));
    }
    caja.append(boton('Volver', 'boton-texto', () => {
      revisionOtra = null;
      pintarHistorial();
    }));
    return caja;
  }
  if (revisionAbierta === evento.id) {
    const pregunta = document.createElement('span');
    pregunta.className = 'revisar-pregunta';
    pregunta.textContent = '¿Qué era?';
    caja.append(pregunta);
    if (otras.length) {
      caja.append(boton(`Era otro ${NOMBRE_REAL[lado]}`, 'boton boton-chico', () => {
        revisionOtra = evento.id;
        pintarHistorial();
      }));
    }
    for (const [valor, texto] of OPCIONES_REVISAR) {
      if (valor === grupoDecision(evento)) continue; // eso fue lo que dijo: no sería un error
      caja.append(boton(texto, 'boton boton-chico', () => {
        cerrarRevision();
        mandar({ t: 'revisar', id: evento.id, real: valor });
      }));
    }
    caja.append(boton('Cancelar', 'boton-texto', () => {
      cerrarRevision();
      pintarHistorial();
    }));
    return caja;
  }
  const pregunta = document.createElement('span');
  pregunta.className = 'revisar-pregunta';
  pregunta.textContent = '¿Acertó?';
  caja.append(
    pregunta,
    boton('Sí', 'boton boton-chico boton-si', () => mandar({ t: 'revisar', id: evento.id, real: 'bien' })),
    boton('No', 'boton boton-chico boton-no', () => {
      revisionAbierta = evento.id;
      revisionOtra = null;
      pintarHistorial();
    }),
  );
  return caja;
}

// El historial no muestra si el residuo cayó (Nharenn lo pidió el 17 oct): tampoco el aviso de la placa
const visibleEnHistorial = (e) => !(e.tipo === 'aviso' && /no cayó/i.test(e.msg || ''));

function pintarHistorial() {
  const lista = $('#historial');
  lista.replaceChildren();
  const eventos = app.eventos.filter(visibleEnHistorial);
  for (const evento of eventos) {
    const fila = document.createElement('li');
    fila.dataset.tipo = tipoEvento(evento);

    const cuando = document.createElement('time');
    cuando.dateTime = evento.fecha;
    cuando.textContent = hora(evento.fecha);

    const que = document.createElement('div');
    que.className = 'historial-que';
    const titulo = document.createElement('strong');
    titulo.textContent = describir(evento);
    que.append(titulo);
    const partes = [
      NOMBRE_ORIGEN[evento.origen],
      evento.ms ? `la IA tardó ${coma(evento.ms / 1000)} s` : null,
    ].filter(Boolean);
    if (evento.clase === 'error' && evento.nota) partes.push(evento.nota);
    if (partes.length) {
      const detalle = document.createElement('small');
      detalle.textContent = partes.join(', ');
      que.append(detalle);
    }
    if (evento.tipo === 'clasificacion') {
      const revisar = controlesRevision(evento);
      if (revisar) que.append(revisar);
    }

    fila.append(cuando, que);
    // la foto que vio la IA, o la captura guardada, para revisarla
    if (evento.tipo === 'clasificacion' && evento.foto) {
      fila.append(miniatura(`/fotos/${evento.id}.jpg`, `${describir(evento)}, ${hora(evento.fecha)}`));
    } else if (evento.tipo === 'captura' && evento.capturaId) {
      fila.append(boton('Revisar', 'boton-texto', () => abrirCaptura(evento.capturaId)));
    } else {
      fila.append(document.createElement('span'));
    }
    lista.append(fila);
  }
  $('#historial-vacio').hidden = eventos.length > 0;
  const p = app.estadisticas.precision;
  $('#historial-resumen').textContent = !p
    ? 'Toca Sí o No en cada clasificación para decir si la caneca acertó.'
    : p.revisadas
      ? `Revisadas ${p.revisadas}: acertó el ${pct(p.aciertos, p.revisadas)} %. Faltan ${p.sinRevisar} por revisar.`
      : `Toca Sí o No en cada clasificación para decir si la caneca acertó${p.sinRevisar ? ` (hay ${p.sinRevisar} sin revisar)` : ''}.`;
}

function pintarUltima() {
  const ultima = app.eventos.find((e) => e.tipo === 'clasificacion' && !sinResiduo(e.clase) && e.clase !== 'error') ||
    app.eventos.find((e) => e.tipo === 'clasificacion');
  const foto = $('#ultima-foto');
  if (!ultima) {
    $('#ultima-texto').textContent = 'Todavía no hay clasificaciones.';
    foto.hidden = true;
    return;
  }
  const texto = `${describir(ultima)}, ${hora(ultima.fecha)}`;
  $('#ultima-texto').textContent = texto;
  const src = ultima.foto ? `/fotos/${ultima.id}.jpg` : `/ultima.jpg?v=${ultima.id}`;
  $('#ultima-img').src = src;
  foto.onclick = () => abrirVisor(src, texto);
  foto.hidden = false;
}

function abrirVisor(src, texto) {
  const visor = $('#visor');
  $('#visor-img').src = src;
  $('#visor-img').alt = texto;
  $('#visor-texto').textContent = texto;
  if (typeof visor.showModal === 'function') visor.showModal();
  else window.open(src, '_blank', 'noopener');
}
$('#visor').addEventListener('click', (ev) => {
  if (ev.target === $('#visor')) $('#visor').close(); // tocar fuera de la foto la cierra
});

let temporizadorAviso = null;
function avisar(texto, tipo) {
  const aviso = $('#aviso');
  aviso.textContent = texto;
  aviso.dataset.tipo = tipo;
  aviso.dataset.visible = 'si';
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => {
    aviso.dataset.visible = 'no';
  }, tipo === 'error' ? 7000 : 4000);
}

// ---------------------------------------------------------------------------
// Calibrar
// La placa manda (solo mientras la pestaña está abierta) tres miniaturas de 80 x 60 en gris:
// la bandeja vacía que tiene guardada, lo que ve ahora y qué puntos cambiaron.
// Los ajustes que mueves aquí son un borrador: se ven al instante y la caneca los usa al guardar.
// ---------------------------------------------------------------------------
const dep = {
  congelado: false,
  viendoCaptura: null, // id de la captura que se está revisando (null = en vivo)
  numeros: null,
  cuadro: null,
  capas: null, // las tres imágenes ya pintadas (80 x 60)
  vista: 'color', // la imagen en color de la cámara, con el cuadro amarillo
  calibrando: 0, // cuándo se tocó "Calibrar con la bandeja vacía" (0 = no está calibrando)
  probando: 0, // cuándo se tocó "Probar foto"
  foto: null, // foto en color de una captura
  ultimoCuadro: 0,
  pedidoDesde: 0,
};

const cal = {
  umbral: null, // lo que estás probando (sin guardar)
  zona: null,
  historia: [], // [fecha, % de la cámara] de los últimos 30 s, para ver hasta dónde sube
  editarZona: false,
  arrastre: null,
};

const mismaZona = (a, b) => Boolean(a && b) && LADOS_ZONA.every((k) => a[k] === b[k]);
function hayCambios() {
  if (cal.umbral === null || !cal.zona || app.umbralCamara === null || !app.zona) return false;
  return cal.umbral !== app.umbralCamara || !mismaZona(cal.zona, app.zona);
}
function copiarGuardados() {
  cal.umbral = app.umbralCamara;
  cal.zona = app.zona ? { ...app.zona } : null;
}
// Si no estabas probando nada, el borrador sigue a lo guardado; si sí, se respeta lo que movías
function recibirAjustes(umbral, zona) {
  const estabaLimpio = !hayCambios();
  app.umbralCamara = umbral;
  app.zona = zona;
  if (estabaLimpio || cal.umbral === null) copiarGuardados();
}

function leerCuadro(bytes) {
  const w = bytes[1];
  const h = bytes[2];
  const n = w * h;
  if (!w || !h || bytes.length !== 7 + 3 * n) return null;
  return {
    w, h,
    zona: { x0: bytes[3], x1: bytes[4], y0: bytes[5], y1: bytes[6] }, // en puntos de la miniatura
    ref: bytes.subarray(7, 7 + n),
    cur: bytes.subarray(7 + n, 7 + 2 * n),
    marcas: bytes.subarray(7 + 2 * n, 7 + 3 * n),
  };
}

function capa(cuadro, pixel) {
  const { w, h } = cuadro;
  const lienzo = document.createElement('canvas');
  lienzo.width = w;
  lienzo.height = h;
  const ctx = lienzo.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = pixel(i);
    img.data[4 * i] = r;
    img.data[4 * i + 1] = g;
    img.data[4 * i + 2] = b;
    img.data[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return lienzo;
}

// ¿La zona que está usando la caneca (viene en cada cuadro) es la guardada?
function zonaCanecaEnPct() {
  const c = dep.cuadro;
  if (!c) return null;
  return { x0: (100 * c.zona.x0) / c.w, x1: (100 * c.zona.x1) / c.w, y0: (100 * c.zona.y0) / c.h, y1: (100 * c.zona.y1) / c.h };
}
function canecaUsaZona(zona) {
  const c = dep.cuadro;
  if (!c || !zona) return false;
  // la placa pasa el % a puntos redondeando hacia abajo (división entera)
  return Math.floor((c.w * zona.x0) / 100) === c.zona.x0 && Math.floor((c.w * zona.x1) / 100) === c.zona.x1 &&
    Math.floor((c.h * zona.y0) / 100) === c.zona.y0 && Math.floor((c.h * zona.y1) / 100) === c.zona.y1;
}

function pintarCuadro(cuadro) {
  dep.cuadro = cuadro;
  const sinRef = dep.numeros && dep.numeros.refLista === false;
  const gris = (v) => [v, v, v];
  dep.capas = {
    ref: capa(cuadro, (i) => (sinRef ? [40, 40, 40] : gris(cuadro.ref[i]))),
    cur: capa(cuadro, (i) => gris(cuadro.cur[i])),
    dif: capa(cuadro, (i) => {
      const m = cuadro.marcas[i];
      if (m === 1) return [242, 140, 40]; // cambió el brillo
      if (m === 2) return [59, 130, 246]; // cambió un borde
      return gris(Math.round(cuadro.cur[i] * 0.45));
    }),
  };
  for (const v of ['ref', 'cur', 'dif']) {
    const chico = $(`#dep-${v}`);
    const ctx = chico.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(dep.capas[v], 0, 0, chico.width, chico.height);
    dibujarZona(ctx, chico.width, chico.height, cal.zona, { chica: true });
  }
  pintarGrande();
}

function dibujarZona(ctx, W, H, zona, { chica = false, sucia = false } = {}) {
  if (!zona) return;
  const x = (zona.x0 / 100) * W;
  const y = (zona.y0 / 100) * H;
  const w = ((zona.x1 - zona.x0) / 100) * W;
  const h = ((zona.y1 - zona.y0) / 100) * H;
  if (!chica) {
    // oscurecer lo que queda fuera: eso no se revisa
    ctx.fillStyle = 'rgba(12, 18, 15, 0.55)';
    ctx.fillRect(0, 0, W, y);
    ctx.fillRect(0, y + h, W, H - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, W - x - w, h);
  }
  ctx.lineWidth = chica ? 1.5 : 3;
  ctx.strokeStyle = '#f2c230';
  ctx.setLineDash(sucia || chica ? [] : [10, 6]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  if (chica) return;
  // agarraderas en esquinas y lados
  const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h], [x + w / 2, y], [x + w / 2, y + h], [x, y + h / 2], [x + w, y + h / 2]];
  for (const [px, py] of pts) {
    ctx.fillStyle = '#f2c230';
    ctx.fillRect(px - 6, py - 6, 12, 12);
    ctx.strokeStyle = '#15211b';
    ctx.lineWidth = 2;
    ctx.strokeRect(px - 6, py - 6, 12, 12);
  }
  if (sucia) {
    const texto = 'Sin guardar';
    ctx.font = '600 15px Archivo, system-ui, sans-serif';
    const ancho = ctx.measureText(texto).width + 14;
    const ty = y > 30 ? y - 28 : y + 10;
    ctx.fillStyle = '#f2c230';
    ctx.fillRect(x + 10, ty, ancho, 22);
    ctx.fillStyle = '#15211b';
    ctx.fillText(texto, x + 17, ty + 16);
  }
}

function pintarGrande() {
  const canvas = $('#dep-grande');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#1b2420';
  ctx.fillRect(0, 0, W, H);
  const fuente = dep.vista === 'foto' ? dep.foto : dep.vista === 'color' ? imagenEnColor() : dep.capas?.[dep.vista];
  if (fuente) {
    ctx.imageSmoothingEnabled = dep.vista === 'foto' || dep.vista === 'color';
    ctx.drawImage(fuente, 0, 0, W, H);
  }
  // la zona que usa la caneca, si es distinta de la que estás probando
  const enCaneca = zonaCanecaEnPct();
  if (enCaneca && cal.zona && !canecaUsaZona(cal.zona)) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 5]);
    ctx.strokeRect((enCaneca.x0 / 100) * W, (enCaneca.y0 / 100) * H, ((enCaneca.x1 - enCaneca.x0) / 100) * W, ((enCaneca.y1 - enCaneca.y0) / 100) * H);
    ctx.setLineDash([]);
  }
  if (fuente || cal.zona) dibujarZona(ctx, W, H, cal.zona, { sucia: !mismaZona(cal.zona, app.zona) });
  const nombres = { color: 'Imagen de la cámara en color', dif: 'Qué cambió', cur: 'Lo que ve ahora en gris', ref: 'Bandeja vacía guardada', foto: 'Foto de la captura' };
  canvas.setAttribute('aria-label', `${nombres[dep.vista]}, con la zona que se revisa en amarillo`);
}

// La imagen en vivo (la misma de En vivo) sirve para ver la zona en color: es más fácil que en gris
function imagenEnColor() {
  const img = $('#camara-img');
  return img.complete && img.naturalWidth && Date.now() - app.ultimaImagen < 5000 ? img : null;
}
function pintarColorMini() {
  const chico = $('#dep-color');
  const ctx = chico.getContext('2d');
  const img = imagenEnColor();
  ctx.fillStyle = '#1b2420';
  ctx.fillRect(0, 0, chico.width, chico.height);
  if (img) ctx.drawImage(img, 0, 0, chico.width, chico.height);
  dibujarZona(ctx, chico.width, chico.height, cal.zona, { chica: true });
}

const LEYENDAS = {
  dif: [['m-brillo', 'cambió el brillo'], ['m-borde', 'cambió un borde'], ['m-zona', 'zona que se revisa']],
  otra: [['m-zona', 'zona que se revisa: lo de afuera no cuenta']],
};
function pintarLeyenda() {
  const leyenda = $('#leyenda');
  leyenda.replaceChildren();
  for (const [clase, texto] of LEYENDAS[dep.vista === 'dif' ? 'dif' : 'otra']) {
    const item = document.createElement('span');
    const marca = document.createElement('i');
    marca.className = `m ${clase}`;
    item.append(marca, texto);
    leyenda.append(item);
  }
}

const siNo = (v) => (v ? 'sí' : 'no');

function textoEdad(s) {
  if (!Number.isFinite(s)) return '';
  if (s < 90) return `hace ${s} s`;
  if (s < 5400) return `hace ${Math.round(s / 60)} min`;
  return `hace ${coma(s / 3600)} h`;
}

function pintarPasos(n) {
  if (!n) return;
  // 1. Bandeja vacía
  const paso1 = $('#paso-ref');
  let ref;
  if (n.fase === 'tomando_referencia') {
    paso1.dataset.ok = 'medio';
    // cuánto lleva intentando: lo dice la placa (.5) o lo cuenta la página
    if (!dep.tomandoDesde || dep.viendoCaptura) dep.tomandoDesde = Date.now();
    const segundos = Number.isFinite(n.buscandoS) ? n.buscandoS : Math.round((Date.now() - dep.tomandoDesde) / 1000);
    const mov = Number.isFinite(n.movPct) ? ` Movimiento: ${n.movPct} % (la guarda con menos de ${n.movUmbral ?? 2} %).` : '';
    let lleva = '';
    if (segundos >= 6) lleva = ` Lleva ${segundos} s esperando: si la bandeja está vacía, toca "Calibrar con la bandeja vacía" y la guarda de una vez.`;
    ref = `Guardándola: esperando a que todo esté quieto.${mov}${lleva}`;
  } else if (n.refLista === false) {
    paso1.dataset.ok = 'no';
    ref = 'La cámara no tiene la imagen de la bandeja vacía. Deja la bandeja vacía y toca el botón.';
  } else {
    paso1.dataset.ok = 'si';
    ref = `La cámara tiene la bandeja vacía de ${textoEdad(n.refEdadS)}.`.replace(' .', '.');
  }
  $('#dep-ref-estado').textContent = ref;
  if (n.fase !== 'tomando_referencia') dep.tomandoDesde = 0;

  // 4. Qué decide
  const cajaCam = $('#dep-paso-cam');
  let cam;
  if (n.fase === 'tomando_referencia') cam = 'Todavía no compara: está guardando la bandeja vacía.';
  else if (n.fase === 'bandeja_no_esta') cam = 'La bandeja no está a nivel: no compara.';
  else if (!Number.isFinite(n.camPct)) cam = 'Sin medida.';
  else {
    cam = `${n.camPct} % de la zona cambió; avisa desde ${n.umbral} %: ${siNo(n.camPct >= n.umbral)}.`;
    if (n.camPct >= n.umbral && !n.camVe) cam += n.movPct >= 2 ? ` Se está moviendo (${n.movPct} %): espera a que quede quieto.` : ' Falta que se quede quieto 1 s.';
  }
  cajaCam.dataset.ve = n.camVe ? 'si' : 'no';
  cajaCam.querySelector('dd').textContent = cam;

  const cajaRes = $('#dep-paso-res');
  let res;
  if (n.mano) res = 'La IA vio una mano: no se mueve ni vuelve a preguntar hasta que algo se mueva (la mano se va).';
  else if (n.vaciar) res = 'Modo vaciar: no clasifica hasta que toques Nivelar.';
  else if (n.atascado) res = 'Espera a que la bandeja quede libre: si quedó algo encima, sácalo a mano o toca Nivelar.';
  else if (n.pausa) res = 'En pausa: no clasifica sola.';
  else if (n.esperando) res = 'Ya clasificó lo que hay: espera a que la bandeja quede libre.';
  else if (n.camVe) res = 'Llegó algo (lo ve la cámara): toma la foto con flash y la IA decide si va a aprovechables, a no aprovechables, o si no hace nada (una mano o la bandeja vacía).';
  else res = 'Bandeja libre: no hace nada. Si pusiste algo y no lo detecta, avísalo en el Historial con "Puse algo y no lo detectó".';
  cajaRes.dataset.ve = n.atascado ? 'alerta' : n.camVe ? 'si' : 'no';
  cajaRes.querySelector('dd').textContent = res;

  const tec = [];
  if (Number.isFinite(n.ruido)) tec.push(`Ruido de la cámara: ${coma(n.ruido)}. Un punto cuenta si cambia más de ${n.umbralPixel} en brillo o ${n.umbralBorde} en bordes.`);
  if (Number.isFinite(n.corrimiento)) tec.push(`Brillo general corregido en ${n.corrimiento > 0 ? '+' : ''}${n.corrimiento}.`);
  if (Number.isFinite(n.movPct)) tec.push(`Movimiento entre imágenes: ${n.movPct} %.`);
  if (n.fase) tec.push(`Fase: ${n.fase.replace(/_/g, ' ')}.`);
  if (n.bytes) tec.push(`Colores de la cámara: byte ${n.bytes}.`);
  $('#dep-tecnico').textContent = tec.join(' ') || 'Sin datos.';
}

// Sensibilidad: la barra es el % de ahora, la raya el que estás probando, la punteada lo más alto de 30 s
function pintarSensibilidad() {
  const n = dep.numeros;
  const ahora = n && Number.isFinite(n.camPct) && n.fase === 'comparando' ? n.camPct : null;
  const umbral = cal.umbral ?? 3;
  const ventana = cal.historia.filter(([t]) => Date.now() - t < 30000);
  const maximo = ventana.length ? Math.max(...ventana.map(([, v]) => v)) : null;
  const escala = Math.min(100, Math.max(10, Math.ceil((Math.max(umbral * 2, (maximo ?? 0) * 1.2, ahora ?? 0) + 1) / 5) * 5));
  $('#cal-relleno').style.width = `${ahora === null ? 0 : limitar(ahora / escala, 0, 1) * 100}%`;
  $('#cal-raya').style.left = `${limitar(umbral / escala, 0, 1) * 100}%`;
  $('#cal-raya-texto').textContent = `${umbral} %`;
  $('#cal-max').hidden = maximo === null;
  if (maximo !== null) $('#cal-max').style.left = `${limitar(maximo / escala, 0, 1) * 100}%`;
  $('#cal-escala').textContent = `${escala} %`;
  const ve = ahora !== null && ahora >= umbral;
  $('.regla').dataset.ve = ve ? 'si' : 'no';
  $('#cal-ahora').textContent = ahora === null ? '—' : `${ahora} %`;
  $('#cal-max-texto').textContent = ahora === null
    ? 'La cámara todavía no está comparando.'
    : `cambió ahora${maximo !== null ? `; lo más alto en los últimos 30 s fue ${maximo} % (raya punteada)` : ''}.`;
  $('#o-umbral').textContent = `${umbral} %`;

  let veredicto;
  if (ahora === null) veredicto = 'Cuando la cámara compare, aquí ves si con este valor avisaría.';
  else veredicto = ve ? `Con ${umbral} %, la cámara avisaría que llegó algo.` : `Con ${umbral} %, la cámara diría que la bandeja está libre.`;
  if (cal.umbral !== app.umbralCamara) veredicto += ` Es una prueba: la caneca sigue usando ${app.umbralCamara} % hasta que guardes.`;
  if (!mismaZona(cal.zona, app.zona)) veredicto += ' El % se vuelve a medir con la zona nueva cuando la guardes.';
  $('#cal-veredicto').textContent = veredicto;
  $('#paso-sens').dataset.ok = ahora === null ? '' : 'si';
}

function pintarDeslizadores() {
  if (!cal.zona) return;
  for (const k of LADOS_ZONA) {
    const input = $(`#zona-${k}`);
    if (document.activeElement !== input || !cal.arrastre) input.value = cal.zona[k];
    $(`#o-${k}`).textContent = `${cal.zona[k]} %`;
  }
  if (cal.umbral !== null) $('#umbral-cam').value = cal.umbral;
}

function pintarGuardar() {
  const barra = $('#guardar-barra');
  const cambios = hayCambios();
  const guardar = $('#btn-ajustes');
  barra.dataset.estado = cambios ? 'sucio' : 'limpio';
  $('#btn-descartar').hidden = !cambios;
  const z = app.zona;
  const actual = z && app.umbralCamara !== null
    ? `zona de ${z.x0} a ${z.x1} % a lo ancho y de ${z.y0} a ${z.y1} % a lo alto; la cámara avisa desde ${app.umbralCamara} %`
    : null;
  let texto;
  if (!actual) texto = 'Cargando los ajustes…';
  else if (!cambios) texto = `La caneca usa: ${actual}. Mueve la zona o las rayas para probar.`;
  else if (manejo()) texto = `Tienes cambios sin guardar. La caneca sigue usando lo anterior: ${actual}.`;
  else texto = 'Estás probando sin guardar. Para que la caneca use estos valores necesitas el control con el PIN.';
  if (cambios && !app.online && manejo()) texto += ' La caneca no está conectada: se le mandan cuando se conecte.';
  $('#guardar-texto').textContent = texto;
  if (cambios && !manejo()) {
    guardar.textContent = app.control.estado === 'espera' ? 'Esperando tu turno' : 'Tomar el control';
    guardar.disabled = app.control.estado === 'espera' || !app.servidor;
    guardar.dataset.accion = 'control';
  } else {
    guardar.textContent = 'Guardar en la caneca';
    guardar.disabled = !cambios || !app.servidor;
    guardar.dataset.accion = 'guardar';
  }
}

function pintarEstadoCal() {
  const ahora = Date.now();
  const enVivo = !dep.viendoCaptura && !dep.congelado;
  // con la caneca desconectada, el servidor puede mandar la última imagen que guardó: no es en vivo
  const frescoGris = app.online && ahora - dep.ultimoCuadro < 4000;
  const frescoColor = app.online && ahora - app.ultimaImagen < 4000;
  // la vista en color sale de la imagen en vivo; las demás, de las miniaturas de la calibración
  const fresco = dep.vista === 'color' ? frescoColor : frescoGris;

  // Imagen
  const ceImagen = $('#ce-imagen');
  let imagen;
  if (dep.viendoCaptura) [ceImagen.dataset.ok, imagen] = ['medio', 'revisando una captura'];
  else if (dep.congelado) [ceImagen.dataset.ok, imagen] = ['medio', 'congelada'];
  else if (fresco) [ceImagen.dataset.ok, imagen] = ['si', 'en vivo'];
  else [ceImagen.dataset.ok, imagen] = ['no', 'sin imagen'];
  ceImagen.querySelector('b').textContent = imagen;

  // Bandeja vacía
  const n = dep.numeros;
  const ceRef = $('#ce-ref');
  let ref = 'sin datos';
  ceRef.dataset.ok = '';
  if (n && (app.online || !enVivo)) {
    if (n.fase === 'tomando_referencia') [ceRef.dataset.ok, ref] = ['medio', 'guardándose'];
    else if (n.refLista === false) [ceRef.dataset.ok, ref] = ['no', 'no hay'];
    else [ceRef.dataset.ok, ref] = ['si', `guardada ${textoEdad(n.refEdadS)}`.trim()];
  }
  ceRef.querySelector('b').textContent = ref;

  // Ajustes
  const ceAj = $('#ce-ajustes');
  let aj = 'sin datos';
  ceAj.dataset.ok = '';
  if (hayCambios()) [ceAj.dataset.ok, aj] = ['medio', 'probando sin guardar'];
  else if (!app.online) aj = 'la caneca no está conectada';
  else if (dep.cuadro && n && Number.isFinite(n.umbral)) {
    const usa = canecaUsaZona(app.zona) && n.umbral === app.umbralCamara;
    [ceAj.dataset.ok, aj] = usa ? ['si', 'la caneca ya los usa'] : ['medio', 'la caneca todavía no los recibe'];
  }
  ceAj.querySelector('b').textContent = aj;
  $('#paso-zona').dataset.ok = !mismaZona(cal.zona, app.zona) ? 'medio' : canecaUsaZona(app.zona) ? 'si' : '';

  // Por qué no hay imagen
  const vacio = $('#lienzo-vacio');
  const sinImagen = enVivo && !fresco;
  vacio.hidden = !sinImagen;
  if (sinImagen) {
    let razon;
    if (!app.servidor) razon = 'Sin conexión con el servidor. Cuando vuelva, aquí aparece lo que ve la caneca.';
    else if (!app.online) razon = 'La caneca no está conectada. Revisa que esté prendida y con Wi-Fi; cuando se conecte, aquí aparece lo que ve.';
    else if (dep.vista === 'color') razon = 'Esperando la imagen en vivo de la caneca…';
    else if (firmwareViejo()) razon = `La caneca tiene el programa ${app.estado?.fw || 'viejo'} y esta parte necesita el ${FIRMWARE_ESPERADO} o uno más nuevo. Cárgale el programa de la carpeta Caneca3 con el Arduino IDE.`;
    else if (ahora - dep.pedidoDesde < 6000) razon = 'Pidiendo las imágenes a la caneca… llega una cada segundo.';
    else razon = 'La caneca está conectada pero no manda las imágenes. Recarga la página; si sigue igual, reinicia la caneca.';
    $('#lienzo-vacio-texto').textContent = razon;
  }
  if (enVivo && (dep.cuadro || dep.vista === 'color')) {
    const ultima = dep.vista === 'color' ? app.ultimaImagen : dep.ultimoCuadro;
    const hace = Math.round((ahora - ultima) / 1000);
    $('#dep-fuente').textContent = fresco ? 'En vivo' : ultima ? `Última imagen ${textoEdad(hace)}` : 'Sin imagen';
  }
  // el botón de calibrar vuelve solo si la caneca no contestó
  if (dep.calibrando && ahora - dep.calibrando > 15000) {
    dep.calibrando = 0;
    avisar('La caneca no contestó la calibración. Revisa que tenga el programa nuevo y vuelve a intentarlo.', 'error');
    pintarCalibracion();
  }
}

// Luz de la foto para la IA: se aplica al tocarla (con el control), para poder probarla enseguida
const NOMBRES_FLASH = { 0: 'Sin flash', 30: 'Flash suave', 60: 'Flash medio', 100: 'Flash fuerte' };
const nombreFlash = (pct) => NOMBRES_FLASH[pct] || `Flash al ${pct} %`;
function pintarFotoIA() {
  const puede = manejo() && app.servidor;
  for (const b of $$('#opciones-flash button')) {
    b.setAttribute('aria-checked', String(Number(b.dataset.flash) === app.flashFoto));
    b.disabled = !puede;
  }
  for (const b of $$('#opciones-detalle button')) {
    b.setAttribute('aria-checked', String(b.dataset.detalle === app.detalleIA));
    b.disabled = !puede;
  }
  const probar = $('#btn-probar-foto');
  probar.textContent = dep.probando ? 'Tomando la foto…' : 'Probar foto';
  probar.disabled = Boolean(dep.probando) || !app.online || !manejo();
  if (dep.probando && Date.now() - dep.probando > 10000) dep.probando = 0;
  const fig = $('#foto-prueba');
  fig.hidden = !app.fotoPrueba;
  if (app.fotoPrueba) {
    const src = `/prueba.jpg?v=${encodeURIComponent(app.fotoPrueba)}`;
    if ($('#foto-prueba-img').getAttribute('src') !== src) $('#foto-prueba-img').src = src;
    const texto = `Foto de prueba (${hora(app.fotoPrueba)}): así la recibe la IA. Si el papel se ve blanco y brillante, baja el flash; si se ve muy oscura, súbelo.`;
    $('#foto-prueba-texto').textContent = texto;
    $('#foto-prueba-ver').onclick = () => abrirVisor(src, texto);
  }
  const paso = $('#paso-foto');
  paso.dataset.ok = app.flashFoto === null ? '' : 'si';
}

function aplicarFotoIA(cambio) {
  if (!manejo()) return irAlPin();
  if (app.umbralCamara === null || !app.zona) return;
  // se mandan los ajustes guardados (no el borrador) con el cambio de la foto
  mandar({ t: 'ajustes', umbralCamara: app.umbralCamara, zona: { ...app.zona }, flashFoto: app.flashFoto, detalleIA: app.detalleIA, ...cambio });
}
for (const b of $$('#opciones-flash button')) b.addEventListener('click', () => aplicarFotoIA({ flashFoto: Number(b.dataset.flash) }));
for (const b of $$('#opciones-detalle button')) b.addEventListener('click', () => aplicarFotoIA({ detalleIA: b.dataset.detalle }));

// Resultado de "Calibrar con la bandeja vacía" y la foto que usa la IA
function pintarCalibracion() {
  const btn = $('#btn-calibrar');
  btn.textContent = dep.calibrando ? 'Calibrando… no toques la caneca' : 'Calibrar con la bandeja vacía';
  btn.disabled = Boolean(dep.calibrando) || !app.online || !manejo();
  const c = app.calibracion;
  const caja = $('#cal-resultado');
  caja.hidden = !c && !app.referencia;
  const img = $('#cal-ref-img');
  img.hidden = !app.referencia;
  if (app.referencia) {
    const src = `/referencia.jpg?v=${encodeURIComponent(app.referencia)}`;
    if (img.getAttribute('src') !== src) img.src = src;
    img.onclick = () => abrirVisor(src, 'Foto de la bandeja vacía que la IA usa para comparar');
  }
  const partes = [];
  if (c) {
    partes.push(`Calibrada a las ${hora(c.fecha)}`.replace(/\.?$/, '.'));
    partes.push(c.camara ? 'La cámara guardó la bandeja vacía.' : 'La cámara no pudo guardar la bandeja vacía.');
  }
  partes.push(app.referencia ? 'La foto es la bandeja vacía que la IA usa para comparar (tócala para verla).' : 'La IA todavía no tiene foto de la bandeja vacía.');
  $('#cal-resultado-texto').textContent = partes.join(' ');
  // si después de calibrar se cambió el flash, la foto de referencia quedó con otra luz
  const otraLuz = c && Number.isFinite(c.flash) && app.flashFoto !== null && c.flash !== app.flashFoto;
  $('#paso-ref').dataset.luz = otraLuz ? 'otra' : '';
  if (otraLuz) {
    $('#cal-resultado-texto').textContent += ` La foto de referencia se tomó con ${nombreFlash(c.flash).toLowerCase()} y ahora la foto usa ${nombreFlash(app.flashFoto).toLowerCase()}: calibra otra vez con la bandeja vacía para que la IA compare con la misma luz.`;
  }
}

function pintarCal() {
  pintarFotoIA();
  pintarDeslizadores();
  pintarSensibilidad();
  pintarCalibracion();
  pintarGuardar();
  pintarEstadoCal();
  pintarLeyenda();
  pintarGrande();
  pintarColorMini();
  // las miniaturas también muestran la zona que estás probando
  if (dep.cuadro && dep.capas) {
    for (const v of ['ref', 'cur', 'dif']) {
      const chico = $(`#dep-${v}`);
      const ctx = chico.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(dep.capas[v], 0, 0, chico.width, chico.height);
      dibujarZona(ctx, chico.width, chico.height, cal.zona, { chica: true });
    }
  }
}

function recibirNumeros(n) {
  if (Number.isFinite(n.camPct) && n.fase === 'comparando') {
    cal.historia.push([Date.now(), n.camPct]);
    cal.historia = cal.historia.filter(([t]) => Date.now() - t < 30000);
  }
  if (dep.congelado || dep.viendoCaptura) return;
  dep.numeros = n;
  pintarPasos(n);
  pintarSensibilidad();
}

function recibirCuadro(bytes) {
  if (dep.congelado || dep.viendoCaptura) return;
  const cuadro = leerCuadro(bytes);
  if (!cuadro) return;
  dep.ultimoCuadro = Date.now();
  pintarCuadro(cuadro);
  pintarEstadoCal();
}

function volverAVivo() {
  dep.viendoCaptura = null;
  dep.congelado = false;
  dep.foto = null;
  if (dep.vista === 'foto') elegirVista('color');
  $('#dep-congelar').textContent = 'Congelar imagen';
  $('#revision').hidden = true;
  $('#vista-foto').hidden = true;
  $('#dep-fuente').textContent = 'En vivo';
  pintarCal();
}

async function abrirCaptura(id) {
  mostrarPanel('calibrar');
  try {
    const r = await fetch(`/api/capturas/${id}`);
    if (!r.ok) throw new Error('no existe');
    const c = await r.json();
    const cuadro = c.cuadro ? leerCuadro(Uint8Array.from(atob(c.cuadro), (ch) => ch.charCodeAt(0))) : null;
    if (c.cuadro && !cuadro) throw new Error('dañada');
    if (!cuadro && !c.foto) throw new Error('vacía');
    dep.viendoCaptura = id;
    dep.numeros = c.datos || {};
    if (cuadro) pintarCuadro(cuadro);
    elegirVista(cuadro ? 'dif' : 'foto');
    pintarPasos(dep.numeros);
    pintarSensibilidad();
    const tipo = app.tiposCaptura[c.tipo] || 'Captura';
    const fecha = new Date(c.fecha).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    $('#revision-texto').textContent = `Revisando la captura del ${fecha}: ${tipo}${c.nota ? `, «${c.nota}»` : ''}. Las imágenes y los números son de ese momento.`;
    $('#revision').hidden = false;
    $('#dep-fuente').textContent = `Captura del ${fecha}`;
    $('#vista-foto').hidden = !c.foto;
    if (c.foto) {
      const src = `/capturas/${id}.jpg`;
      $('#dep-foto').src = src;
      const img = new Image();
      img.onload = () => {
        dep.foto = img;
        if (dep.vista === 'foto') pintarGrande();
      };
      img.src = src;
    }
    pintarEstadoCal();
    $('#revision').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    avisar('No se pudo abrir esa captura (puede que ya se haya borrado).', 'error');
  }
}

// --- Elegir qué imagen ver en grande
function elegirVista(v) {
  dep.vista = v;
  for (const b of $$('.vista')) b.setAttribute('aria-pressed', String(b.dataset.vista === v));
  pintarLeyenda();
  pintarGrande();
  pintarEstadoCal();
}
for (const b of $$('.vista')) b.addEventListener('click', () => elegirVista(b.dataset.vista));

// --- Mover la zona con las barras
function ponerZona(nueva, fijo) {
  const z = { ...nueva };
  for (const k of LADOS_ZONA) z[k] = Math.round(limitar(z[k], 0, 100));
  // al menos 10 % entre un borde y el otro, como pide el servidor
  if (z.x1 - z.x0 < 10) {
    if (fijo === 'x0') z.x1 = Math.min(100, z.x0 + 10);
    else z.x0 = Math.max(0, z.x1 - 10);
    if (z.x1 - z.x0 < 10) z.x0 = z.x1 - 10;
  }
  if (z.y1 - z.y0 < 10) {
    if (fijo === 'y0') z.y1 = Math.min(100, z.y0 + 10);
    else z.y0 = Math.max(0, z.y1 - 10);
    if (z.y1 - z.y0 < 10) z.y0 = z.y1 - 10;
  }
  cal.zona = z;
  pintarCal();
}

for (const k of LADOS_ZONA) {
  $(`#zona-${k}`).addEventListener('input', (ev) => {
    if (!cal.zona) return;
    const otro = { x0: 'x1', x1: 'x0', y0: 'y1', y1: 'y0' }[k];
    let v = Number(ev.target.value);
    // un borde no puede pasar al otro
    v = k.endsWith('0') ? Math.min(v, cal.zona[otro] - 10) : Math.max(v, cal.zona[otro] + 10);
    ev.target.value = v;
    ponerZona({ ...cal.zona, [k]: v }, k);
  });
}

$('#umbral-cam').addEventListener('input', (ev) => {
  cal.umbral = Number(ev.target.value);
  pintarSensibilidad();
  pintarGuardar();
  pintarEstadoCal();
});

$('#btn-zona-sugerida').addEventListener('click', () => ponerZona(ZONA_SUGERIDA));

// --- Mover la zona arrastrando en la imagen (con el dedo, solo con "Mover la zona" prendido)
const lienzo = $('#dep-grande');
function puntoEnPct(ev) {
  const r = lienzo.getBoundingClientRect();
  return { x: limitar(((ev.clientX - r.left) / r.width) * 100, 0, 100), y: limitar(((ev.clientY - r.top) / r.height) * 100, 0, 100) };
}
function queAgarra(p, tactil) {
  const z = cal.zona;
  if (!z) return null;
  const tx = tactil ? 7 : 3.5;
  const ty = tx * (4 / 3);
  const dentroX = p.x > z.x0 - tx && p.x < z.x1 + tx;
  const dentroY = p.y > z.y0 - ty && p.y < z.y1 + ty;
  const lados = [];
  if (dentroY) {
    if (Math.abs(p.x - z.x0) < tx) lados.push('x0');
    else if (Math.abs(p.x - z.x1) < tx) lados.push('x1');
  }
  if (dentroX) {
    if (Math.abs(p.y - z.y0) < ty) lados.push('y0');
    else if (Math.abs(p.y - z.y1) < ty) lados.push('y1');
  }
  if (lados.length) return { lados };
  if (p.x > z.x0 && p.x < z.x1 && p.y > z.y0 && p.y < z.y1) return { mover: true };
  return null;
}
function cursorPara(agarre) {
  if (!agarre) return 'default';
  if (agarre.mover) return 'move';
  const l = agarre.lados.join('');
  if (l === 'x0y0' || l === 'x1y1') return 'nwse-resize';
  if (l === 'x1y0' || l === 'x0y1') return 'nesw-resize';
  return l.startsWith('x') ? 'ew-resize' : 'ns-resize';
}

lienzo.addEventListener('pointerdown', (ev) => {
  if (!cal.zona) return;
  if (ev.pointerType === 'touch' && !cal.editarZona) return;
  const p = puntoEnPct(ev);
  const agarre = queAgarra(p, ev.pointerType !== 'mouse');
  if (!agarre) return;
  cal.arrastre = { ...agarre, inicio: p, zonaInicio: { ...cal.zona } };
  lienzo.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});
lienzo.addEventListener('pointermove', (ev) => {
  const p = puntoEnPct(ev);
  const a = cal.arrastre;
  if (!a) {
    if (ev.pointerType === 'mouse') lienzo.style.cursor = cursorPara(queAgarra(p, false));
    return;
  }
  const z0 = a.zonaInicio;
  if (a.mover) {
    const dx = limitar(p.x - a.inicio.x, -z0.x0, 100 - z0.x1);
    const dy = limitar(p.y - a.inicio.y, -z0.y0, 100 - z0.y1);
    ponerZona({ x0: z0.x0 + dx, x1: z0.x1 + dx, y0: z0.y0 + dy, y1: z0.y1 + dy });
  } else {
    const z = { ...cal.zona };
    for (const k of a.lados) {
      const v = k.startsWith('x') ? p.x : p.y;
      const otro = { x0: 'x1', x1: 'x0', y0: 'y1', y1: 'y0' }[k];
      z[k] = k.endsWith('0') ? Math.min(v, z[otro] - 10) : Math.max(v, z[otro] + 10);
    }
    ponerZona(z, a.lados[0]);
  }
});
for (const tipo of ['pointerup', 'pointercancel']) lienzo.addEventListener(tipo, () => (cal.arrastre = null));

$('#btn-mover-zona').addEventListener('click', () => {
  cal.editarZona = !cal.editarZona;
  $('#btn-mover-zona').setAttribute('aria-pressed', String(cal.editarZona));
  $('#btn-mover-zona').textContent = cal.editarZona ? 'Listo, dejar de mover' : 'Mover la zona con el dedo';
  $('#lienzo').dataset.editar = cal.editarZona ? 'si' : 'no';
});

// --- Guardar o descartar
$('#btn-ajustes').addEventListener('click', () => {
  if ($('#btn-ajustes').dataset.accion === 'control') return irAlPin();
  if (!hayCambios()) return;
  mandar({ t: 'ajustes', umbralCamara: cal.umbral, zona: { ...cal.zona } });
});
$('#btn-descartar').addEventListener('click', () => {
  copiarGuardados();
  pintarCal();
  avisar('Cambios descartados: volviste a lo que usa la caneca.', 'ok');
});

$('#dep-congelar').addEventListener('click', () => {
  if (dep.viendoCaptura) return volverAVivo();
  dep.congelado = !dep.congelado;
  $('#dep-congelar').textContent = dep.congelado ? 'Seguir en vivo' : 'Congelar imagen';
  $('#dep-fuente').textContent = dep.congelado ? 'Congelada' : 'En vivo';
  pintarEstadoCal();
});
$('#dep-vivo').addEventListener('click', volverAVivo);

// Historial: "Puse algo y no lo detectó" lo anota y manda la foto a la IA
$('#btn-no-detecto').addEventListener('click', () => {
  mandar({ t: 'captura', tipo: 'no_detecto', nota: '', clasificar: true });
});

// Avisar antes de salir si quedaron cambios sin guardar
window.addEventListener('beforeunload', (ev) => {
  if (hayCambios() && manejo()) {
    ev.preventDefault();
    ev.returnValue = '';
  }
});

// ---------------------------------------------------------------------------
// Botones
// ---------------------------------------------------------------------------
document.addEventListener('click', (evento) => {
  const boton = evento.target.closest('[data-orden]');
  if (!boton || boton.disabled) return;
  let accion = boton.dataset.orden;
  if (accion === 'pausa' && app.estado?.pausa) accion = 'reanudar';
  if (accion === 'foto_prueba') {
    dep.probando = Date.now();
    pintarFotoIA();
  }
  if (accion === 'calibrar') {
    cal.historia = [];
    // los programas viejos de la placa no conocen "calibrar": guardan la bandeja vacía con "referencia"
    if (firmwareViejo()) accion = 'referencia';
    else {
      dep.calibrando = Date.now();
      pintarCalibracion();
    }
  }
  mandar({ t: 'orden', a: accion });
});

// Tomar el control (o ponerse en la fila) con el PIN
$('#form-control').addEventListener('submit', (evento) => {
  evento.preventDefault();
  const pin = $('#pin').value.trim();
  if (!pin) {
    avisar('Escribe el PIN para tomar el control.', 'error');
    marcarPinMalo();
    $('#pin').focus();
    return;
  }
  guardarSesion('pin-caneca', pin);
  if (!mandar({ t: 'pedirControl', pin })) return;
  // si el servidor no contesta, casi siempre es un servidor viejo todavía prendido
  const antes = app.control.estado;
  setTimeout(() => {
    if (app.control.estado === antes && antes === 'mirando' && app.servidor) {
      avisar('El servidor no respondió al pedir el control. Si está en tu computador, reinícialo (Ctrl+C y npm start) y recarga la página.', 'error');
    }
  }, 3000);
});

$('#btn-soltar').addEventListener('click', () => {
  guardarSesion('control-caneca', null);
  mandar({ t: 'soltarControl' });
});

let confirmarReinicio = 0;
$('#btn-reiniciar').addEventListener('click', () => {
  const boton = $('#btn-reiniciar');
  if (Date.now() - confirmarReinicio > 4000) {
    confirmarReinicio = Date.now();
    boton.textContent = 'Toca otra vez para borrar todo';
    setTimeout(() => (boton.textContent = 'Reiniciar estadísticas'), 4000);
    return;
  }
  mandar({ t: 'reiniciar' });
  boton.textContent = 'Reiniciar estadísticas';
  confirmarReinicio = 0;
});
setInterval(() => {
  if (panelActual === 'analisis') pintarActividad();
}, 60000);

$('#pin').value = leerSesion('pin-caneca') || '';
mostrarPanel(location.hash.slice(1) || 'vivo', { subir: false });
pintarControl();
pintarConexion();
conectar();
